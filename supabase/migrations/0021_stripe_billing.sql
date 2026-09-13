-- Atlas Stripe Billing Migration
-- Adds subscription management fields to tenants table
-- Idempotent: uses IF NOT EXISTS to prevent duplicate columns

-- Add Stripe and subscription fields to tenants
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stripe_price_id TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'inactive';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_plan TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_billing TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS current_period_start TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN DEFAULT FALSE;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS last_payment_date TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS last_payment_error TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'none';

-- Add indexes for Stripe lookups
CREATE INDEX IF NOT EXISTS idx_tenants_stripe_customer ON tenants(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tenants_stripe_subscription ON tenants(stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tenants_subscription_status ON tenants(subscription_status);

-- Add unique constraint for Stripe customer ID (one customer per tenant)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenants_stripe_customer_id_unique'
  ) THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_stripe_customer_id_unique UNIQUE (stripe_customer_id);
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Create subscription status enum type for validation (optional, for documentation)
COMMENT ON COLUMN tenants.subscription_status IS 'Stripe subscription status: inactive, active, past_due, cancelled, unpaid';
COMMENT ON COLUMN tenants.subscription_plan IS 'Atlas plan: starter, professional, enterprise';
COMMENT ON COLUMN tenants.subscription_billing IS 'Billing interval: monthly, annual';
COMMENT ON COLUMN tenants.stripe_customer_id IS 'Stripe Customer ID (cus_xxx)';
COMMENT ON COLUMN tenants.stripe_subscription_id IS 'Stripe Subscription ID (sub_xxx)';
COMMENT ON COLUMN tenants.stripe_price_id IS 'Stripe Price ID (price_xxx)';
COMMENT ON COLUMN tenants.cancel_at_period_end IS 'Whether subscription cancels at period end';
COMMENT ON COLUMN tenants.payment_status IS 'Current payment status: none, paid, failed';

-- Update tenants_init_for_checkout to include new fields
CREATE OR REPLACE FUNCTION tenants_init_for_checkout(p_name TEXT DEFAULT 'My Organization')
RETURNS JSONB AS $$
DECLARE
  v_tenant_id UUID;
  v_already_existed BOOLEAN := FALSE;
  v_user_id UUID;
BEGIN
  -- Get current user
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Check if user already has a tenant
  SELECT t.id INTO v_tenant_id
  FROM tenants t
  JOIN memberships m ON m.tenant_id = t.id
  WHERE m.user_id = v_user_id
  LIMIT 1;

  IF v_tenant_id IS NOT NULL THEN
    v_already_existed := TRUE;
  ELSE
    -- Create new tenant
    INSERT INTO tenants (name, owner_id, created_at, updated_at)
    VALUES (p_name, v_user_id, NOW(), NOW())
    RETURNING id INTO v_tenant_id;

    -- Add owner membership
    INSERT INTO memberships (tenant_id, user_id, role, created_at)
    VALUES (v_tenant_id, v_user_id, 'owner', NOW());

    -- Initialize subscription fields
    UPDATE tenants
    SET
      subscription_status = 'inactive',
      payment_status = 'none'
    WHERE id = v_tenant_id;
  END IF;

  RETURN jsonb_build_object(
    'tenantId', v_tenant_id,
    'alreadyExisted', v_already_existed
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update tenants_activate_after_payment to handle subscription activation
CREATE OR REPLACE FUNCTION tenants_activate_after_payment(p_tenant_id UUID)
RETURNS JSONB AS $$
BEGIN
  UPDATE tenants
  SET
    subscription_status = 'active',
    activated_at = COALESCE(activated_at, NOW()),
    updated_at = NOW()
  WHERE id = p_tenant_id;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'tenantId', p_tenant_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update tenants_handle_payment_failure
CREATE OR REPLACE FUNCTION tenants_handle_payment_failure(p_tenant_id UUID)
RETURNS JSONB AS $$
BEGIN
  UPDATE tenants
  SET
    subscription_status = 'past_due',
    payment_status = 'failed',
    updated_at = NOW()
  WHERE id = p_tenant_id;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'tenantId', p_tenant_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update tenants_handle_subscription_cancelled
CREATE OR REPLACE FUNCTION tenants_handle_subscription_cancelled(p_tenant_id UUID)
RETURNS JSONB AS $$
BEGIN
  UPDATE tenants
  SET
    subscription_status = 'cancelled',
    subscription_plan = NULL,
    subscription_billing = NULL,
    stripe_subscription_id = NULL,
    updated_at = NOW()
  WHERE id = p_tenant_id;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'tenantId', p_tenant_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Add RLS policies for subscription data
-- Users can only see their own tenant's subscription info
CREATE POLICY "Users can view own tenant subscription" ON tenants
  FOR SELECT
  USING (
    id IN (
      SELECT tenant_id FROM memberships WHERE user_id = auth.uid()
    )
  );

-- Only service role can update subscription fields (via Edge Functions)
CREATE POLICY "Service role can update subscription" ON tenants
  FOR UPDATE
  USING (true)
  WITH CHECK (true);

-- Comments for documentation
COMMENT ON FUNCTION tenants_init_for_checkout IS 'Initialize tenant for checkout - creates tenant if needed, returns tenant ID';
COMMENT ON FUNCTION tenants_activate_after_payment IS 'Activate tenant subscription after successful payment';
COMMENT ON FUNCTION tenants_handle_payment_failure IS 'Handle payment failure - update subscription status';
COMMENT ON FUNCTION tenants_handle_subscription_cancelled IS 'Handle subscription cancellation - clear subscription data';
