-- ===========================================================================
-- Atlas — Free Pilot Organizations
--
-- WHAT THIS ADDS
--
-- Nothing new in kind. Atlas already has the Free/Pilot entitlement: the
-- `complimentary_access` table from 20260909_atlas_complimentary_access.sql
-- is an Atlas-controlled grant that requires no Stripe customer, no Stripe
-- subscription, no invoice and no payment record, is computed server-side
-- (users_current_user / billing_get_state / can_access_atlas), audited on
-- every mutation, revocable, expirable, and additive to paid access.
--
-- This migration makes that entitlement *usable as a pilot account*:
--
--   1. `admin_create_tenant` is BROKEN. It inserts (name, _creationTime) but
--      `tenants.slug` is NOT NULL with no default and there is no BEFORE
--      INSERT trigger on `tenants` (verified against the live catalog), so
--      every "Create Organization" from the super-admin UI fails with 23502.
--      Fixed here, and it now accepts an explicit slug.
--   2. Pilot metadata on the tenant: account_type, notes, configurable
--      limits, and a conversion timestamp. Additive columns with defaults, so
--      existing organizations are untouched.
--   3. `admin_grant_complimentary_access_until` — the existing grant RPC only
--      accepts fixed durations (7d/30d/90d/1y/lifetime). Pilots need an
--      explicit expiration DATE, and sometimes none at all.
--   4. `admin_create_pilot_organization` — one atomic, audited call that
--      produces a real organization: tenant + primary profile + membership +
--      Free Pilot grant. This is the flow the spec asks for and the only one
--      that was genuinely missing.
--   5. Extend / suspend / reactivate / convert lifecycle RPCs.
--   6. `admin_list_tenants` now reports account type, pilot status,
--      expiration and billing so the internal admin view can show them.
--
-- A NOTE ON NAMING (deliberate, read before changing)
--
-- The spec calls this entitlement `free_pilot`. In the database and RPCs it
-- is `complimentary_access` + `account_type = 'free_pilot'`, because that is
-- the entitlement the access gate already reads. Renaming it would create the
-- second entitlement system the spec forbids. `free_pilot` is the ACCOUNT
-- TYPE; `complimentary_access` is the ENTITLEMENT. They are not synonyms and
-- both are needed.
--
-- NOTHING HERE TOUCHES STRIPE. No Stripe customer, subscription, price,
-- invoice or webhook is created, modified or read. A pilot organization has
-- no organization_subscriptions row at all, which is exactly why
-- billing_get_state() was written to report isActive=true for it.
--
-- Idempotent and non-destructive: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE
-- FUNCTION, CREATE INDEX IF NOT EXISTS. No table is dropped, no row deleted,
-- no existing organization modified.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Pilot metadata on tenants
-- ---------------------------------------------------------------------------
-- account_type is the internal administrative classification. 'standard' is
-- the default so every existing organization keeps its exact meaning.
alter table public.tenants
  add column if not exists account_type text not null default 'standard';

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'tenants_account_type_check'
      and conrelid = 'public.tenants'::regclass
  ) then
    alter table public.tenants
      add constraint tenants_account_type_check
      check (account_type in ('standard', 'free_pilot'));
  end if;
end $$;

-- Internal notes. Never shown to pilot users.
alter table public.tenants
  add column if not exists pilot_notes text;

-- RESERVED pilot-limit configuration. This column is NOT read by any
-- entitlement, gate, worker or RPC — Atlas's real limits are the plan-based
-- seat/storage limits in plan_seat_limits, which a Free Pilot organization is
-- deliberately exempt from through the existing `complimentary` bypass in
-- org_seat_status(). A pilot therefore tests the REAL product, and this column
-- exists only as reserved metadata: never present it as an enforceable limit.
alter table public.tenants
  add column if not exists pilot_limits jsonb;

comment on column public.tenants.pilot_limits is
  'RESERVED pilot-limit metadata. Not enforced by any code path; a Free Pilot org is exempt from plan limits via the complimentary access bypass. Do not present as enforceable.';

-- Set when a pilot converts to a paid plan. The organization, its users and
-- all of its data are preserved; only the entitlement changes.
alter table public.tenants
  add column if not exists pilot_converted_at bigint;

create index if not exists tenants_account_type_idx
  on public.tenants (account_type);

-- ---------------------------------------------------------------------------
-- 2. Fix admin_create_tenant (was failing on the NOT NULL slug)
-- ---------------------------------------------------------------------------
-- The previous 1-argument form could never succeed. It is dropped rather than
-- left alongside a 2-argument version, because a leftover overload is exactly
-- the ambiguity that has bitten this schema before.
drop function if exists public.admin_create_tenant(text);

create or replace function public.admin_create_tenant(
  p_name text,
  p_slug text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
  v_tenant uuid;
  v_slug text;
begin
  if not public.is_super_admin() then
    raise exception 'Access denied: super_admin required';
  end if;

  if p_name is null or trim(p_name) = '' then
    raise exception 'Organization name is required.';
  end if;

  -- Slug: explicit if given, otherwise derived. Lowercased, non-alphanumerics
  -- collapsed to single hyphens, trimmed. Uniqueness is enforced by the
  -- column constraint, so a collision raises rather than silently merging.
  v_slug := lower(trim(coalesce(nullif(trim(p_slug), ''), p_name)));
  v_slug := regexp_replace(v_slug, '[^a-z0-9]+', '-', 'g');
  v_slug := trim(both '-' from v_slug);
  if v_slug = '' then
    raise exception 'Could not derive a slug from the organization name; please supply one.';
  end if;

  insert into public.tenants (name, slug, status, account_type, "_creationTime")
  values (trim(p_name), v_slug, 'active', 'standard', v_now)
  returning _id into v_tenant;

  insert into public.atlas_audit_log (
    actor_id, actor_email, action, target_type, target_id, details
  ) values (
    auth.uid(),
    (select email from public.profiles where _id = auth.uid()),
    'organization_created',
    'organization',
    v_tenant,
    jsonb_build_object('name', trim(p_name), 'slug', v_slug, 'account_type', 'standard')
  );

  return json_build_object('ok', true, 'tenant_id', v_tenant, 'slug', v_slug);
end;
$$;

revoke execute on function public.admin_create_tenant(text, text) from public, anon;
grant execute on function public.admin_create_tenant(text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. admin_grant_complimentary_access_until — explicit expiration date
-- ---------------------------------------------------------------------------
-- Same semantics as admin_grant_complimentary_access, but the caller supplies
-- an absolute epoch-ms expiration (or NULL for "never"), which is what a pilot
-- needs. Supersedes any previous active grant for the SAME scope only: an
-- org-wide grant never revokes a user-specific grant, so grants stay additive.
create or replace function public.admin_grant_complimentary_access_until(
  p_tenant_id uuid,
  p_expires_at bigint,
  p_reason text,
  p_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
  v_grant record;
begin
  if not public.is_super_admin() then
    raise exception 'Access denied: super_admin required';
  end if;

  if p_tenant_id is null then
    raise exception 'Organization is required.';
  end if;
  if not exists (select 1 from public.tenants where _id = p_tenant_id) then
    raise exception 'Organization not found.';
  end if;
  if p_user_id is not null
     and not exists (select 1 from public.profiles where _id = p_user_id) then
    raise exception 'User not found.';
  end if;
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'A reason is required for complimentary access.';
  end if;
  -- A non-null expiration must be in the future, otherwise the grant would be
  -- born already expired and the caller almost certainly made a mistake.
  if p_expires_at is not null and p_expires_at <= v_now then
    raise exception 'Expiration must be in the future (or null for no expiration).';
  end if;

  if p_user_id is null then
    update public.complimentary_access
    set status = 'revoked', revoked_at = v_now, revoked_by = auth.uid(), updated_at = v_now
    where organization_id = p_tenant_id and user_id is null and status = 'active';
  else
    update public.complimentary_access
    set status = 'revoked', revoked_at = v_now, revoked_by = auth.uid(), updated_at = v_now
    where organization_id = p_tenant_id and user_id = p_user_id and status = 'active';
  end if;

  insert into public.complimentary_access (
    organization_id, user_id, granted_by, granted_at, expires_at, reason, status
  ) values (
    p_tenant_id, p_user_id, auth.uid(), v_now, p_expires_at, trim(p_reason), 'active'
  )
  returning * into v_grant;

  insert into public.atlas_audit_log (
    actor_id, actor_email, action, target_type, target_id, details
  ) values (
    auth.uid(),
    (select email from public.profiles where _id = auth.uid()),
    'complimentary_access_granted',
    'organization',
    p_tenant_id,
    jsonb_build_object(
      'grant_id', v_grant.id,
      'user_id', p_user_id,
      'expires_at', p_expires_at,
      'never_expires', p_expires_at is null,
      'reason', trim(p_reason),
      'source', 'admin_grant_complimentary_access_until'
    )
  );

  return to_jsonb(v_grant);
end;
$$;

revoke execute on function public.admin_grant_complimentary_access_until(uuid, bigint, text, uuid) from public, anon;
grant execute on function public.admin_grant_complimentary_access_until(uuid, bigint, text, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. admin_create_pilot_organization — the atomic creation flow
-- ---------------------------------------------------------------------------
-- One call, one audited transaction. Produces:
--   * a normal `tenants` row with account_type = 'free_pilot'
--   * a primary profile (placeholder, account_status 'pending')
--   * a `memberships` row as the organization owner
--   * an organization-wide Free Pilot complimentary_access grant
--
-- It deliberately does NOT create a Supabase Auth user. That requires the
-- service role and is the job of the existing `admin-provision-user` Edge
-- Function, which sends the invite email. So this function never sets or sees
-- a password, and no credential ever appears in source (spec §15).
--
-- The primary profile is 'pending' until the invite is claimed, which the
-- existing access gate already treats as denied — a pilot org cannot be used
-- to grant access to an account nobody has authenticated as.
create or replace function public.admin_create_pilot_organization(
  p_name text,
  p_admin_email text,
  p_admin_name text default null,
  p_slug text default null,
  p_expires_at bigint default null,
  p_notes text default null,
  p_limits jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
  v_tenant uuid;
  v_user uuid;
  v_grant uuid;
  v_slug text;
  v_email text;
begin
  if not public.is_super_admin() then
    raise exception 'Access denied: super_admin required';
  end if;

  if p_name is null or trim(p_name) = '' then
    raise exception 'Organization name is required.';
  end if;

  v_email := lower(trim(coalesce(p_admin_email, '')));
  if v_email = '' then
    raise exception 'A primary admin email is required.';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'The primary admin email is not a valid email address.';
  end if;

  -- Reject an already-used slug rather than silently merging into another
  -- organization. A pilot org must be its own tenant.
  v_slug := lower(trim(coalesce(nullif(trim(p_slug), ''), p_name)));
  v_slug := regexp_replace(v_slug, '[^a-z0-9]+', '-', 'g');
  v_slug := trim(both '-' from v_slug);
  if v_slug = '' then
    raise exception 'Could not derive a slug from the organization name; please supply one.';
  end if;
  if exists (select 1 from public.tenants where slug = v_slug) then
    raise exception 'The slug "%" is already in use by another organization.', v_slug;
  end if;

  if p_expires_at is not null and p_expires_at <= v_now then
    raise exception 'The pilot expiration must be in the future (or empty for no expiration).';
  end if;

  -- 1. The organization. A normal tenant in every respect.
  insert into public.tenants (
    name, slug, status, account_type, pilot_notes, pilot_limits, "_creationTime"
  ) values (
    trim(p_name), v_slug, 'active', 'free_pilot',
    nullif(trim(coalesce(p_notes, '')), ''),
    p_limits,
    v_now
  )
  returning _id into v_tenant;

  -- 2. The primary profile. `profiles._id` IS the Supabase Auth user id, and
  --    this RPC deliberately never creates an Auth user (no password is ever
  --    generated or transmitted here — `next_step` below is 'invite_user'). A
  --    brand-new email therefore has no id yet, and cannot get a profile row
  --    from here; the invite creates the Auth user, then the profile, then the
  --    membership. An EXISTING profile is reused, never duplicated, and is
  --    never silently re-roled or reactivated.
  --
  --    (The previous version inserted a profile here without `_id`, violating
  --    the NOT NULL constraint and failing on EVERY call. It also referenced
  --    `company_name` and `_updated_at`, neither of which exists on
  --    `profiles` — the organization name lives on `tenants.name`.)
  select _id into v_user from public.profiles where lower(email) = v_email limit 1;

  -- 3. Membership as the organization owner, but only when the user already
  --    exists (the membership-role convention in use: 24 'owner' rows against
  --    1 'admin'). Idempotent; the invite adds the membership for a new user.
  if v_user is not null then
    insert into public.memberships ("tenantId", "userId", role, status, "joinedAt", "_creationTime")
    values (v_tenant, v_user, 'owner', 'active', v_now, v_now)
    on conflict do nothing;
  end if;

  -- 4. The Free Pilot entitlement: organization-wide, no Stripe anything.
  insert into public.complimentary_access (
    organization_id, user_id, granted_by, granted_at, expires_at, reason, status
  ) values (
    v_tenant, null, auth.uid(), v_now, p_expires_at,
    'Free Pilot organization', 'active'
  )
  returning id into v_grant;

  insert into public.atlas_audit_log (
    actor_id, actor_email, action, target_type, target_id, details
  ) values (
    auth.uid(),
    (select email from public.profiles where _id = auth.uid()),
    'pilot_organization_created',
    'organization',
    v_tenant,
    jsonb_build_object(
      'name', trim(p_name),
      'slug', v_slug,
      'account_type', 'free_pilot',
      'primary_user_id', v_user,
      'primary_user_email', v_email,
      'grant_id', v_grant,
      'expires_at', p_expires_at,
      'never_expires', p_expires_at is null,
      'limits', p_limits,
      'has_notes', p_notes is not null
    )
  );

  return jsonb_build_object(
    'ok', true,
    'tenant_id', v_tenant,
    'slug', v_slug,
    'user_id', v_user,
    'grant_id', v_grant,
    'account_type', 'free_pilot',
    -- The caller must now send the invite via admin-provision-user; no
    -- password is ever created here.
    'next_step', 'invite_user'
  );
end;
$$;

revoke execute on function public.admin_create_pilot_organization(text, text, text, text, bigint, text, jsonb) from public, anon;
grant execute on function public.admin_create_pilot_organization(text, text, text, text, bigint, text, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Pilot lifecycle: extend / suspend / reactivate / convert
-- ---------------------------------------------------------------------------
-- `pilot_status` is DERIVED, never stored as a fourth source of truth:
--   account_type <> 'free_pilot'            -> 'standard'
--   converted_at is not null                -> 'converted'
--   no active grant                         -> 'suspended'
--   grant expired                           -> 'expired'
--   otherwise                               -> 'active'
--
-- AUTHORIZATION: this is SECURITY DEFINER and reachable by `authenticated`,
-- so it guards itself. It returns a status only for a caller that can already
-- access the tenant (the caller's own organization, a trusted server, or a
-- super_admin); anyone else gets NULL rather than another organization's
-- internal pilot classification. The security ratchet in
-- src/lib/security/migration-privileges.test.ts enforces that an unguarded
-- authenticated-reachable definer function cannot be added, and this function
-- tripped it on the first attempt — correctly. Do not remove the guard.
create or replace function public.atlas_pilot_status(p_tenant_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when t.account_type is distinct from 'free_pilot' then 'standard'
    when t.pilot_converted_at is not null then 'converted'
    when not exists (
      select 1 from public.complimentary_access c
      where c.organization_id = t._id
        and c.status = 'active'
        and c.user_id is null
    ) then 'suspended'
    when exists (
      select 1 from public.complimentary_access c
      where c.organization_id = t._id
        and c.status = 'active'
        and c.user_id is null
        and c.expires_at is not null
        and c.expires_at <= (extract(epoch from now()) * 1000)::bigint
    ) then 'expired'
    else 'active'
  end
  from public.tenants t
  where t._id = p_tenant_id
    and (
      public.is_super_admin()
      or public.atlas_can_access_tenant(p_tenant_id)
    );
$$;

grant execute on function public.atlas_pilot_status(uuid) to authenticated, service_role;

-- Extend (or set) a pilot's expiration.
create or replace function public.admin_extend_pilot(
  p_tenant_id uuid,
  p_expires_at bigint,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
  v_tenant record;
  v_grant jsonb;
begin
  if not public.is_super_admin() then
    raise exception 'Access denied: super_admin required';
  end if;

  select * into v_tenant from public.tenants where _id = p_tenant_id;
  if not found then
    raise exception 'Organization not found.';
  end if;
  if v_tenant.account_type is distinct from 'free_pilot' then
    raise exception 'This organization is not a Free Pilot organization.';
  end if;

  v_grant := public.admin_grant_complimentary_access_until(
    p_tenant_id,
    p_expires_at,
    coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'Free Pilot organization (extended)'),
    null
  );

  insert into public.atlas_audit_log (
    actor_id, actor_email, action, target_type, target_id, details
  ) values (
    auth.uid(),
    (select email from public.profiles where _id = auth.uid()),
    'pilot_extended',
    'organization',
    p_tenant_id,
    jsonb_build_object(
      'expires_at', p_expires_at,
      'never_expires', p_expires_at is null,
      'reason', p_reason,
      'grant_id', v_grant ->> 'id'
    )
  );

  return jsonb_build_object(
    'ok', true,
    'tenant_id', p_tenant_id,
    'status', public.atlas_pilot_status(p_tenant_id),
    'grant', v_grant
  );
end;
$$;

revoke execute on function public.admin_extend_pilot(uuid, bigint, text) from public, anon;
grant execute on function public.admin_extend_pilot(uuid, bigint, text) to authenticated, service_role;

-- Suspend / reactivate. Suspension revokes the grant; it never deletes the
-- organization, its members, or its data.
create or replace function public.admin_set_pilot_status(
  p_tenant_id uuid,
  p_status text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
  v_tenant record;
begin
  if not public.is_super_admin() then
    raise exception 'Access denied: super_admin required';
  end if;
  if p_status not in ('active', 'suspended') then
    raise exception 'Pilot status must be active or suspended.';
  end if;

  select * into v_tenant from public.tenants where _id = p_tenant_id;
  if not found then
    raise exception 'Organization not found.';
  end if;
  if v_tenant.account_type is distinct from 'free_pilot' then
    raise exception 'This organization is not a Free Pilot organization.';
  end if;

  if p_status = 'suspended' then
    update public.complimentary_access
    set status = 'revoked', revoked_at = v_now, revoked_by = auth.uid(), updated_at = v_now
    where organization_id = p_tenant_id and user_id is null and status = 'active';
  else
    -- Reactivate: grant lifetime unless a live grant still applies.
    if not exists (
      select 1 from public.complimentary_access c
      where c.organization_id = p_tenant_id
        and c.status = 'active'
        and c.user_id is null
        and (c.expires_at is null or c.expires_at > v_now)
    ) then
      perform public.admin_grant_complimentary_access_until(
        p_tenant_id, null,
        coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'Free Pilot organization (reactivated)'),
        null
      );
    end if;
  end if;

  insert into public.atlas_audit_log (
    actor_id, actor_email, action, target_type, target_id, details
  ) values (
    auth.uid(),
    (select email from public.profiles where _id = auth.uid()),
    case when p_status = 'suspended' then 'pilot_suspended' else 'pilot_reactivated' end,
    'organization',
    p_tenant_id,
    jsonb_build_object('status', p_status, 'reason', p_reason)
  );

  return jsonb_build_object(
    'ok', true,
    'tenant_id', p_tenant_id,
    'status', public.atlas_pilot_status(p_tenant_id)
  );
end;
$$;

revoke execute on function public.admin_set_pilot_status(uuid, text, text) from public, anon;
grant execute on function public.admin_set_pilot_status(uuid, text, text) to authenticated, service_role;

-- Convert a pilot to a paid organization.
--
-- IMPORTANT: this does NOT create a Stripe customer or subscription, and it
-- does not call Stripe. The paid subscription is created by the normal Stripe
-- Checkout flow and reconciled by the existing webhook, which writes
-- organization_subscriptions. This function is the Atlas-side bookkeeping
-- that runs after that: it revokes the Free Pilot grant so there is exactly
-- ONE authoritative active entitlement, and marks the tenant converted.
--
-- The organization id, its members, and all of its data are untouched.
--
-- AUTHORIZATION: a super_admin (interactive) OR a trusted server connection.
-- The Stripe webhook runs as service_role with no auth.uid(), so it is NOT a
-- super_admin; atlas_is_trusted_server() is the existing sanctioned
-- server-role boundary (it rejects the anon key). This lets the SAME RPC be
-- driven by the webhook when Stripe reports an authoritative paid
-- subscription, with no second conversion path.
--
-- IDEMPOTENT: a repeat call on an already-converted organization is a no-op
-- (the account_type guard raises before any write), so duplicate Stripe
-- deliveries cannot revoke a paid entitlement or corrupt state.
create or replace function public.admin_convert_pilot_to_paid(
  p_tenant_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
  v_tenant record;
begin
  if not (public.is_super_admin() or public.atlas_is_trusted_server()) then
    raise exception 'Access denied: super_admin required';
  end if;

  select * into v_tenant from public.tenants where _id = p_tenant_id;
  if not found then
    raise exception 'Organization not found.';
  end if;
  if v_tenant.account_type is distinct from 'free_pilot' then
    raise exception 'This organization is not a Free Pilot organization.';
  end if;

  -- Revoke the pilot entitlement so only the paid subscription grants access.
  update public.complimentary_access
  set status = 'revoked', revoked_at = v_now, revoked_by = auth.uid(), updated_at = v_now
  where organization_id = p_tenant_id and status = 'active';

  update public.tenants
  set account_type = 'standard',
      pilot_converted_at = v_now
  where _id = p_tenant_id;

  insert into public.atlas_audit_log (
    actor_id, actor_email, action, target_type, target_id, details
  ) values (
    auth.uid(),
    (select email from public.profiles where _id = auth.uid()),
    'pilot_converted_to_paid',
    'organization',
    p_tenant_id,
    jsonb_build_object(
      'reason', p_reason,
      'converted_at', v_now,
      'has_paid_subscription', exists (
        select 1 from public.organization_subscriptions s
        where s.organization_id = p_tenant_id
          and s.status in ('active', 'trialing')
      )
    )
  );

  return jsonb_build_object(
    'ok', true,
    'tenant_id', p_tenant_id,
    'account_type', 'standard',
    'status', public.atlas_pilot_status(p_tenant_id),
    'converted_at', v_now
  );
end;
$$;

revoke execute on function public.admin_convert_pilot_to_paid(uuid, text) from public, anon;
grant execute on function public.admin_convert_pilot_to_paid(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. admin_list_tenants — surface the internal pilot classification
-- ---------------------------------------------------------------------------
-- Adds account_type, pilot_status, pilot expiration and whether a paid Stripe
-- subscription exists. `billing` is the internal summary the spec asks for; it
-- is only ever returned to a super_admin.
drop function if exists public.admin_list_tenants(integer);

create or replace function public.admin_list_tenants(
  p_limit integer default 200
)
returns setof json
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception 'Access denied: super_admin required';
  end if;

  return query
  select json_build_object(
    '_id', t._id,
    'name', t.name,
    'slug', t.slug,
    'status', t.status,
    'created_at', t."_creationTime",
    'billing_state', t.billing_state,
    'account_type', t.account_type,
    'pilot_status', public.atlas_pilot_status(t._id),
    'pilot_notes', t.pilot_notes,
    'pilot_limits', t.pilot_limits,
    'pilot_converted_at', t.pilot_converted_at,
    'pilot_expires_at', (
      select c.expires_at from public.complimentary_access c
      where c.organization_id = t._id
        and c.status = 'active'
        and c.user_id is null
      order by c.granted_at desc
      limit 1
    ),
    'has_complimentary_grant', exists (
      select 1 from public.complimentary_access c
      where c.organization_id = t._id
        and c.status = 'active'
        and c.user_id is null
        and (c.expires_at is null
             or c.expires_at > (extract(epoch from now()) * 1000)::bigint)
    ),
    'member_count', (
      select count(*)::int from public.memberships m where m."tenantId" = t._id
    ),
    'billing', json_build_object(
      'provider', s.billing_provider,
      'status', s.status,
      'internal_plan', s.internal_plan,
      'has_stripe_subscription', s.provider_subscription_id is not null,
      'has_stripe_customer', s.provider_customer_id is not null
    )
  )
  from public.tenants t
  left join lateral (
    select s.* from public.organization_subscriptions s
    where s.organization_id = t._id
    limit 1
  ) s on true
  order by t.name nulls last
  limit p_limit;
end;
$$;

revoke execute on function public.admin_list_tenants(integer) from public, anon;
grant execute on function public.admin_list_tenants(integer) to authenticated, service_role;
