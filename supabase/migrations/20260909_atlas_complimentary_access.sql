-- ===========================================================================
-- Atlas — Complimentary Access
--
-- Complimentary access is an Atlas-controlled entitlement, entirely separate
-- from Paddle billing. It is NEVER a fake Paddle subscription, transaction,
-- webhook event, or customer id.
--
-- Access rule (Phase 8 of the Super Admin spec):
--   ACTIVE PAID PADDLE ACCESS  OR  ACTIVE COMPLIMENTARY ACCESS  =  ACCESS
--   expired / revoked / neither                                        =  DENIED
--
-- Design:
--   * `complimentary_access` — one row per grant. `user_id` NULL means the
--     grant covers the whole organization; a non-NULL user_id restricts it to
--     that member. `expires_at` NULL means lifetime (no arbitrary far-future
--     date). Written ONLY by the super_admin RPCs below (security definer).
--   * Paddle isolation: the paddle-webhook never touches this table, and
--     `billing_apply_state` (which the webhook calls to flip
--     tenants.billing_state) is left untouched. Complimentary access cannot
--     be overwritten by subscription cancellation / payment failure / pause /
--     trial state. Effective access is computed at read time.
--   * `users_current_user` (the profile hydration the frontend access gate
--     reads) gains server-computed `billing_state` (effective),
--     `access_source` ('paddle' | 'complimentary' | null) and `complimentary`
--     (the active grant, for display). The frontend is never the authority.
--   * `billing_get_state` (used by BillingSettings / PricingSuccess) reports
--     isActive when either path grants access, plus accessSource +
--     complimentary.
--   * `can_access_atlas()` (RLS helper) also grants when complimentary access
--     is active for the caller's organization.
--   * Every grant/revoke writes an `atlas_audit_log` row (actor, target,
--     organization, reason). No passwords or secrets are ever stored there.
--
-- Idempotent / non-destructive: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE
-- FUNCTION, defensive REVOKE/GRANT. Safe to apply on top of production data.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. complimentary_access table
-- ---------------------------------------------------------------------------

create table if not exists public.complimentary_access (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.tenants (_id) on delete cascade,
  -- NULL = organization-wide grant; otherwise restricted to this member.
  user_id uuid references public.profiles (_id) on delete cascade,
  -- ON DELETE SET NULL so deleting an admin user never blocks deletion and
  -- never deletes the grant history.
  granted_by uuid references public.profiles (_id) on delete set null,
  granted_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  -- NULL = lifetime (no arbitrary far-future date).
  expires_at bigint,
  reason text not null,
  status text not null default 'active'
    check (status in ('active', 'revoked')),
  revoked_at bigint,
  revoked_by uuid references public.profiles (_id) on delete set null,
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  updated_at bigint not null default (extract(epoch from now()) * 1000)::bigint
);

create index if not exists complimentary_access_org_idx
  on public.complimentary_access (organization_id);
create index if not exists complimentary_access_user_idx
  on public.complimentary_access (user_id)
  where user_id is not null;
create index if not exists complimentary_access_active_idx
  on public.complimentary_access (organization_id, status, expires_at)
  where status = 'active';

alter table public.complimentary_access enable row level security;

-- Client roles never write complimentary access; reads go through the
-- membership-checked `complimentary_get_my_org()` RPC (security definer).
revoke all on table public.complimentary_access from anon, authenticated;

-- Belt-and-braces: super_admin can manage directly (the RPCs are definer and
-- enforce is_super_admin() anyway; the policy protects the table itself).
do $$ begin
  drop policy if exists "complimentary_access_super_admin" on public.complimentary_access;
  create policy "complimentary_access_super_admin" on public.complimentary_access
    for all using (
      exists (
        select 1 from public.profiles
        where _id = auth.uid() and platform_role = 'super_admin'
      )
    );
end $$;

-- ---------------------------------------------------------------------------
-- 2. admin_grant_complimentary_access — super_admin only
-- ---------------------------------------------------------------------------
-- Duration codes: 7d, 30d, 90d, 1y, lifetime.
-- Re-granting to the same scope supersedes the previous active grant (an
-- explicit, intentional transition) and audits both the supersede + the new
-- grant. A user-specific grant never revokes an organization-wide grant and
-- vice versa — grants are additive entitlements.
create or replace function public.admin_grant_complimentary_access(
  p_tenant_id uuid,
  p_duration text,
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
  v_expires bigint := null;
  v_grant record;
  v_tenant_exists boolean;
  v_user_exists boolean;
begin
  if not public.is_super_admin() then
    raise exception 'Access denied: super_admin required';
  end if;

  if p_tenant_id is null then
    raise exception 'Organization is required.';
  end if;
  select exists (select 1 from public.tenants where _id = p_tenant_id) into v_tenant_exists;
  if not v_tenant_exists then
    raise exception 'Organization not found.';
  end if;

  if p_user_id is not null then
    select exists (select 1 from public.profiles where _id = p_user_id) into v_user_exists;
    if not v_user_exists then
      raise exception 'User not found.';
    end if;
  end if;

  if p_reason is null or trim(p_reason) = '' then
    raise exception 'A reason is required for complimentary access.';
  end if;

  case p_duration
    when '7d' then v_expires := v_now + (7 * 24 * 60 * 60 * 1000)::bigint;
    when '30d' then v_expires := v_now + (30 * 24 * 60 * 60 * 1000)::bigint;
    when '90d' then v_expires := v_now + (90 * 24 * 60 * 60 * 1000)::bigint;
    when '1y' then v_expires := v_now + (365 * 24 * 60 * 60 * 1000)::bigint;
    when 'lifetime' then v_expires := null;
    else raise exception 'Invalid duration. Expected 7d, 30d, 90d, 1y or lifetime.';
  end case;

  -- Supersede any previous ACTIVE grant for the same scope:
  --   org-wide (p_user_id is null)  -> previous org-wide grants only
  --   user-specific                 -> that user's previous grants only
  if p_user_id is null then
    update public.complimentary_access
    set status = 'revoked',
        revoked_at = v_now,
        revoked_by = auth.uid(),
        updated_at = v_now
    where organization_id = p_tenant_id
      and user_id is null
      and status = 'active';
  else
    update public.complimentary_access
    set status = 'revoked',
        revoked_at = v_now,
        revoked_by = auth.uid(),
        updated_at = v_now
    where organization_id = p_tenant_id
      and user_id = p_user_id
      and status = 'active';
  end if;

  insert into public.complimentary_access (
    organization_id, user_id, granted_by, granted_at, expires_at,
    reason, status
  ) values (
    p_tenant_id, p_user_id, auth.uid(), v_now, v_expires,
    trim(p_reason), 'active'
  )
  returning * into v_grant;

  -- Audit
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
      'organization_id', p_tenant_id,
      'duration', p_duration,
      'expires_at', v_expires,
      'lifetime', p_duration = 'lifetime',
      'reason', trim(p_reason)
    )
  );

  return to_jsonb(v_grant);
end;
$$;

revoke execute on function public.admin_grant_complimentary_access(uuid, text, text, uuid) from public, anon;
-- Internal is_super_admin() guard decides; the caller's JWT supplies auth.uid().
-- `authenticated` may attempt, super_admin may succeed (matches the existing
-- admin_* RPC convention used by admin_list_tenants / admin_invite_user).
grant execute on function public.admin_grant_complimentary_access(uuid, text, text, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. admin_revoke_complimentary_access — super_admin only
-- ---------------------------------------------------------------------------
create or replace function public.admin_revoke_complimentary_access(
  p_grant_id uuid
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

  if p_grant_id is null then
    raise exception 'Grant id is required.';
  end if;

  select * into v_grant from public.complimentary_access where id = p_grant_id;
  if not found then
    raise exception 'Complimentary access grant not found.';
  end if;

  if v_grant.status = 'active' then
    update public.complimentary_access
    set status = 'revoked',
        revoked_at = v_now,
        revoked_by = auth.uid(),
        updated_at = v_now
    where id = p_grant_id
    returning * into v_grant;

    insert into public.atlas_audit_log (
      actor_id, actor_email, action, target_type, target_id, details
    ) values (
      auth.uid(),
      (select email from public.profiles where _id = auth.uid()),
      'complimentary_access_revoked',
      'organization',
      v_grant.organization_id,
      jsonb_build_object(
        'grant_id', v_grant.id,
        'user_id', v_grant.user_id,
        'organization_id', v_grant.organization_id,
        'revoked_at', v_now,
        'reason', coalesce(v_grant.reason, '')
      )
    );
  end if;

  return to_jsonb(v_grant);
end;
$$;

revoke execute on function public.admin_revoke_complimentary_access(uuid) from public, anon;
grant execute on function public.admin_revoke_complimentary_access(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. admin_list_complimentary_access — super_admin only
-- ---------------------------------------------------------------------------
create or replace function public.admin_list_complimentary_access(
  p_tenant_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception 'Access denied: super_admin required';
  end if;

  return coalesce((
    select jsonb_agg(
      to_jsonb(c) || jsonb_build_object(
        'user_name', p.name,
        'user_email', p.email
      )
      order by c.granted_at desc
    )
    from public.complimentary_access c
    left join public.profiles p on p._id = c.user_id
    where c.organization_id = p_tenant_id
  ), '[]'::jsonb);
end;
$$;

revoke execute on function public.admin_list_complimentary_access(uuid) from public, anon;
grant execute on function public.admin_list_complimentary_access(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. complimentary_get_my_org — membership-checked read for the caller's org
-- ---------------------------------------------------------------------------
-- Mirrors the billing_get_state pattern: returns the caller's organization's
-- grants ONLY when the caller is an active member of that organization.
create or replace function public.complimentary_get_my_org()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'organizationId', v_tenant_id,
    'hasActive', v_has_active,
    'grants', v_grants
  )
  from (
    select
      public.my_tenant_id() as v_tenant_id,
      (
        select coalesce(jsonb_agg(to_jsonb(c) order by c.granted_at desc), '[]'::jsonb)
        from public.complimentary_access c
        where c.organization_id = public.my_tenant_id()
          and c.status = 'active'
          and (c.expires_at is null or c.expires_at > (extract(epoch from now()) * 1000)::bigint)
          and (c.user_id is null or c.user_id = auth.uid())
      ) as v_grants,
      exists (
        select 1
        from public.complimentary_access c
        where c.organization_id = public.my_tenant_id()
          and c.status = 'active'
          and (c.expires_at is null or c.expires_at > (extract(epoch from now()) * 1000)::bigint)
          and (c.user_id is null or c.user_id = auth.uid())
      ) as v_has_active
  ) s
  where v_tenant_id is not null
    and exists (
      select 1 from public.memberships m
      where m."userId" = auth.uid() and m."tenantId" = v_tenant_id
    );
$$;

grant execute on function public.complimentary_get_my_org() to authenticated;

-- ---------------------------------------------------------------------------
-- 6. users_current_user — server-computed effective access fields
-- ---------------------------------------------------------------------------
-- Previously `security invoker`; the profile row alone cannot see
-- organization_subscriptions (revoked from client roles) or
-- complimentary_access (revoked above), so the hydration is now a
-- security-definer function that computes the EFFECTIVE billing state the
-- frontend access gate reads. It still only ever returns the caller's own
-- profile (where _id = auth.uid()).
create or replace function public.users_current_user()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_profile jsonb;
  v_tenant uuid;
  v_tenant_state text;
  v_sub_active boolean;
  v_comp jsonb;
  v_comp_active boolean;
  v_effective text;
  v_source text;
begin
  if v_user is null then
    return null;
  end if;

  select to_jsonb(p) into v_profile
  from public.profiles p
  where p._id = v_user;

  if v_profile is null then
    return null;
  end if;

  v_tenant := public.my_tenant_id();

  v_sub_active := false;
  v_comp_active := false;
  v_tenant_state := null;

  if v_tenant is not null then
    select t.billing_state into v_tenant_state
    from public.tenants t where t._id = v_tenant;

    v_sub_active := exists (
      select 1 from public.organization_subscriptions s
      where s.organization_id = v_tenant
        and s.status in ('active', 'trialing')
    );

    select to_jsonb(c) into v_comp
    from public.complimentary_access c
    where c.organization_id = v_tenant
      and c.status = 'active'
      and (c.expires_at is null or c.expires_at > (extract(epoch from now()) * 1000)::bigint)
      and (c.user_id is null or c.user_id = v_user)
    order by (c.user_id = v_user) desc, c.granted_at desc
    limit 1;

    v_comp_active := v_comp is not null;
  end if;

  if v_comp_active then
    v_source := 'complimentary';
    v_effective := 'active';
  elsif v_sub_active then
    v_source := 'paddle';
    v_effective := 'active';
  else
    v_source := null;
    v_effective := v_tenant_state;
  end if;

  return v_profile || jsonb_build_object(
    'billing_state', v_effective,
    'access_source', v_source,
    'complimentary', case when v_comp_active then v_comp else null end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. billing_get_state — include complimentary in the authoritative read
-- ---------------------------------------------------------------------------
create or replace function public.billing_get_state(p_tenantid uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    -- Complimentary orgs have NO organization_subscriptions row; the dummy
    -- FROM row guarantees this function still returns isActive=true for them
    -- (a complimentary organization must never lose access merely because it
    -- has no Paddle subscription).
    'isActive',
      coalesce(
        (s.status in ('active', 'trialing'))
        or (c.id is not null),
        false
      ),
    'plan', s.internal_plan,
    'status', s.status,
    'billingInterval', s.billing_interval,
    'provider', s.billing_provider,
    'providerCustomerId', s.provider_customer_id,
    'providerSubscriptionId', s.provider_subscription_id,
    'providerPriceId', s.provider_price_id,
    'trialStart', s.trial_start,
    'trialEnd', s.trial_end,
    'currentPeriodStart', s.current_period_start,
    'currentPeriodEnd', s.current_period_end,
    'nextBilledAt', s.next_billed_at,
    'cancelAt', s.cancel_at,
    'canceledAt', s.canceled_at,
    'canUsePaidFeatures', coalesce(s.status in ('active', 'trialing'), false),
    'accessSource',
      case
        when c.id is not null then 'complimentary'
        when s.status in ('active', 'trialing') then 'paddle'
        else null
      end,
    'complimentary',
      case when c.id is not null then to_jsonb(c) else null end,
    'subscription', to_jsonb(s)
  )
  from (select 1) dummy
  left join lateral (
    select s.*
    from public.organization_subscriptions s
    where s.organization_id = p_tenantid
    limit 1
  ) s on true
  left join lateral (
    select c.*
    from public.complimentary_access c
    where c.organization_id = p_tenantid
      and c.status = 'active'
      and (c.expires_at is null or c.expires_at > (extract(epoch from now()) * 1000)::bigint)
      and (c.user_id is null or c.user_id = auth.uid())
    order by (c.user_id = auth.uid()) desc, c.granted_at desc
    limit 1
  ) c on true
  where exists (
    select 1
    from public.memberships m
    where m."userId" = auth.uid()
      and m."tenantId" = p_tenantid
  )
$$;

grant execute on function public.billing_get_state(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. can_access_atlas — RLS helper: paid Paddle OR complimentary
-- ---------------------------------------------------------------------------
create or replace function public.can_access_atlas()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_super_admin()
    or public.is_approved_user()
    or exists (
      select 1
      from public.complimentary_access c
      join public.memberships m on m."tenantId" = c.organization_id
      where m."userId" = auth.uid()
        and c.status = 'active'
        and (c.expires_at is null or c.expires_at > (extract(epoch from now()) * 1000)::bigint)
        and (c.user_id is null or c.user_id = auth.uid())
    );
$$;

-- ---------------------------------------------------------------------------
-- 9. admin_prepare_user_deletion — FK-safe cleanup before Auth deletion
-- ---------------------------------------------------------------------------
-- Deleting a Supabase Auth user (auth.admin.deleteUser) cascades to
-- profiles (ON DELETE CASCADE) and from there to memberships and
-- complimentary_access.user_id (ON DELETE CASCADE). Several Atlas tables
-- reference profiles / auth.users WITHOUT cascade, so a naive delete would
-- raise foreign-key violations and leave orphaned rows. This security-definer
-- RPC runs the full cleanup in one audited transaction and returns the user's
-- email so the Edge Function can finish with auth.admin.deleteUser.
--
-- History is preserved, never deleted: audit/decision/log columns are set to
-- NULL (the row remains); only invitation and provisioning rows that would
-- otherwise block deletion are removed. The organization itself is never
-- touched.
create or replace function public.admin_prepare_user_deletion(
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  if not public.is_super_admin() then
    raise exception 'Access denied: super_admin required';
  end if;

  if p_user_id is null then
    raise exception 'User id is required.';
  end if;

  select email into v_email from public.profiles where _id = p_user_id;
  if not found then
    raise exception 'User not found.';
  end if;

  -- Nullable profile references -> preserve history, drop the link.
  -- (camelCase table names are quoted.)
  update public.memberships set "invitedBy" = null where "invitedBy" = p_user_id;
  update public."tenantPacks" set "activatedBy" = null where "activatedBy" = p_user_id;
  update public.documents set "uploadedBy" = null where "uploadedBy" = p_user_id;
  update public.recommendations set "decidedBy" = null where "decidedBy" = p_user_id;
  update public."toolActions" set "actorId" = null, "confirmedBy" = null
    where "actorId" = p_user_id or "confirmedBy" = p_user_id;
  update public.notifications set "recipientId" = null where "recipientId" = p_user_id;
  update public."workflowApprovals" set "decidedBy" = null where "decidedBy" = p_user_id;
  update public."impactAssessments" set "decidedBy" = null where "decidedBy" = p_user_id;
  update public."auditLogs" set "actorId" = null where "actorId" = p_user_id;
  update public."insuranceClaims" set "createdBy" = null where "createdBy" = p_user_id;
  update public."claimSupplements" set "createdBy" = null where "createdBy" = p_user_id;
  update public."archiveIngestions" set "uploadedBy" = null where "uploadedBy" = p_user_id;

  -- Direct auth.users references without cascade
  update public.pilot_applications set reviewed_by = null where reviewed_by = p_user_id;
  update public.atlas_audit_log set actor_id = null where actor_id = p_user_id;
  update public.regulatory_contradictions set resolved_by_id = null where resolved_by_id = p_user_id;
  delete from public.user_provisions
    where provisioned_by = p_user_id or provisioned_user = p_user_id;

  -- Invitations: email-addressed rows for the deleted account are removed;
  -- NOT NULL "invitedBy" rows pointing at the deleted profile are removed.
  delete from public.invites where "invitedBy" = p_user_id or email = v_email;

  -- Audit the deletion (actor is the calling super admin, target is the user)
  insert into public.atlas_audit_log (
    actor_id, actor_email, action, target_type, target_id, details
  ) values (
    auth.uid(),
    (select email from public.profiles where _id = auth.uid()),
    'user_deleted',
    'user',
    p_user_id,
    jsonb_build_object('email', v_email)
  );

  return jsonb_build_object('ok', true, 'user_id', p_user_id, 'email', v_email);
end;
$$;

revoke execute on function public.admin_prepare_user_deletion(uuid) from public, anon;
grant execute on function public.admin_prepare_user_deletion(uuid) to authenticated, service_role;