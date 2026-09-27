-- ---------------------------------------------------------------------------
-- 20260931 — Fix runtime failure in admin_delete_organization
--
-- BUG
--   20260929 defined the member-id snapshot as:
--       select coalesce(array_agg(distinct u), '{}'::uuid[]) into v_user_ids
--       from public.memberships m
--       where m."tenantId" = p_tenant_id and m."userId" is not null;
--
--   `u` is not a column of public.memberships and not a PL/pgSQL variable, so
--   the expression is only resolved at execution time. CREATE FUNCTION with
--   check_function_bodies does not validate bare column references inside a
--   plpgsql statement, so the function was created successfully, recorded in
--   the migration ledger, and passed schema/privilege verification — but it
--   raised on every single call:
--
--       ERROR: column "u" does not exist
--       CONTEXT: PL/pgSQL function admin_delete_organization(...) line 50
--
--   Net effect: the production organization-deletion path was completely dead.
--   No organization could ever be deleted, by any caller.
--
-- FIX
--   Reference the real column: array_agg(distinct m."userId").
--
--   This is the ONLY change. The function is otherwise byte-identical to the
--   20260929 definition: same signature, same SECURITY DEFINER, same
--   search_path, same super_admin/trusted-server gate, same live-subscription
--   refusal, same audit-before-delete ordering, same user_provisions cleanup,
--   same return payload. Access control is not widened.
--
--   20260929 is already applied to production and is recorded in the ledger,
--   so it is not edited in place there; this migration re-creates the function.
--   The corrected expression is ALSO fixed at source in 20260929 so a fresh
--   database built from the repository never contains the broken version.
-- ---------------------------------------------------------------------------

create or replace function public.admin_delete_organization(
  p_tenant_id uuid,
  p_reason text,
  p_delete_users boolean default false,
  p_billing_cancelled boolean default false,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant record;
  v_storage text[] := '{}';
  v_user_ids uuid[] := '{}';
  v_members int := 0;
  v_documents int := 0;
  v_archives int := 0;
  v_live_status text;
  v_actor uuid;
  v_trusted boolean;
begin
  v_trusted := public.atlas_is_trusted_server();
  v_actor := coalesce(auth.uid(), p_actor_id);

  if not (public.is_super_admin() or v_trusted) then
    raise exception 'Access denied: super_admin required';
  end if;

  if p_tenant_id is null then
    raise exception 'Organization id is required.';
  end if;

  select * into v_tenant from public.tenants where _id = p_tenant_id;
  if not found then
    raise exception 'Organization not found.';
  end if;

  -- Never delete an organization that is still being charged for. The Stripe
  -- cancellation is performed by the Edge Function, which is the only caller
  -- allowed to assert it happened: a browser super_admin cannot clear this
  -- gate, so nobody can orphan a paying customer from a deleted tenant.
  select s.status into v_live_status
  from public.subscriptions s
  where s.tenant_id = p_tenant_id
    and s.status in ('active', 'trialing', 'past_due', 'unpaid', 'incomplete')
  order by s.status
  limit 1;

  if v_live_status is not null and not (p_billing_cancelled and v_trusted) then
    raise exception
      'This organization still has a live subscription (%). Cancel it in Stripe first, then delete the organization.',
      v_live_status;
  end if;

  -- Snapshot everything the caller cannot act on itself.
  select count(*) into v_members
  from public.memberships m where m."tenantId" = p_tenant_id;

  -- FIXED: `m."userId"` (was `u`, which does not exist).
  select coalesce(array_agg(distinct m."userId"), '{}'::uuid[]) into v_user_ids
  from public.memberships m
  where m."tenantId" = p_tenant_id and m."userId" is not null;

  select count(*) into v_archives
  from public.archiveingestions a where a."tenantId" = p_tenant_id;

  select count(*) into v_documents
  from public.documents d where d."tenantId" = p_tenant_id;

  -- Original bytes live in Supabase Storage; deleting the rows would orphan
  -- the objects. Collect every path so the Edge Function can remove them
  -- with the Storage API. This mirrors ingestion_delete_archive.
  select array_agg(distinct s) into v_storage
  from (
    select d."storageId" as s
    from public.documents d
    where d."tenantId" = p_tenant_id and d."storageId" is not null
    union all
    select f."storageId"
    from public.archivefiles f
    where f."tenantId" = p_tenant_id and f."storageId" is not null
    union all
    select a."rawStorageId"
    from public.archiveingestions a
    where a."tenantId" = p_tenant_id and a."rawStorageId" is not null
  ) paths
  where paths.s is not null;

  -- Audit BEFORE the delete. atlas_audit_log has no tenant foreign key, so
  -- the record survives the organization and remains attributable afterwards.
  insert into public.atlas_audit_log (
    actor_id, actor_email, action, target_type, target_id, details
  ) values (
    v_actor,
    (select email from public.profiles where _id = v_actor),
    'organization_deleted',
    'organization',
    p_tenant_id,
    jsonb_build_object(
      'name', v_tenant.name,
      'slug', v_tenant.slug,
      'account_type', v_tenant.account_type,
      'reason', nullif(btrim(coalesce(p_reason, '')), ''),
      'delete_users', coalesce(p_delete_users, false),
      'members', v_members,
      'documents', v_documents,
      'archives', v_archives,
      'storage_objects', coalesce(array_length(v_storage, 1), 0),
      'billing_cancelled', coalesce(p_billing_cancelled, false),
      'actor_id', v_actor,
      'member_user_ids', to_jsonb(v_user_ids)
    )
  );

  -- user_provisions.tenant_id is the only tenant reference that does not
  -- cascade and the only one that is NOT NULL, so it must be cleared here.
  delete from public.user_provisions where tenant_id = p_tenant_id;

  -- Everything else cascades from tenants (61 foreign keys, verified in the
  -- live catalog). billing_audit_events, processed_webhook_events,
  -- stripe_customers and subscriptions are SET NULL and therefore retained.
  delete from public.tenants where _id = p_tenant_id;

  return jsonb_build_object(
    'ok', true,
    'tenant_id', p_tenant_id,
    'name', v_tenant.name,
    'members', v_members,
    'documents', v_documents,
    'archives', v_archives,
    'storage_paths', coalesce(to_jsonb(v_storage), '[]'::jsonb),
    'member_user_ids', to_jsonb(v_user_ids),
    'delete_users', coalesce(p_delete_users, false)
  );
end;
$$;

revoke execute on function public.admin_delete_organization(uuid, text, boolean, boolean, uuid) from public, anon;
grant execute on function public.admin_delete_organization(uuid, text, boolean, boolean, uuid) to authenticated, service_role;
