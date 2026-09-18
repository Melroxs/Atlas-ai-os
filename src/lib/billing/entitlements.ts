// ---------------------------------------------------------------------------
// Atlas Billing — Plan Entitlements (runtime access)
//
// `plans.ts` defines the entitlement contract and the seat limits. This module
// is the runtime path to it:
//
//   * `resolveOrgEntitlements(billing)` — maps a resolved billing state onto the
//     plan's entitlements (the runtime caller PLAN_ENTITLEMENTS was missing).
//   * `fetchSeatStatus(client, tenantId)` — reads the SERVER-AUTHORITATIVE seat
//     status (`org_seat_status` RPC, added in
//     20260918_atlas_security_hardening.sql). Seat enforcement itself happens
//     server-side: the limits live in `plan_seat_limits` and the
//     `admin-provision-user` Edge Function refuses to over-provision. This
//     client helper exists to display usage and pre-flight messages — it is
//     never the enforcement point, and it fails closed.
//   * `evaluateSeatCapacity(...)` — pure capacity math shared by UI and tests.
//
// SECURITY: nothing here is an authorization decision. The database (RLS +
// SECURITY DEFINER RPCs) and the Edge Functions authorize.
// ---------------------------------------------------------------------------

import type { BillingState, InternalPlan } from "./types";
import {
  PLAN_ENTITLEMENTS,
  resolvePlanEntitlements,
  type PlanEntitlements,
} from "./plans";

// ---------------------------------------------------------------------------
// Seat status (mirrors public.org_seat_status)
// ---------------------------------------------------------------------------

export type SeatStatusReason =
  | "super_admin"
  | "complimentary"
  | "within_limit"
  | "seat_limit_reached"
  | "unlimited"
  | "no_plan"
  | "not_a_member";

export interface SeatStatus {
  plan: InternalPlan | null;
  used: number;
  /** null = unlimited. */
  limit: number | null;
  /** null = unlimited. */
  remaining: number | null;
  allowed: boolean;
  reason: SeatStatusReason;
}

const SEAT_REASONS: SeatStatusReason[] = [
  "super_admin",
  "complimentary",
  "within_limit",
  "seat_limit_reached",
  "unlimited",
  "no_plan",
  "not_a_member",
];

/** Reasons that must never be read as an allowance, even if `allowed` is true. */
const DENIAL_REASONS: SeatStatusReason[] = [
  "seat_limit_reached",
  "no_plan",
  "not_a_member",
];

/**
 * Parse the `org_seat_status` payload, FAIL-CLOSED.
 *
 * Anything unrecognised (null payload, unknown reason, non-boolean `allowed`)
 * resolves to a denied status: a malformed or hostile server response must never
 * unlock provisioning.
 */
export function normalizeSeatStatus(raw: unknown): SeatStatus {
  const denied: SeatStatus = {
    plan: null,
    used: 0,
    limit: null,
    remaining: null,
    allowed: false,
    reason: "no_plan",
  };

  if (!raw || typeof raw !== "object") return denied;
  const o = raw as Record<string, unknown>;

  const reason =
    typeof o.reason === "string" && (SEAT_REASONS as string[]).includes(o.reason)
      ? (o.reason as SeatStatusReason)
      : null;
  if (!reason) return denied;

  return {
    plan: typeof o.plan === "string" ? (o.plan as InternalPlan) : null,
    used: typeof o.used === "number" && Number.isFinite(o.used) ? o.used : 0,
    limit: typeof o.limit === "number" ? o.limit : null,
    remaining: typeof o.remaining === "number" ? o.remaining : null,
    // The reason and the flag must agree; a denial reason always wins.
    allowed: o.allowed === true && !DENIAL_REASONS.includes(reason),
    reason,
  };
}

/** Pure seat-capacity math. `null` limit means unlimited. */
export function evaluateSeatCapacity(input: {
  maxSeats: number | null;
  used: number;
}): { allowed: boolean; remaining: number | null } {
  const used = Math.max(0, input.used);

  if (input.maxSeats === null) {
    return { allowed: true, remaining: null };
  }
  const remaining = input.maxSeats - used;
  return { allowed: remaining > 0, remaining: remaining < 0 ? 0 : remaining };
}

// ---------------------------------------------------------------------------
// Entitlement resolution (runtime caller for PLAN_ENTITLEMENTS)
// ---------------------------------------------------------------------------

/**
 * Resolve the organization's entitlements from its resolved billing state.
 *
 * Returns null when the organization is not on a paid/active plan, so callers
 * must treat null as "no entitlements" rather than defaulting to a plan.
 */
export function resolveOrgEntitlements(
  billing: Pick<BillingState, "canUsePaidFeatures" | "plan"> | null | undefined,
): PlanEntitlements | null {
  if (!billing || !billing.canUsePaidFeatures) return null;
  return resolvePlanEntitlements(billing.plan);
}

export type PlanFeature =
  | "apiAccess"
  | "sso"
  | "customWorkflows"
  | "multipleOrganizations"
  | "prioritySupport"
  | "sla";

/** FAIL-CLOSED feature gate. Server-side enforcement remains authoritative. */
export function canUseFeature(
  entitlements: PlanEntitlements | null,
  feature: PlanFeature,
): boolean {
  return entitlements ? entitlements[feature] === true : false;
}

/** The canonical entitlements for a plan (display + parity tests). */
export function planEntitlements(plan: InternalPlan): PlanEntitlements {
  return PLAN_ENTITLEMENTS[plan];
}

// ---------------------------------------------------------------------------
// Server-authoritative seat status
// ---------------------------------------------------------------------------

/** Minimal shape of the Supabase client we need (avoids a hard dependency). */
interface RpcClient {
  rpc(
    fn: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}

/**
 * Read the server-authoritative seat status for an organization.
 *
 * Fails closed on transport errors, so a network failure can never be read as
 * "seats available".
 */
export async function fetchSeatStatus(
  client: RpcClient | null | undefined,
  tenantId: string | null | undefined,
): Promise<SeatStatus> {
  if (!client || !tenantId) {
    return normalizeSeatStatus(null);
  }

  try {
    const { data, error } = await client.rpc("org_seat_status", {
      p_tenant: tenantId,
    });
    if (error) return normalizeSeatStatus(null);
    return normalizeSeatStatus(data);
  } catch {
    return normalizeSeatStatus(null);
  }
}
