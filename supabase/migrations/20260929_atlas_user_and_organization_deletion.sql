-- ============================================================================
-- Atlas — deleting users and organizations
--
-- THE BUG BEING FIXED
--
-- Deleting a user fails, everywhere, for one reason: the schema refuses it.
-- `public.profiles._id` cascades from `auth.users`, so removing the auth row
-- starts a cascade that is aborted by the first NO ACTION foreign key that
-- still points at the user. Live catalog (2026-09-29, project
-- ibxvzxblyhzwokljkslt) counted:
--
--   * 9 columns in 7 tables referencing auth.users with NO ACTION
--       (atlas_audit_log.actor_id, atlas_human_reviews.reviewer_user_id,
--        atlas_regulatory_acquisition_jobs.requested_by,
--        atlas_regulatory_contradictions.resolved_by,
--        atlas_regulatory_review_queue.reviewer_id,
--        governance_decisions.approved_by, governance_decisions.override_by,
--        user_provisions.provisioned_by, user_provisions.provisioned_user)
--   * 14 columns referencing public.profiles with NO ACTION
--       (archiveingestions.uploadedBy, auditlogs.actorId,
--        claimsupplements.createdBy, documents.uploadedBy,
--        impactassessments.decidedBy, insuranceclaims.createdBy,
--        invites.invitedBy, memberships.invitedBy, notifications.recipientId,
--        recommendations.decidedBy, tenantpacks.activatedBy,
--        toolactions.actorId, toolactions.confirmedBy,
--        workflowapprovals.decidedBy)
--
-- 23 in total, counted from the live catalog.
--
-- That breaks THREE entry points, not one:
--   1. deleting the user from the Supabase dashboard  → FK violation;
--   2. the Admin API `auth.admin.deleteUser` path     → same FK violation;
--   3. the Super Admin `delete_user` action          → the cleanup has to
--      null every reference by hand first, and any column the deployed
--      function does not know about still aborts the cascade.
--
-- THE FIX
--
-- Every one of those columns is ATTRIBUTION: "who did this". The row it
-- points at belongs to an organization, not to the user. This migration
-- changes the blocking rules to `on delete set null` so the user row
-- disappears and the organization's rows survive with the attribution
-- cleared — the exact retention posture `user-deletion.ts` already
-- implements by hand, and the one the codebase documents as intended
-- ("Organization-owned rows are PRESERVED: their profile references are
-- set to NULL (history retained)").
--
-- Two of the columns are NOT NULL and cannot accept NULL:
--   invites.invitedBy            — "who sent the invitation"
--   user_provisions.provisioned_by — "who provisioned the account"
-- Both are pure attribution, so NOT NULL is relaxed here. No existing row
-- changes, and no code path that writes these columns changes behaviour.
--
-- After this, deletion works identically from the dashboard, the Admin API
-- and the Super Admin UI, and the Super Admin handler no longer has to
-- guess which naming era the database uses.
--
-- ORGANIZATION DELETION
--
-- There was no way to delete an organization at all. `admin_delete_tenant`
-- does not exist in any migration, and `archive_delete` deletes an
-- ingestion, never a tenant. 61 foreign keys already CASCADE from
-- `public.tenants`; exactly one did not (`user_provisions.tenant_id`), and
-- four billing tables SET NULL (so the money record survives, which is
-- required for revenue reporting).
--
-- `admin_delete_organization` closes that gap. It is super-admin only,
-- audited, refuses while Stripe still charges the organization, and
-- returns the storage paths and member ids that only a server can act on.
-- It is additive and idempotent (create or replace). No row is deleted by
-- this migration; every deletion happens when a super admin calls it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Relax NOT NULL on the two attribution columns that block deletion
-- ---------------------------------------------------------------------------
-- `drop not null` is inherently idempotent.
alter table public.invites alter column "invitedBy" drop not null;
alter table public.user_provisions alter column provisioned_by drop not null;

comment on column public.invites."invitedBy" is
  'Who sent the invitation. Nullable so a deleted user does not block invitation cleanup; the invitation itself is preserved.';
comment on column public.user_provisions.provisioned_by is
  'Who provisioned the account. Nullable so a deleted user does not block account cleanup.';

-- ---------------------------------------------------------------------------
-- 2. Make every user reference non-blocking
-- ---------------------------------------------------------------------------
-- Drop and re-add each blocking FK as `on delete set null`.
--
-- The definition is read from the catalog rather than rebuilt by hand, so a
-- multi-column or oddly named FK is reproduced exactly, and only the delete
-- rule changes. The ON DELETE clause is stripped whether or not Postgres
-- printed it explicitly (it is omitted when it is the default).
--
-- `pg_get_constraintdef` output is trusted catalog text, and every value is
-- passed through format() %I / a plain identifier join, so nothing here can
-- be used for SQL injection by a caller.
do $$
declare
  r record;
  v_def text;
begin
  for r in
    select
      c.conname,
      c.conrelid::regclass::text as source_table,
      pg_get_constraintdef(c.oid) as definition
    from pg_constraint c
    where c.contype = 'f'
      and c.confrelid in ('auth.users'::regclass, 'public.profiles'::regclass)
      and c.confdeltype in ('a', 'r')
  loop
    v_def := regexp_replace(
      r.definition,
      '\s+on delete (no action|restrict)',
      '',
      'i'
    );

    execute format('alter table %s drop constraint %I', r.source_table, r.conname);
    execute format(
      'alter table %s add constraint %I %s on delete set null',
      r.source_table,
      r.conname,
      v_def
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. admin_delete_organization
-- ---------------------------------------------------------------------------
-- Super-admin-only, audited, fail-closed on live billing.
--
-- Deferral: a single `delete from tenants` cannot fire while four billing
-- tables still point at the row, so the audit entry is written first and
-- the billing history is retained with `organization_id` set to NULL by the
-- existing SET NULL rules (revenue records are never deleted here).
-- p_actor_id exists because the trusted-server caller (the Edge Function) has
-- no auth.uid() of its own. It is only ever honoured when auth.uid() is null,
-- i.e. on the service-role path, so a signed-in super admin cannot spoof it.
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

  select coalesce(array_agg(distinct u), '{}'::uuid[]) into v_user_ids
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
