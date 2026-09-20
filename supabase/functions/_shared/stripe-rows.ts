// ---------------------------------------------------------------------------
// Atlas — organization_subscriptions row mapping (pure, dependency-free)
//
// One definition of the column list and the camelCase <-> column mapping used
// by every Stripe function. Pure functions only: no Deno.env, no network, so
// this module is directly unit-testable.
// ---------------------------------------------------------------------------

import type { SubscriptionRow } from "./stripe-webhook.ts";

export const SUBSCRIPTION_COLUMNS =
  "organization_id, billing_provider, provider_customer_id, provider_subscription_id, " +
  "provider_price_id, internal_plan, billing_interval, status, payment_status, " +
  "trial_start, trial_end, current_period_start, current_period_end, next_billed_at, " +
  "cancel_at, cancel_at_period_end, canceled_at, latest_invoice_id, latest_invoice_at, " +
  "provider_event_at, created_at, updated_at";

/** Database row ➜ processor row. Missing columns fall back to safe defaults. */
export function rowFromDb(row: Record<string, unknown>): SubscriptionRow {
  const now = Date.now();
  return {
    organizationId: String(row.organization_id),
    billingProvider: "stripe",
    providerCustomerId: (row.provider_customer_id as string | null) ?? null,
    providerSubscriptionId: (row.provider_subscription_id as string | null) ?? null,
    providerPriceId: (row.provider_price_id as string | null) ?? null,
    internalPlan: (row.internal_plan as SubscriptionRow["internalPlan"]) ?? null,
    billingInterval: (row.billing_interval as SubscriptionRow["billingInterval"]) ?? null,
    status: (row.status as SubscriptionRow["status"]) ?? "unknown",
    paymentStatus: (row.payment_status as SubscriptionRow["paymentStatus"]) ?? "unknown",
    trialStart: (row.trial_start as number | null) ?? null,
    trialEnd: (row.trial_end as number | null) ?? null,
    currentPeriodStart: (row.current_period_start as number | null) ?? null,
    currentPeriodEnd: (row.current_period_end as number | null) ?? null,
    nextBilledAt: (row.next_billed_at as number | null) ?? null,
    cancelAt: (row.cancel_at as number | null) ?? null,
    cancelAtPeriodEnd: row.cancel_at_period_end === true,
    canceledAt: (row.canceled_at as number | null) ?? null,
    latestInvoiceId: (row.latest_invoice_id as string | null) ?? null,
    latestInvoiceAt: (row.latest_invoice_at as number | null) ?? null,
    providerEventAt: (row.provider_event_at as number | null) ?? null,
    createdAt: (row.created_at as number | null) ?? now,
    updatedAt: (row.updated_at as number | null) ?? now,
  };
}

/** Processor row ➜ database row. */
export function rowToDb(row: SubscriptionRow): Record<string, unknown> {
  return {
    organization_id: row.organizationId,
    billing_provider: "stripe",
    provider_customer_id: row.providerCustomerId,
    provider_subscription_id: row.providerSubscriptionId,
    provider_price_id: row.providerPriceId,
    internal_plan: row.internalPlan,
    billing_interval: row.billingInterval,
    status: row.status,
    payment_status: row.paymentStatus,
    trial_start: row.trialStart,
    trial_end: row.trialEnd,
    current_period_start: row.currentPeriodStart,
    current_period_end: row.currentPeriodEnd,
    next_billed_at: row.nextBilledAt,
    cancel_at: row.cancelAt,
    cancel_at_period_end: row.cancelAtPeriodEnd,
    canceled_at: row.canceledAt,
    latest_invoice_id: row.latestInvoiceId,
    latest_invoice_at: row.latestInvoiceAt,
    provider_event_at: row.providerEventAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}
