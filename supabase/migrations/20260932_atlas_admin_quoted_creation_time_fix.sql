-- 20260932 — Fix unquoted "_creationTime" in the complimentary org/user admin RPCs
--
-- BUG (live in production, blocking super_admin org creation):
--   `public.tenants` and `public.profiles` store their creation timestamp in a
--   MIXED-CASE column: "_creationTime". An unquoted reference folds to
--   "_creationtime", which does not exist, so every call failed with
--     ERROR: column "_creationtime" of relation "tenants" does not exist
--   This is the same bug class already fixed for admin_delete_organization in
--   20260931. `check_function_bodies` cannot catch it: the name is only
--   resolved when the function body actually executes.
--
-- IMPACT — this is why a super_admin could not create organizations or users
--   for complimentary access:
--     admin_create_tenant            -> could never create an organization
--     admin_create_pilot_organization-> could never create a Free Pilot org
--                                      (and never created its primary profile)
--     admin_list_users               -> admin user list raised on every call
--   `admin_grant_complimentary_access` was fine, but it is unreachable in
--   practice because there was no way to create the organization to grant to.
--
-- SCOPE: bodies are byte-identical to the deployed versions except for the
--   added double quotes. No authorization change, no new grant, no widened
--   access: the existing grants and the is_super_admin()/is_atlas_admin()
--   guards are untouched, and no revoke/grant statements are repeated here.
--   Source migrations 20260927 and 202608251 are fixed at source too.
--
-- Verified against production before and after: with Melissa's JWT simulated
-- (`set_config('request.jwt.claim.sub', ...)`) all three RPCs succeed, and the
-- whole probe is rolled back.

-- ---------------------------------------------------------------------------
-- 1. admin_create_tenant
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 2. admin_create_pilot_organization
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 3. admin_grant_complimentary_access — bigint overflow in the duration math
-- ---------------------------------------------------------------------------
-- BUG: `30 * 24 * 60 * 60 * 1000` is evaluated in int4 and overflows, so
--   ERROR: integer out of range
-- Casting the RESULT to bigint (`(30 * 24 * 60 * 60 * 1000)::bigint`) is too
-- late — the overflow happens first. 7d (604,800,000) and lifetime survived;
-- 30d, 90d and 1y (anything over int4 max 2,147,483,647) always failed. That
-- is why a super_admin could not grant complimentary access to a user on
-- anything but a 7-day term. Fixed by widening the FIRST operand, so the whole
-- expression is computed in bigint.
--
-- Same defect is fixed at source in 20260909.
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

  -- The multiplication is done in bigint. Casting only the RESULT to bigint is
  -- too late: the literals are int4, so 30/90/365 days overflowed at runtime
  -- ("integer out of range") and only 7d and lifetime ever worked.
  case p_duration
    when '7d' then v_expires := v_now + (7::bigint * 24 * 60 * 60 * 1000);
    when '30d' then v_expires := v_now + (30::bigint * 24 * 60 * 60 * 1000);
    when '90d' then v_expires := v_now + (90::bigint * 24 * 60 * 60 * 1000);
    when '1y' then v_expires := v_now + (365::bigint * 24 * 60 * 60 * 1000);
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

-- ---------------------------------------------------------------------------
-- 4. admin_list_users
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_list_users(
  p_search text DEFAULT NULL,
  p_role text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_limit integer DEFAULT 100
)
RETURNS SETOF json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_atlas_admin() THEN
    RAISE EXCEPTION 'Access denied: admin role required';
  END IF;

  RETURN QUERY
  SELECT json_build_object(
    '_id', p._id,
    'name', p.name,
    'email', p.email,
    'image', p.image,
    'platform_role', p.platform_role,
    'account_status', p.account_status,
    'created_at', p."_creationTime",
    'membership', (
      SELECT json_build_object(
        'tenant_id', m."tenantId",
        'role', m."role",
        'tenant_name', t.name
      )
      FROM public.memberships m
      JOIN public.tenants t ON t._id = m."tenantId"
      WHERE m."userId" = p._id
      LIMIT 1
    )
  )
  FROM public.profiles p
  WHERE
    (p_search IS NULL OR p_search = '' OR
     p.name ILIKE '%' || p_search || '%' OR
     p.email ILIKE '%' || p_search || '%')
    AND (p_role IS NULL OR p_role = '' OR p.platform_role = p_role)
    AND (p_status IS NULL OR p_status = '' OR p.account_status = p_status)
  ORDER BY p."_creationTime" DESC NULLS LAST
  LIMIT p_limit;
END;
$$;
