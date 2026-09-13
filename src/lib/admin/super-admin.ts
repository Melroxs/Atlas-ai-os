/**
 * Super Admin / complimentary-access decision logic.
 *
 * Node-side mirror of the rules enforced server-side by:
 *   - the admin-provision-user Edge Function (super_admin gate),
 *   - the admin_* RPCs in 20260909_atlas_complimentary_access.sql
 *     (is_super_admin() checks),
 *   - users_current_user / billing_get_state (effective access computation).
 *
 * These pure functions are the testable contract. The server remains the
 * authority — this module is never the enforcement point.
 */

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

export interface ActorLike {
  platform_role?: string | null;
  account_status?: string | null;
}

/**
 * The server-side authorization gate for every admin action:
 * platform_role = 'super_admin' AND account_status = 'active'.
 * atlas_admin and normal members are NOT allowed (spec: only super_admin may
 * create organizations, invite/remove members, delete users, grant/revoke
 * complimentary access).
 */
export function canPerformSuperAdminAction(actor: ActorLike | null | undefined): boolean {
  return (
    actor?.platform_role === "super_admin" && actor?.account_status === "active"
  );
}

export const ORG_ROLES = ["owner", "admin", "manager", "analyst", "viewer"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const COMPLIMENTARY_DURATIONS = ["7d", "30d", "90d", "1y", "lifetime"] as const;
export type ComplimentaryDuration = (typeof COMPLIMENTARY_DURATIONS)[number];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Invite validation (mirrors handleInvite in the Edge Function)
// ---------------------------------------------------------------------------

export function validateInvite(params: {
  email: string;
  orgRole: string;
  tenantId: string;
}): { ok: true } | { ok: false; error: string } {
  const email = params.email.trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return { ok: false, error: "A valid email is required." };
  }
  if (!params.tenantId) {
    return { ok: false, error: "Organization is required." };
  }
  if (!(ORG_ROLES as readonly string[]).includes(params.orgRole)) {
    return {
      ok: false,
      error: "Organization role must be one of owner, admin, manager, analyst, viewer.",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Complimentary access durations (mirrors admin_grant_complimentary_access)
// ---------------------------------------------------------------------------
// Lifetime is represented as NO expiration (null), never a far-future date.

const DURATION_MS: Record<Exclude<ComplimentaryDuration, "lifetime">, number> = {
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
  "1y": 365 * 24 * 60 * 60 * 1000,
};

export interface ResolvedDuration {
  duration: ComplimentaryDuration;
  label: string;
  expiresAtMs: number | null; // null = lifetime
}

export function resolveComplimentaryDuration(
  duration: string,
  nowMs: number,
): ResolvedDuration | null {
  if (duration === "lifetime") {
    return { duration, label: "Lifetime", expiresAtMs: null };
  }
  const ms = DURATION_MS[duration as Exclude<ComplimentaryDuration, "lifetime">];
  if (ms === undefined) return null;
  return { duration: duration as ComplimentaryDuration, label: duration, expiresAtMs: nowMs + ms };
}

// ---------------------------------------------------------------------------
// Grant status (read-time computation; mirrors complimentary_get_my_org)
// ---------------------------------------------------------------------------

export interface GrantLike {
  status?: string | null;
  expires_at?: number | null;
}

export type GrantStatus = "active" | "expired" | "revoked";

export function complimentaryGrantStatus(grant: GrantLike | null | undefined, nowMs: number): GrantStatus {
  if (!grant) return "revoked";
  if (grant.status === "revoked") return "revoked";
  if (grant.expires_at != null && grant.expires_at <= nowMs) return "expired";
  return "active";
}

// ---------------------------------------------------------------------------
// Effective access (mirrors users_current_user / billing_get_state)
// ---------------------------------------------------------------------------
// The authoritative rule:
//   ACTIVE PAID PADDLE ACCESS  OR  ACTIVE COMPLIMENTARY ACCESS  =  ACCESS
// Complimentary is independent of Paddle: a Paddle cancellation / payment
// failure / pause / trial state must never revoke it.

export interface EffectiveAccessInput {
  subscriptionStatus: string | null | undefined; // organization_subscriptions.status
  complimentaryGrant: GrantLike | null | undefined; // resolved active grant
  tenantBillingState: string | null | undefined; // tenants.billing_state (Paddle-driven)
  nowMs: number;
}

export interface EffectiveAccess {
  allowed: boolean;
  /** effective billing_state the frontend gate sees */
  billingState: string | null;
  source: "paddle" | "complimentary" | null;
}

export function computeEffectiveAccess(input: EffectiveAccessInput): EffectiveAccess {
  const subActive = input.subscriptionStatus === "active" || input.subscriptionStatus === "trialing";
  const compActive = complimentaryGrantStatus(input.complimentaryGrant, input.nowMs) === "active";

  if (compActive) {
    return { allowed: true, billingState: "active", source: "complimentary" };
  }
  if (subActive) {
    return { allowed: true, billingState: "active", source: "paddle" };
  }
  // No entitlement: surface the Paddle-driven tenant state (fail-closed for
  // anything unknown). past_due remains a grace-period allow like before.
  const state = input.tenantBillingState ?? null;
  return {
    allowed: state === "active" || state === "past_due",
    billingState: state,
    source: null,
  };
}