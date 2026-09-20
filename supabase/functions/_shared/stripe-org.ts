// ---------------------------------------------------------------------------
// Atlas — organization billing helpers (Stripe)
//
// Shared by stripe-checkout and stripe-customer-portal. Owns the rule that an
// Atlas organization has AT MOST ONE Stripe customer:
//
//   1. read the stored organization_subscriptions row
//   2. reuse the stored Stripe customer when it still exists in this Stripe
//      environment (a customer id from a test account is never reused in live)
//   3. otherwise create one and persist it immediately
//
// A new Stripe customer is never created per checkout attempt, and no Stripe
// customer id is ever accepted from the browser.
// ---------------------------------------------------------------------------

import {
  type StripeCustomer,
  createStripeCustomer,
  fetchStripeCustomer,
  stripeEnvironment,
} from "./stripe.ts";
import { SUBSCRIPTION_COLUMNS, rowFromDb } from "./stripe-rows.ts";
import type { SubscriptionRow } from "./stripe-webhook.ts";

/** Minimal structural view of the Supabase client (keeps this module testable). */
export interface OrgBillingClient {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
      };
    };
    upsert(
      values: Record<string, unknown>,
      options?: { onConflict?: string },
    ): PromiseLike<{ error: { message?: string } | null }>;
  };
}

/** Load the organization's billing row (null when the org has none yet). */
export async function loadOrgSubscription(
  client: OrgBillingClient,
  organizationId: string,
): Promise<SubscriptionRow | null> {
  const { data, error } = await client
    .from("organization_subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw new Error(`subscription load failed: ${error.message ?? "unknown"}`);
  return data ? rowFromDb(data as Record<string, unknown>) : null;
}

/** Persist the Stripe customer id for an organization (atomic upsert by org). */
export async function persistOrgCustomer(
  client: OrgBillingClient,
  organizationId: string,
  customerId: string,
): Promise<void> {
  const { error } = await client
    .from("organization_subscriptions")
    .upsert(
      {
        organization_id: organizationId,
        billing_provider: "stripe",
        provider_customer_id: customerId,
        updated_at: Date.now(),
      },
      { onConflict: "organization_id" },
    );
  if (error) throw new Error(`customer persist failed: ${error.message ?? "unknown"}`);
}

export interface EnsureCustomerResult {
  customerId: string;
  created: boolean;
  /** True when a stored id was discarded because it no longer exists in Stripe. */
  staleIdReplaced: boolean;
}

/**
 * Resolve the Stripe customer for an organization, creating it once.
 *
 * `metadata.atlas_org_id` + `atlas_environment` are attached at creation so
 * every future webhook can attribute the customer without guessing; the
 * environment marker prevents a test-mode customer id from being reused
 * against a live account and vice versa.
 */
export async function ensureStripeCustomer(
  client: OrgBillingClient,
  input: {
    organizationId: string;
    existingCustomerId: string | null;
    email?: string | null;
    name?: string | null;
  },
): Promise<EnsureCustomerResult> {
  if (input.existingCustomerId) {
    const existing: StripeCustomer | null = await fetchStripeCustomer(
      input.existingCustomerId,
    );
    if (existing && !existing.deleted) {
      return { customerId: existing.id, created: false, staleIdReplaced: false };
    }
  }

  const created = await createStripeCustomer({
    organizationId: input.organizationId,
    email: input.email ?? null,
    name: input.name ?? null,
  });

  await persistOrgCustomer(client, input.organizationId, created.id);

  console.info("[stripe] customer resolved", {
    organization_id: input.organizationId,
    stripe_customer_id: created.id,
    environment: stripeEnvironment(),
    created: true,
  });

  return {
    customerId: created.id,
    created: true,
    staleIdReplaced: Boolean(input.existingCustomerId),
  };
}
