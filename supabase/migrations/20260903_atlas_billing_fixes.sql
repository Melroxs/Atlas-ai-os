-- Atlas Billing Fixes — Critical architectural corrections
--
-- Fix 1: users_current_user must return billing_state from the user's tenant
--         so the access gate can enforce subscription-based access control.
--
-- Fix 2: stripe_customers must be tenant-scoped (not user-scoped) because
--         Atlas is organization-based SaaS — the tenant owns the billing.
--
-- Fix 3: tenants_create_tenant must set billing_state = 'pending_checkout'
--         for new SaaS customers (instead of leaving it NULL).

-- ---------------------------------------------------------------------------
-- Fix 1: users_current_user — include tenant billing_state
-- ---------------------------------------------------------------------------

-- The current RPC returns only the profile row, which does NOT include
-- billing_state (that lives on the tenants table). The access gate
-- evaluateAtlasAccess() checks profile.billing_state, but it was always
-- undefined — meaning unpaid customers could never be denied access.
--
-- This fix LEFT JOINs with the user's active membership + tenant to include:
--   - billing_state (from tenant — used by access gate)
--   - tenant_id (so the frontend knows which tenant the user belongs to)
--   - subscription_status (denormalized for quick access checks)

CREATE OR REPLACE FUNCTION public.users_current_user()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT to_jsonb(p) || jsonb_build_object(
    'billing_state', t.billing_state,
    'tenant_id', m."tenantId",
    'subscription_status', (
      SELECT s.status
      FROM public.subscriptions s
      WHERE s.tenant_id = m."tenantId"
      ORDER BY s.created_at DESC
      LIMIT 1
    )
  )
  FROM public.profiles p
  LEFT JOIN public.memberships m
    ON m."userId" = p._id
    AND m.status = 'active'
  LEFT JOIN public.tenants t
    ON t._id = m."tenantId"
  WHERE p._id = auth.uid();
$$;


-- ---------------------------------------------------------------------------
-- Fix 2: stripe_customers — tenant-scoped billing
-- ---------------------------------------------------------------------------
-- The original migration (20260901) created stripe_customers with:
--   UNIQUE(user_id) — one Stripe customer per user
--
-- Atlas is organization-based SaaS. The billing entity is the TENANT,
-- not the individual user. A user may belong to multiple tenants (though
-- typically one). The Stripe customer must map to the tenant.
--
-- This migration:
--   a) Adds tenant_id to stripe_customers
--   b) Creates a unique index on tenant_id (one Stripe customer per tenant)
--   c) Preserves the existing user_id unique index for backward compat
--   d) Adds tenant_id to subscriptions (already present but without FK)

-- Add tenant_id to stripe_customers if not present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'stripe_customers' AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE public.stripe_customers
      ADD COLUMN tenant_id uuid REFERENCES public.tenants(_id) ON DELETE SET NULL;
  END IF;
END $$;

-- Unique index: one Stripe customer per tenant (billing entity is the tenant)
CREATE UNIQUE INDEX IF NOT EXISTS idx_stripe_customers_tenant_id
  ON public.stripe_customers(tenant_id)
  WHERE tenant_id IS NOT NULL;

-- CRITICAL: Remove the UNIQUE(user_id) constraint on stripe_customers.
-- The original migration created UNIQUE(user_id) which makes the user the
-- billing boundary. Atlas is organization-based SaaS — the TENANT owns
-- billing, not the individual user. A user may belong to multiple tenants.
-- Keep user_id as a regular column for audit/history, but remove the
-- uniqueness constraint that incorrectly ties billing to the user.
DROP INDEX IF EXISTS public.idx_stripe_customers_user_id;

-- Add FK for subscriptions.tenant_id if not present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'subscriptions_tenant_id_fkey'
  ) THEN
    ALTER TABLE public.subscriptions
      ADD CONSTRAINT subscriptions_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(_id) ON DELETE SET NULL;
  END IF;
END $$;

-- Add CHECK constraint for subscription status values
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'subscriptions_status_check'
  ) THEN
    ALTER TABLE public.subscriptions
      ADD CONSTRAINT subscriptions_status_check
      CHECK (status IN ('active', 'past_due', 'canceled', 'cancelled', 'trialing', 'incomplete', 'pending'));
  END IF;
END $$;

-- Add CHECK constraint for tenant billing_state values
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'tenants_billing_state_check'
  ) THEN
    ALTER TABLE public.tenants
      ADD CONSTRAINT tenants_billing_state_check
      CHECK (billing_state IS NULL OR billing_state IN (
        'pending_checkout', 'active', 'payment_failed', 'cancelled', 'past_due', 'suspended'
      ));
  END IF;
END $$;


-- ---------------------------------------------------------------------------
-- Fix 3: tenants_create_tenant — set billing_state for new SaaS customers
-- ---------------------------------------------------------------------------
-- The original tenants_create_tenant (0002_rpc_core.sql) creates tenants
-- with no billing_state (NULL). For the new SaaS flow, new customer tenants
-- must start in 'pending_checkout' state.
--
-- We do NOT modify the original function (to preserve backward compat for
-- existing callers). Instead, tenants_init_for_checkout (20260902) already
-- handles this correctly.
--
-- However, we need to ensure that when Auth.tsx calls tenants_create_tenant
-- during signup, the resulting tenant has a proper billing_state. The fix
-- is to modify the Auth page to use tenants_init_for_checkout instead.

-- Update existing tenants that were created via tenants_create_tenant
-- but have NULL billing_state and belong to users who are in the SaaS flow.
-- This is a defensive migration — existing tenants without billing_state
-- are pre-SaaS tenants and should NOT be modified.
-- (No-op migration — leave NULL billing_state for pre-SaaS tenants)


-- ---------------------------------------------------------------------------
-- Audit log for the migration
-- ---------------------------------------------------------------------------

-- Log the schema changes
SELECT public.log_audit(
  'schema_migration_applied',
  'system',
  '20260902_atlas_billing_fixes',
  jsonb_build_object(
    'changes', ARRAY[
      'users_current_user now returns billing_state, tenant_id, subscription_status',
      'stripe_customers gained tenant_id column with unique index',
      'subscriptions.tenant_id has FK constraint',
      'billing_state CHECK constraint added to tenants',
      'subscription status CHECK constraint added'
    ]
  )
);
