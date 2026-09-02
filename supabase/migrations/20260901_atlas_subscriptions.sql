-- Atlas Subscriptions Migration
-- Adds billing infrastructure for the commercial SaaS model:
--   - plans: server-controlled plan definitions (not hardcoded in frontend)
--   - stripe_customers: maps Supabase users to Stripe customers
--   - subscriptions: tracks active subscriptions per user/tenant
--
-- RLS policies ensure users can only see their own subscription data.
-- Super admins can view all subscriptions for support purposes.

-- ---------------------------------------------------------------------------
-- Plans table — server-controlled pricing catalog
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  stripe_price_id_monthly TEXT,
  stripe_price_id_annual TEXT,
  features JSONB DEFAULT '[]'::jsonb,
  is_active BOOLEAN DEFAULT true,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Stripe customers table — maps Supabase users to Stripe customer IDs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stripe_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ensure one Stripe customer per user
CREATE UNIQUE INDEX IF NOT EXISTS idx_stripe_customers_user_id ON public.stripe_customers(user_id);

-- ---------------------------------------------------------------------------
-- Subscriptions table — tracks subscription state per user/tenant
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id UUID,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT UNIQUE,
  stripe_price_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  plan_name TEXT NOT NULL DEFAULT 'starter',
  billing_interval TEXT NOT NULL DEFAULT 'monthly',
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for lookups by user
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON public.subscriptions(user_id);
-- Index for lookups by Stripe subscription ID (for webhook processing)
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_id ON public.subscriptions(stripe_subscription_id);
-- Index for lookups by tenant
CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant_id ON public.subscriptions(tenant_id);

-- ---------------------------------------------------------------------------
-- RLS policies
-- ---------------------------------------------------------------------------

-- Plans: all authenticated users can read active plans (public catalog)
ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "plans_select_authenticated" ON public.plans
  FOR SELECT TO authenticated USING (is_active = true);

-- Plans: super_admin can manage plans
CREATE POLICY "plans_manage_super_admin" ON public.plans
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles._id = auth.uid()
      AND profiles.platform_role = 'super_admin'
    )
  );

-- Stripe customers: users can only see their own
ALTER TABLE public.stripe_customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "stripe_customers_select_own" ON public.stripe_customers
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Stripe customers: super_admin can view all (for support)
CREATE POLICY "stripe_customers_select_admin" ON public.stripe_customers
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles._id = auth.uid()
      AND profiles.platform_role = 'super_admin'
    )
  );

-- Subscriptions: users can only see their own
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "subscriptions_select_own" ON public.subscriptions
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Subscriptions: super_admin can view all (for support)
CREATE POLICY "subscriptions_select_admin" ON public.subscriptions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles._id = auth.uid()
      AND profiles.platform_role = 'super_admin'
    )
  );

-- ---------------------------------------------------------------------------
-- Seed default plans
-- ---------------------------------------------------------------------------
INSERT INTO public.plans (id, name, description, features, sort_order) VALUES
  ('starter', 'Starter', 'For small teams getting started with intelligence.',
   '["Up to 5 team members", "10 GB document storage", "Basic AI intelligence", "Email support", "Single organization"]'::jsonb,
   1),
  ('professional', 'Professional', 'For growing teams that need full intelligence capabilities.',
   '["Up to 25 team members", "100 GB document storage", "Advanced AI intelligence", "Priority support", "Multiple organizations", "Custom workflows", "API access"]'::jsonb,
   2),
  ('enterprise', 'Enterprise', 'For large organizations with custom requirements.',
   '["Unlimited team members", "Unlimited document storage", "Enterprise AI intelligence", "Dedicated support", "Custom integrations", "SSO & advanced security", "SLA guarantee", "Custom deployment"]'::jsonb,
   3)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  features = EXCLUDED.features,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();
