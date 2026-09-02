-- Atlas Billing State Migration
-- Adds billing_state to tenants for tracking SaaS subscription lifecycle,
-- and creates tenants_init_for_checkout RPC for the commercial signup flow.
--
-- The existing tenants.status field is preserved for backward compatibility.
-- billing_state tracks the subscription lifecycle independently.

-- ---------------------------------------------------------------------------
-- Add billing_state column to tenants
-- ---------------------------------------------------------------------------
-- Values: 'pending_checkout', 'active', 'payment_failed', 'cancelled'
-- Default: NULL (existing tenants have no billing state — they predate SaaS)
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS billing_state text;

-- Create index for billing_state lookups (e.g., finding tenants stuck in pending)
CREATE INDEX IF NOT EXISTS idx_tenants_billing_state ON public.tenants (billing_state)
  WHERE billing_state IS NOT NULL;

-- ---------------------------------------------------------------------------
-- tenants_init_for_checkout
--
-- Idempotent function that initializes a tenant for the SaaS checkout flow.
-- Creates tenant + owner membership with billing_state = 'pending_checkout'.
--
-- If the user already belongs to a workspace, returns the existing tenant
-- instead of creating a duplicate. This is the core idempotency guarantee.
--
-- Security: SECURITY DEFINER so it can insert into tenants/memberships
-- using auth.uid(). The function itself validates authentication.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tenants_init_for_checkout(p_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_tenant uuid;
  v_slug text;
  v_existing uuid;
  v_already_had_tenant boolean := false;
BEGIN
  -- Must be authenticated
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'You must be signed in.';
  END IF;

  -- Check if user already belongs to a workspace (idempotency)
  v_existing := public.my_tenant_id();
  IF v_existing IS NOT NULL THEN
    v_already_had_tenant := true;
    v_tenant := v_existing;
  END IF;

  -- Validate name
  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION 'Organization name is required.';
  END IF;

  IF NOT v_already_had_tenant THEN
    -- Generate slug
    v_slug := lower(regexp_replace(trim(p_name), '[^a-z0-9]+', '-', 'g'));
    v_slug := left(trim(both '-' from v_slug), 40);
    IF v_slug = '' THEN v_slug := 'workspace'; END IF;
    v_slug := v_slug || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 4);

    -- Create tenant with billing_state = 'pending_checkout'
    INSERT INTO public.tenants (name, slug, status, billing_state)
    VALUES (trim(p_name), v_slug, 'active', 'pending_checkout')
    RETURNING _id INTO v_tenant;

    -- Create owner membership
    INSERT INTO public.memberships ("tenantId", "userId", role, status, "joinedAt")
    VALUES (v_tenant, v_user, 'owner', 'active', public.epoch_ms());

    -- Create company profile
    INSERT INTO public.companyProfiles ("tenantId", "companyName", "onboardingStep", "onboardingComplete")
    VALUES (v_tenant, trim(p_name), 0, false);

    -- Audit log
    PERFORM public.log_audit('tenant_created_for_checkout', 'tenant', v_tenant::text,
      jsonb_build_object('name', p_name, 'billing_state', 'pending_checkout'));
  ELSE
    -- User already has a tenant — ensure billing_state is set
    -- (only update if currently NULL, don't overwrite active/cancelled states)
    UPDATE public.tenants
    SET billing_state = COALESCE(billing_state, 'pending_checkout')
    WHERE _id = v_tenant
      AND billing_state IS NULL;
  END IF;

  RETURN jsonb_build_object(
    'tenantId', v_tenant,
    'alreadyExisted', v_already_had_tenant
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- tenants_activate_after_payment
--
-- Called by the webhook (via service-role) to activate a tenant after
-- successful Stripe payment. Idempotent — safe to call multiple times.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tenants_activate_after_payment(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Tenant ID is required.';
  END IF;

  -- Update billing_state to active (idempotent — no-op if already active)
  UPDATE public.tenants
  SET billing_state = 'active',
      status = 'active'
  WHERE _id = p_tenant_id
    AND billing_state != 'active';

  -- Audit log
  PERFORM public.log_audit('tenant_activated_after_payment', 'tenant', p_tenant_id::text,
    jsonb_build_object('billing_state', 'active'));

  RETURN jsonb_build_object('ok', true, 'tenantId', p_tenant_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- tenants_handle_payment_failure
--
-- Called by webhook when payment fails. Sets billing_state to 'payment_failed'.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tenants_handle_payment_failure(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Tenant ID is required.';
  END IF;

  UPDATE public.tenants
  SET billing_state = 'payment_failed'
  WHERE _id = p_tenant_id;

  PERFORM public.log_audit('tenant_payment_failed', 'tenant', p_tenant_id::text,
    jsonb_build_object('billing_state', 'payment_failed'));

  RETURN jsonb_build_object('ok', true, 'tenantId', p_tenant_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- tenants_handle_subscription_cancelled
--
-- Called by webhook when subscription is cancelled.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tenants_handle_subscription_cancelled(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Tenant ID is required.';
  END IF;

  UPDATE public.tenants
  SET billing_state = 'cancelled'
  WHERE _id = p_tenant_id;

  PERFORM public.log_audit('tenant_subscription_cancelled', 'tenant', p_tenant_id::text,
    jsonb_build_object('billing_state', 'cancelled'));

  RETURN jsonb_build_object('ok', true, 'tenantId', p_tenant_id);
END;
$$;
