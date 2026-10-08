// ---------------------------------------------------------------------------
// Atlas — organization billing helpers (Paystack)
//
// Paystack counterpart of _shared/stripe-org.ts. Owns the rule that an Atlas
// organization has AT MOST ONE Paystack customer:
//
//   1. read the stored organization_subscriptions row
//   2. reuse the stored Paystack customer code when it still exists
//      (a code from a test account is never reused in live — a fetch miss
//      falls through to lookup/create)
//   3. otherwise look up an existing customer by the AUTHENTICATED email
//   4. create only if neither found, persisting the code immediately
//
// A new Paystack customer is never created per checkout attempt, and no
// customer identity is ever accepted from the browser.
// ---------------------------------------------------------------------------

import type { OrgBillingClient } from "./stripe-org.ts";
import { fetchPaystackCustomer, createPaystackCustomer } from "./paystack.ts";

/** Minimal view of the organization's stored billing row (provider-neutral read). */
export interface PaystackOrgBilling {
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  status: string;
}

/**
 * Load the organization's stored billing identifiers.
 *
 * Reads only what the checkout guard and customer reuse need; the row may not
 * exist yet (first checkout) — that is null, not an error.
 */
export async function loadPaystackOrgBilling(
  client: OrgBillingClient,
  organizationId: string,
): Promise<PaystackOrgBilling | null> {
  const { data, error } = await client
    .from("organization_subscriptions")
    .select("provider_customer_id, provider_subscription_id, status")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw new Error(`billing load failed: ${error.message ?? "unknown"}`);
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return {
    providerCustomerId: (row.provider_customer_id as string | null) ?? null,
    providerSubscriptionId: (row.provider_subscription_id as string | null) ?? null,
    status: (row.status as string | null) ?? "unknown",
  };
}

/**
 * Persist the Paystack customer code for an organization (atomic upsert by
 * org, mirroring persistOrgCustomer). The organization's provider becomes
 * paystack at the moment the first Paystack checkout for it is prepared.
 */
export async function persistPaystackOrgCustomer(
  client: OrgBillingClient,
  organizationId: string,
  customerCode: string,
): Promise<void> {
  const { error } = await client
    .from("organization_subscriptions")
    .upsert(
      {
        organization_id: organizationId,
        billing_provider: "paystack",
        provider_customer_id: customerCode,
        updated_at: Date.now(),
      },
      { onConflict: "organization_id" },
    );
  if (error) throw new Error(`customer persist failed: ${error.message ?? "unknown"}`);
}

export interface EnsurePaystackCustomerResult {
  customerCode: string;
  created: boolean;
}

/**
 * Resolve the Paystack customer for an organization, creating it once.
 *
 * Identity comes from authenticated Atlas data (the caller's email from the
 * verified JWT) — never from a redirect parameter.
 */
export async function ensurePaystackCustomer(
  client: OrgBillingClient,
  input: {
    organizationId: string;
    existingCustomerId: string | null;
    email: string;
    name?: string | null;
  },
): Promise<EnsurePaystackCustomerResult> {
  // 1. Reuse the stored customer code when it still exists.
  if (input.existingCustomerId) {
    const stored = await fetchPaystackCustomer(input.existingCustomerId);
    if (stored) {
      return { customerCode: stored.code, created: false };
    }
  }

  // 2. Look up an existing customer by the authenticated email.
  const byEmail = await fetchPaystackCustomer(input.email);
  if (byEmail) {
    await persistPaystackOrgCustomer(client, input.organizationId, byEmail.code);
    console.info("[paystack] customer reused by email", {
      organization_id: input.organizationId,
      paystack_customer_code: byEmail.code,
      environment_test: true,
    });
    return { customerCode: byEmail.code, created: false };
  }

  // 3. Create exactly once and persist immediately.
  const name = (input.name ?? "").trim();
  const created = await createPaystackCustomer({
    email: input.email,
    firstName: name ? name.split(/\s+/)[0] : null,
    lastName: name && name.split(/\s+/).length > 1 ? name.split(/\s+/).slice(1).join(" ") : null,
    organizationId: input.organizationId,
  });
  await persistPaystackOrgCustomer(client, input.organizationId, created.code);

  console.info("[paystack] customer resolved", {
    organization_id: input.organizationId,
    paystack_customer_code: created.code,
    created: true,
  });

  return { customerCode: created.code, created: true };
}
