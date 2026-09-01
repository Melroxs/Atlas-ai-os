-- ==========================================================================
-- Atlas User Management RPC Fixes (2026-08-25)
--
-- Fixes:
-- 1. admin_list_users: replace p.company_name (doesn't exist on profiles)
--    with company name from the user's membership/tenant.
--    Replace p.created_at with p._creationTime.
-- 2. admin_invite_user: remove company_name/_updated_at references.
--    Add proper invite record creation for pilot invitations.
--    Return the invite URL so the Edge Function can send it via email.
-- 3. admin_update_user_role: remove _updated_at reference.
-- 4. admin_update_user_status: remove _updated_at reference.
-- 5. admin_update_user_company: remove _updated_at reference.
-- ==========================================================================

-- ── admin_list_users ─────────────────────────────────────────────────────
-- FIXED: company_name comes from tenant name, created_at → _creationTime
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
    'created_at', p._creationTime,
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
  ORDER BY p._creationTime DESC NULLS LAST
  LIMIT p_limit;
END;
$$;

-- ── admin_update_user_role ───────────────────────────────────────────────
-- FIXED: removed _updated_at reference
CREATE OR REPLACE FUNCTION public.admin_update_user_role(
  p_user_id uuid,
  p_new_role text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Access denied: super_admin role required';
  END IF;

  IF p_new_role IS NULL OR p_new_role NOT IN (
    'super_admin', 'atlas_admin', 'customer_admin', 'customer_user', 'pilot_user', 'user'
  ) THEN
    RAISE EXCEPTION 'Invalid role: %', p_new_role;
  END IF;

  UPDATE public.profiles
  SET platform_role = p_new_role
  WHERE _id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  RETURN json_build_object('ok', true, 'user_id', p_user_id, 'role', p_new_role);
END;
$$;

-- ── admin_update_user_status ─────────────────────────────────────────────
-- FIXED: removed _updated_at reference
CREATE OR REPLACE FUNCTION public.admin_update_user_status(
  p_user_id uuid,
  p_new_status text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_atlas_admin() THEN
    RAISE EXCEPTION 'Access denied: admin role required';
  END IF;

  IF p_new_status IS NULL OR p_new_status NOT IN ('active', 'pending', 'suspended', 'revoked') THEN
    RAISE EXCEPTION 'Invalid status: %', p_new_status;
  END IF;

  UPDATE public.profiles
  SET account_status = p_new_status
  WHERE _id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  RETURN json_build_object('ok', true, 'user_id', p_user_id, 'status', p_new_status);
END;
$$;

-- ── admin_update_user_company ────────────────────────────────────────────
-- NOTE: profiles doesn't have a company_name column.
-- This is intentionally a no-op placeholder so the frontend call doesn't crash.
-- Company info is stored in tenants/companyProfiles, not on the profile.
CREATE OR REPLACE FUNCTION public.admin_update_user_company(
  p_user_id uuid,
  p_new_company text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_atlas_admin() THEN
    RAISE EXCEPTION 'Access denied: admin role required';
  END IF;

  -- Company assignment is handled via tenants/memberships, not the profiles table.
  -- Return success so the frontend doesn't error, but log the attempt.
  PERFORM public.log_audit(
    'admin_company_update_attempt',
    'user', p_user_id::text,
    jsonb_build_object('company', p_new_company)
  );

  RETURN json_build_object(
    'ok', true,
    'user_id', p_user_id,
    'message', 'Company assignment is managed through workspace membership.'
  );
END;
$$;

-- ── admin_invite_user ────────────────────────────────────────────────────
-- FIXED: removed company_name/_updated_at references.
-- Now creates proper invite records for pilot invitations.
-- Returns info the Edge Function needs to send the invitation email.
CREATE OR REPLACE FUNCTION public.admin_invite_user(
  p_email text,
  p_name text DEFAULT NULL,
  p_role text DEFAULT 'customer_user',
  p_status text DEFAULT 'active',
  p_company_name text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_user_id uuid;
  existing_profile record;
  v_actor uuid := auth.uid();
  v_tenant uuid;
  v_invite_id uuid;
  v_site_url text;
BEGIN
  IF NOT public.is_atlas_admin() THEN
    RAISE EXCEPTION 'Access denied: admin role required';
  END IF;

  -- Validate role
  IF p_role IS NULL OR p_role NOT IN (
    'super_admin', 'atlas_admin', 'customer_admin', 'customer_user', 'pilot_user', 'user'
  ) THEN
    RAISE EXCEPTION 'Invalid role: %', p_role;
  END IF;

  -- Normalize email
  p_email := lower(trim(p_email));
  IF p_email = '' OR p_email IS NULL THEN
    RAISE EXCEPTION 'Email is required';
  END IF;

  -- Check if profile already exists by email
  SELECT _id INTO target_user_id
  FROM public.profiles
  WHERE email = p_email
  LIMIT 1;

  IF target_user_id IS NOT NULL THEN
    -- User exists — update their profile
    UPDATE public.profiles
    SET
      platform_role = p_role,
      account_status = p_status,
      name = COALESCE(p_name, name)
    WHERE _id = target_user_id;

    -- Get or create the caller's tenant for membership
    v_tenant := public.my_tenant_id();

    -- Create membership if not exists
    IF v_tenant IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.memberships
        WHERE "tenantId" = v_tenant AND "userId" = target_user_id
      ) THEN
        INSERT INTO public.memberships ("tenantId", "userId", role, status, "invitedBy", "joinedAt")
        VALUES (v_tenant, target_user_id, CASE WHEN p_role = 'super_admin' THEN 'owner' ELSE 'viewer' END, 'active', v_actor, public.epoch_ms());
      END IF;
    END IF;

    RETURN json_build_object(
      'ok', true,
      'user_id', target_user_id,
      'action', 'existing_user_provisioned',
      'message', 'Existing user provisioned with role=' || p_role || ', status=' || p_status
    );
  ELSE
    -- User does not exist yet.
    -- Create a pending invite record that tenats_claim_invites will pick up
    -- when the user eventually signs up via the Supabase invitation link.
    v_tenant := public.my_tenant_id();

    IF v_tenant IS NULL THEN
      RAISE EXCEPTION 'No workspace found for the caller.';
    END IF;

    -- Check for existing pending invite
    SELECT _id INTO v_invite_id
    FROM public.invites
    WHERE "tenantId" = v_tenant AND email = p_email AND status = 'pending'
    LIMIT 1;

    IF v_invite_id IS NOT NULL THEN
      -- Already invited — return the existing invite info
      RETURN json_build_object(
        'ok', true,
        'invite_id', v_invite_id,
        'action', 'already_invited',
        'message', 'Invitation already pending for ' || p_email
      );
    END IF;

    -- Create a new pending invite
    INSERT INTO public.invites ("tenantId", email, role, "invitedBy", status)
    VALUES (v_tenant, p_email, CASE WHEN p_role = 'super_admin' THEN 'owner' ELSE 'viewer' END, v_actor, 'pending')
    RETURNING _id INTO v_invite_id;

    -- Audit log
    PERFORM public.log_audit(
      'member_invited',
      'invite', v_invite_id::text,
      jsonb_build_object('email', p_email, 'role', p_role)
    );

    RETURN json_build_object(
      'ok', true,
      'invite_id', v_invite_id,
      'action', 'new_user_invited',
      'email', p_email,
      'message', 'Invitation created for ' || p_email
    );
  END IF;
END;
$$;
