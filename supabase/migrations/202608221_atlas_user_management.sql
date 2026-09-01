-- ============================================================================
-- Atlas User Management RPCs
-- ============================================================================
-- Provides admin-level user listing, role/status updates, company assignment,
-- and user provisioning via Supabase Auth Admin API.
--
-- All functions enforce authorization server-side:
--   - admin_list_users, admin_update_user_role, admin_update_user_status,
--     admin_update_user_company, admin_invite_user → super_admin or atlas_admin
--   - admin_create_tenant, admin_list_tenants → super_admin only
--
-- Idempotent: safe to run multiple times.
-- ============================================================================

-- Helper: is the current user an internal admin?
CREATE OR REPLACE FUNCTION public.is_atlas_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE _id = auth.uid()
    AND account_status = 'active'
    AND platform_role IN ('super_admin', 'atlas_admin')
  );
$$;

-- Helper: is the current user a super_admin?
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE _id = auth.uid()
    AND account_status = 'active'
    AND platform_role = 'super_admin'
  );
$$;

-- ---------------------------------------------------------------------------
-- admin_list_users: List all users with their membership info
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
    'company_name', p.company_name,
    'created_at', p.created_at,
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
  ORDER BY p.created_at DESC NULLS LAST
  LIMIT p_limit;
END;
$$;

-- ---------------------------------------------------------------------------
-- admin_get_user: Get a single user by ID
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_get_user(
  p_user_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result json;
BEGIN
  IF NOT public.is_atlas_admin() THEN
    RAISE EXCEPTION 'Access denied: admin role required';
  END IF;

  SELECT json_build_object(
    '_id', p._id,
    'name', p.name,
    'email', p.email,
    'image', p.image,
    'platform_role', p.platform_role,
    'account_status', p.account_status,
    'company_name', p.company_name,
    'created_at', p.created_at
  ) INTO result
  FROM public.profiles p
  WHERE p._id = p_user_id;

  RETURN result;
END;
$$;

-- ---------------------------------------------------------------------------
-- admin_update_user_role: Update a user's platform_role
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_update_user_role(
  p_user_id uuid,
  p_new_role text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller_role text;
BEGIN
  IF NOT public.is_atlas_admin() THEN
    RAISE EXCEPTION 'Access denied: admin role required';
  END IF;

  -- Get caller's role for privilege check
  SELECT platform_role INTO caller_role
  FROM public.profiles WHERE _id = auth.uid();

  -- Only super_admin can assign super_admin or atlas_admin roles
  IF p_new_role IN ('super_admin', 'atlas_admin') AND caller_role != 'super_admin' THEN
    RAISE EXCEPTION 'Access denied: only super_admin can assign admin roles';
  END IF;

  UPDATE public.profiles
  SET platform_role = p_new_role,
      _updated_at = now()
  WHERE _id = p_user_id;

  -- Log audit
  INSERT INTO public.auditLogs (tenantId, userId, action, details)
  SELECT
    (SELECT "tenantId" FROM public.memberships WHERE "userId" = auth.uid() LIMIT 1),
    auth.uid(),
    'update_user_role',
    json_build_object('target_user_id', p_user_id, 'new_role', p_new_role)::text
  ON CONFLICT DO NOTHING;

  RETURN json_build_object('ok', true);
END;
$$;

-- ---------------------------------------------------------------------------
-- admin_update_user_status: Update a user's account_status
-- ---------------------------------------------------------------------------
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

  UPDATE public.profiles
  SET account_status = p_new_status,
      _updated_at = now()
  WHERE _id = p_user_id;

  -- Log audit
  INSERT INTO public.auditLogs (tenantId, userId, action, details)
  SELECT
    (SELECT "tenantId" FROM public.memberships WHERE "userId" = auth.uid() LIMIT 1),
    auth.uid(),
    'update_user_status',
    json_build_object('target_user_id', p_user_id, 'new_status', p_new_status)::text
  ON CONFLICT DO NOTHING;

  RETURN json_build_object('ok', true);
END;
$$;

-- ---------------------------------------------------------------------------
-- admin_update_user_company: Update a user's company assignment
-- ---------------------------------------------------------------------------
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

  UPDATE public.profiles
  SET company_name = p_new_company,
      _updated_at = now()
  WHERE _id = p_user_id;

  RETURN json_build_object('ok', true);
END;
$$;

-- ---------------------------------------------------------------------------
-- admin_list_tenants: List all tenants/companies
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_list_tenants(
  p_limit integer DEFAULT 200
)
RETURNS SETOF json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Access denied: super_admin required';
  END IF;

  RETURN QUERY
  SELECT json_build_object(
    '_id', t._id,
    'name', t.name,
    'created_at', t.created_at,
    'member_count', (
      SELECT count(*)::int FROM public.memberships m WHERE m."tenantId" = t._id
    )
  )
  FROM public.tenants t
  ORDER BY t.name NULLS LAST
  LIMIT p_limit;
END;
$$;

-- ---------------------------------------------------------------------------
-- admin_create_tenant: Create a new tenant/company
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_create_tenant(
  p_name text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_tenant_id uuid;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Access denied: super_admin required';
  END IF;

  INSERT INTO public.tenants (name, _creationTime)
  VALUES (p_name, extract(epoch from now()) * 1000)
  RETURNING _id INTO new_tenant_id;

  RETURN json_build_object('ok', true, 'tenant_id', new_tenant_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- admin_invite_user: Provision a user into Atlas (handles both new and existing)
--
-- If the user already exists in Supabase Auth (by email), we just create/update
-- their Atlas profile. If not, we create the Supabase Auth user via Admin API
-- is NOT possible from RPC (requires service role), so we return the info needed
-- for the frontend to use the Supabase Admin API or send an invite.
--
-- This function creates/updates the Atlas profile and membership.
-- ---------------------------------------------------------------------------
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
BEGIN
  IF NOT public.is_atlas_admin() THEN
    RAISE EXCEPTION 'Access denied: admin role required';
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
      company_name = COALESCE(p_company_name, company_name),
      name = COALESCE(p_name, name),
      _updated_at = now()
    WHERE _id = target_user_id;

    RETURN json_build_object(
      'ok', true,
      'user_id', target_user_id,
      'action', 'updated',
      'message', 'Existing user provisioned with new role/status'
    );
  ELSE
    -- User does not have an Atlas profile yet.
    -- The frontend should create the Supabase Auth user first (via invite),
    -- then call this again, OR we create a pending profile placeholder.
    -- Create a placeholder profile that will be merged when the user signs up.
    INSERT INTO public.profiles (
      _id, email, name, platform_role, account_status, company_name,
      role, _creationTime
    ) VALUES (
      gen_random_uuid(), p_email, p_name, p_role, p_status, p_company_name,
      'user', extract(epoch from now()) * 1000
    )
    ON CONFLICT (_id) DO NOTHING
    RETURNING _id INTO target_user_id;

    RETURN json_build_object(
      'ok', true,
      'user_id', target_user_id,
      'action', 'created_placeholder',
      'message', 'Placeholder profile created. Supabase Auth invite should be sent separately.'
    );
  END IF;
END;
$$;
