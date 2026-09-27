-- ============================================================================
-- Atlas — graded deletion of ingested files and archives
--
-- Admins (owner/admin/manager) must be able to remove uploaded ingestion data
-- at different DEPTHS, individually (a single file) or for a whole upload (the
-- zip/archive), choosing the depth deliberately:
--
--   single file:  'knowledge'           → Atlas document + chunks only
--                 'knowledge_and_file'  → + the stored original bytes
--
--   archive:      'knowledge'           → every document it produced
--                 'knowledge_and_files' → + every stored member file
--                 'everything'          → + the import record and inventory
--
-- WHY THIS IS SAFE
--   * Both RPCs derive the caller from auth.uid() and scope every read/write to
--     public.my_tenant_id(), exactly like the existing archive_* /
--     documents_delete_document RPCs. Role is asserted in-body.
--   * The ORIGINAL BYTES live in Supabase Storage and are removed by the
--     client through the Storage API (deleting a storage row in SQL would
--     orphan the backing object); the RPC returns the exact paths to remove.
--   * Entities and assertions (shared knowledge graph) and claim records are
--     intentionally NOT deleted — removing one source document must not erase
--     shared knowledge or a claim's history.
--   * Every deletion is audited (log_audit).
--
-- Do NOT duplicate documents_delete_document / archive_delete: those remain
-- the plain, non-graded paths; these add the depth + storage coordination that
-- they never had. Additive and idempotent (create or replace).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Delete one ingested archive file to a chosen depth
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
  v_tenant uuid := public.my_tenant_id();
  v_file public.archiveFiles;
  v_storage text;
  v_docs int := 0;
begin
  if v_user is null or v_tenant is null then
    raise exception 'You must be signed in and belong to a workspace.';
  end if;
  if public.my_member_role() not in ('owner', 'admin', 'manager') then
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
  update public.archiveFiles
  set "documentId" = null,
      "ingestStatus" = 'deleted',
      error = null,
      "errorStage" = null
  where _id = p_fileId;

  perform public.log_audit('archive_file_deleted', 'archiveFiles', p_fileId::text,
    jsonb_build_object(
      'scope', p_scope,
      'path', v_file.path,
      'documents_deleted', v_docs,
      'storage_removed', v_storage is not null
    ));

  return jsonb_build_object(
    'ok', true,
    'documentsDeleted', v_docs,
    'storagePath', v_storage
  );
end;
$$;

-- Anonymous callers must not even be able to reach these: `auth.uid()` is
-- NULL for an anon key, so they fail closed already, but the hardened posture
-- (20260918) revokes PUBLIC/anon rather than relying on the in-body guard.
revoke execute on function public.ingestion_delete_archive_file(uuid, text) from public, anon;
grant execute on function public.ingestion_delete_archive_file(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Delete an ingested archive to a chosen depth
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
  v_tenant uuid := public.my_tenant_id();
  v_archive public.archiveIngestions;
  v_doc_ids uuid[];
  v_storage text[];
  v_docs int := 0;
  v_files int := 0;
begin
  if v_user is null or v_tenant is null then
    raise exception 'You must be signed in and belong to a workspace.';
  end if;
  if public.my_member_role() not in ('owner', 'admin', 'manager') then
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

  perform public.log_audit('archive_deleted', 'archiveIngestions', p_archiveId::text,
    jsonb_build_object(
      'scope', p_scope,
      'filename', v_archive.filename,
      'documents_deleted', v_docs,
      'files', v_files,
      'storage_removed', p_scope <> 'knowledge'
    ));

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
