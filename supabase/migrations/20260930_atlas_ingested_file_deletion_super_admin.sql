-- ============================================================================
-- Atlas — platform super_admin may delete ingested files
--
-- WHAT CHANGES
--
-- 20260928 added graded deletion of uploaded ingestion data, gated on
-- `my_member_role() in ('owner','admin','manager')`. Those org roles are
-- UNCHANGED and keep working exactly as before.
--
-- What was missing is the platform operator. A `super_admin` is authorized
-- across the whole product — they can already list every organization, create
-- and convert pilots, and (as of 20260929) delete an organization outright —
-- but they could not delete an ingested file in an organization they are not
-- a member of, because the RPC resolved the tenant exclusively through
-- `public.my_tenant_id()`, which is NULL for a non-member. The RPC therefore
-- answered "You must be signed in and belong to a workspace." to the one
-- person who is authorized to act on any workspace.
--
-- This migration adds that path, and nothing else:
--
--   1. Both RPCs accept a platform `super_admin` in addition to the existing
--      org roles. For a super admin the organization is resolved FROM THE
--      TARGET ROW instead of from a membership, and every subsequent read and
--      write is scoped to that resolved organization exactly as before.
--   2. The `documents_storage_delete` policy gains the same allowance.
--      Without this the RPC would succeed while the browser's
--      `storage.remove()` silently did nothing, because that policy also
--      scopes by `my_tenant_id()`. The rows would be gone and the bytes would
--      remain — a partial deletion reported as a success. The blast radius is
--      deliberately limited to the `documents` and `archives` buckets (where
--      ingested files live); the `email-attachments` bucket keeps its own
--      policy and is untouched.
--   3. THE AUDIT HOLE THIS ALSO CLOSES. Both RPCs recorded their deletion
--      through `public.log_audit()`, which begins:
--
--          declare v_tenant uuid := public.my_tenant_id();
--          if v_tenant is null then return; end if;
--
--      `my_tenant_id()` is NULL for exactly the platform super_admin this
--      migration is adding, so their deletion returned from log_audit WITHOUT
--      WRITING ANYTHING. Verified live against project ibxvzxblyhzwokljkslt:
--      a super-admin deletion of a cross-organization file succeeded and left
--      `auditLogs` untouched. A cross-organization destructive action was
--      completely unaudited.
--
--      `public.auditLogs` has RLS ENABLED AND NO POLICIES AT ALL, so the
--      SECURITY INVOKER RPCs cannot insert into it directly — which is why
--      `log_audit` is SECURITY DEFINER in the first place. The fix is
--      `ingestion_write_audit` below: a narrow SECURITY DEFINER helper that
--      takes the organization explicitly and authorizes it in-body, so the
--      super-admin branch is auditable without widening anything.
--
--      For ordinary members the recorded values are byte-for-byte what
--      `log_audit` wrote before (same tenant, same actor, same actorType), so
--      no existing audit consumer changes behaviour.
--
-- THE INVARIANT THAT MATTERS
--
-- A non-super-admin caller is still scoped by their own membership: the
-- organization is taken from `my_tenant_id()` and never from the request, and
-- a file belonging to any other organization still fails the same
-- "Archive file not found." check it did before. The super-admin branch adds a
-- second way to be authorized; it does not remove the first.
--
-- Additive and idempotent (create or replace, drop/create policy). No row is
-- deleted or modified by this migration.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. ingestion_write_audit — a guarded audit insert
-- ---------------------------------------------------------------------------
-- Replaces `log_audit()` for the two deletion paths, because log_audit cannot
-- record a cross-organization deletion at all (it returns early when
-- my_tenant_id() is NULL, which is the super-admin case).
--
-- SECURITY INVOKER RPCs cannot write to public.auditLogs directly: RLS is
-- enabled on that table and it has NO policies, so every direct insert is
-- denied. This helper is therefore SECURITY DEFINER, and because that makes it
-- a privileged write it authorizes itself, twice:
--
--   * the actor must be auth.uid(), so a caller cannot forge another user's
--     attribution; and
--   * the organization must be the caller's own workspace, unless the caller
--     is a platform super_admin, so a caller cannot write an audit row for an
--     organization they do not act for.
--
-- Everything it accepts is therefore bounded by the caller's own authority.
create or replace function public.ingestion_write_audit(
  p_tenant uuid,
  p_actor uuid,
  p_actor_type text,
  p_action text,
  p_target_type text,
  p_target_id text,
  p_metadata jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_tenant is null or p_actor is null then
    raise exception 'Audit context is incomplete.';
  end if;
  if p_actor <> auth.uid() then
    raise exception 'Audit actor must be the signed-in caller.';
  end if;
  if not (p_tenant = public.my_tenant_id() or public.is_super_admin()) then
    raise exception 'Access denied: cannot record an audit entry for another organization.';
  end if;

  insert into public.auditlogs (
    "tenantId", "actorType", "actorId", "actionType", "targetType", "targetId", "metadata"
  ) values (
    p_tenant, p_actor_type, p_actor, p_action, p_target_type, p_target_id, p_metadata
  );
end;
$$;

revoke execute on function public.ingestion_write_audit(uuid, uuid, text, text, text, text, jsonb) from public, anon;
grant execute on function public.ingestion_write_audit(uuid, uuid, text, text, text, text, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. ingestion_delete_archive_file — allow a platform super_admin
-- ---------------------------------------------------------------------------
create or replace function public.ingestion_delete_archive_file(
  p_fileId uuid,
  p_scope text
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_super boolean := false;
  v_tenant uuid;
  v_file public.archiveFiles;
  v_storage text;
  v_docs int := 0;
begin
  if v_user is null then
    raise exception 'You must be signed in to delete ingested files.';
  end if;

  v_super := public.is_super_admin();

  -- A platform super admin is not a member of every organization, so
  -- my_tenant_id() is NULL for them. Resolve the organization from the target
  -- row instead. Everyone else is scoped by their own membership, exactly as
  -- before, and the organization is never taken from the request.
  if v_super then
    select f."tenantId" into v_tenant
    from public.archiveFiles f
    where f._id = p_fileId;
  else
    v_tenant := public.my_tenant_id();
  end if;

  if v_tenant is null then
    raise exception 'You must be signed in and belong to a workspace.';
  end if;

  if not v_super and public.my_member_role() not in ('owner', 'admin', 'manager') then
    raise exception 'Only managers and above can delete ingested files.';
  end if;

  if p_scope not in ('knowledge', 'knowledge_and_file') then
    raise exception 'Invalid deletion depth: %', p_scope;
  end if;

  select * into v_file from public.archiveFiles f
  where f._id = p_fileId and f."tenantId" = v_tenant;
  if v_file._id is null then raise exception 'Archive file not found.'; end if;

  if v_file."documentId" is not null then
    delete from public.documentChunks c
    where c."documentId" = v_file."documentId";
    delete from public.documents d
    where d._id = v_file."documentId" and d."tenantId" = v_tenant;
    v_docs := 1;
  end if;

  v_storage := case when p_scope = 'knowledge_and_file' then v_file."storageId" else null end;

  -- Unlink the document and mark the file deleted so a later processing pass
  -- cannot silently re-ingest content the operator deliberately removed.
  -- Scoped to the resolved organization, not just the id.
  update public.archiveFiles
  set "documentId" = null,
      "ingestStatus" = 'deleted',
      error = null,
      "errorStage" = null
  where _id = p_fileId and "tenantId" = v_tenant;

  perform public.ingestion_write_audit(
    v_tenant,
    v_user,
    case when v_super then 'super_admin' else 'user' end,
    'archive_file_deleted',
    'archiveFiles',
    p_fileId::text,
    jsonb_build_object(
      'scope', p_scope,
      'path', v_file.path,
      'documents_deleted', v_docs,
      'storage_removed', v_storage is not null,
      'by_super_admin', v_super
    )
  );

  return jsonb_build_object(
    'ok', true,
    'documentsDeleted', v_docs,
    'storagePath', v_storage
  );
end;
$$;

revoke execute on function public.ingestion_delete_archive_file(uuid, text) from public, anon;
grant execute on function public.ingestion_delete_archive_file(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. ingestion_delete_archive — allow a platform super_admin
-- ---------------------------------------------------------------------------
create or replace function public.ingestion_delete_archive(
  p_archiveId uuid,
  p_scope text
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_super boolean := false;
  v_tenant uuid;
  v_archive public.archiveIngestions;
  v_doc_ids uuid[];
  v_storage text[];
  v_docs int := 0;
  v_files int := 0;
begin
  if v_user is null then
    raise exception 'You must be signed in to delete an import.';
  end if;

  v_super := public.is_super_admin();

  -- Same rule as the per-file path: a super admin resolves the organization
  -- from the target row, everyone else from their own membership.
  if v_super then
    select a."tenantId" into v_tenant
    from public.archiveIngestions a
    where a._id = p_archiveId;
  else
    v_tenant := public.my_tenant_id();
  end if;

  if v_tenant is null then
    raise exception 'You must be signed in and belong to a workspace.';
  end if;

  if not v_super and public.my_member_role() not in ('owner', 'admin', 'manager') then
    raise exception 'Only managers and above can delete an import.';
  end if;

  if p_scope not in ('knowledge', 'knowledge_and_files', 'everything') then
    raise exception 'Invalid deletion depth: %', p_scope;
  end if;

  select * into v_archive from public.archiveIngestions a
  where a._id = p_archiveId and a."tenantId" = v_tenant;
  if v_archive._id is null then raise exception 'Archive not found.'; end if;

  -- Collect this archive's documents and stored files (tenant-scoped).
  select coalesce(array_agg(distinct f."documentId"), '{}'::uuid[]) into v_doc_ids
  from public.archiveFiles f
  where f."archiveId" = p_archiveId and f."tenantId" = v_tenant
    and f."documentId" is not null;

  select coalesce(array_agg(distinct f."storageId"), '{}'::text[]) into v_storage
  from public.archiveFiles f
  where f."archiveId" = p_archiveId and f."tenantId" = v_tenant
    and f."storageId" is not null;

  select count(*) into v_files from public.archiveFiles f
  where f."archiveId" = p_archiveId and f."tenantId" = v_tenant;

  if array_length(v_doc_ids, 1) is not null then
    delete from public.documentChunks where "documentId" = any (v_doc_ids);
    delete from public.documents
    where _id = any (v_doc_ids) and "tenantId" = v_tenant;
    get diagnostics v_docs = row_count;
  end if;

  if p_scope = 'everything' then
    delete from public.archiveFiles
    where "archiveId" = p_archiveId and "tenantId" = v_tenant;
    delete from public.archiveIngestions
    where _id = p_archiveId and "tenantId" = v_tenant;
  else
    -- Keep the import record but mark every file deleted and unlinked.
    update public.archiveFiles
    set "documentId" = null,
        "ingestStatus" = 'deleted',
        error = null,
        "errorStage" = null
    where "archiveId" = p_archiveId and "tenantId" = v_tenant;
  end if;

  perform public.ingestion_write_audit(
    v_tenant,
    v_user,
    case when v_super then 'super_admin' else 'user' end,
    'archive_deleted',
    'archiveIngestions',
    p_archiveId::text,
    jsonb_build_object(
      'scope', p_scope,
      'filename', v_archive.filename,
      'documents_deleted', v_docs,
      'files', v_files,
      'storage_removed', p_scope <> 'knowledge',
      'by_super_admin', v_super
    )
  );

  return jsonb_build_object(
    'ok', true,
    'documentsDeleted', v_docs,
    'files', v_files,
    'storagePaths', case when p_scope = 'knowledge' then '[]'::jsonb else to_jsonb(v_storage) end,
    'archiveDeleted', p_scope = 'everything'
  );
end;
$$;

revoke execute on function public.ingestion_delete_archive(uuid, text) from public, anon;
grant execute on function public.ingestion_delete_archive(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Storage — let a super admin actually remove the bytes
-- ---------------------------------------------------------------------------
-- The RPC above returns the storage path and the CLIENT removes the object
-- through the Storage API. `documents_storage_delete` scoped that by
-- `my_tenant_id()`, which is NULL for a non-member super admin, so the object
-- would have survived a "successful" deletion. Same allowance as the RPC.
--
-- Scope stays deliberately narrow: only the `documents` and `archives`
-- buckets, which is where ingested files live. `email-attachments` keeps its
-- own separate policy and is NOT widened by this migration.
drop policy if exists documents_storage_delete on storage.objects;

create policy documents_storage_delete
on storage.objects
for delete
to public
using (
  (bucket_id = 'documents'::text or bucket_id = 'archives'::text)
  and (
    public.is_super_admin()
    or (storage.foldername(name))[1] = public.my_tenant_id()::text
  )
);
