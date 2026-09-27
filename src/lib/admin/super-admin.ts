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
//   ACTIVE PAID STRIPE ACCESS  OR  ACTIVE COMPLIMENTARY ACCESS  =  ACCESS
// Complimentary is independent of Stripe: a Stripe cancellation / payment
// failure / pause / trial state must never revoke it.

export interface EffectiveAccessInput {
  subscriptionStatus: string | null | undefined; // organization_subscriptions.status
  complimentaryGrant: GrantLike | null | undefined; // resolved active grant
  tenantBillingState: string | null | undefined; // tenants.billing_state (Stripe-driven)
  nowMs: number;
}

export interface EffectiveAccess {
  allowed: boolean;
  /** effective billing_state the frontend gate sees */
  billingState: string | null;
  source: "stripe" | "complimentary" | null;
}

export function computeEffectiveAccess(input: EffectiveAccessInput): EffectiveAccess {
  const subActive = input.subscriptionStatus === "active" || input.subscriptionStatus === "trialing";
  const compActive = complimentaryGrantStatus(input.complimentaryGrant, input.nowMs) === "active";

  if (compActive) {
    return { allowed: true, billingState: "active", source: "complimentary" };
  }
  if (subActive) {
    return { allowed: true, billingState: "active", source: "stripe" };
  }
  // No entitlement: surface the Stripe-driven tenant state (fail-closed for
  // anything unknown). past_due remains a grace-period allow like before.
  const state = input.tenantBillingState ?? null;
  return {
    allowed: state === "active" || state === "past_due",
    billingState: state,
    source: null,
  };
}

// ---------------------------------------------------------------------------
// Free Pilot organizations
// ---------------------------------------------------------------------------
// A Free Pilot organization is an ordinary tenant whose entitlement is the
// existing complimentary_access grant. `free_pilot` is the ACCOUNT TYPE (an
// internal administrative classification); complimentary_access is the
// ENTITLEMENT. They are related but not the same thing, and both are needed:
// an organization stays a pilot while it is suspended or expired, and the
// grant is what actually grants access.
//
// A pilot has NO Stripe customer, NO Stripe subscription, NO invoice and NO
// payment record. It is never a fake subscription.

export const PILOT_ACCOUNT_TYPES = ["standard", "free_pilot"] as const;
export type PilotAccountType = (typeof PILOT_ACCOUNT_TYPES)[number];

/**
 * Derived pilot lifecycle state. Mirrors `atlas_pilot_status(...)` in
 * 20260927_atlas_pilot_organizations.sql exactly — the database is the
 * authority and this is for display only.
 */
export const PILOT_STATUSES = [
  "standard",
  "active",
  "expired",
  "suspended",
  "converted",
] as const;
export type PilotStatus = (typeof PILOT_STATUSES)[number];

export interface PilotTenantLike {
  account_type?: string | null;
  pilot_converted_at?: number | null;
}

/** Human labels for the internal admin view. */
export const PILOT_STATUS_LABELS: Record<PilotStatus, string> = {
  standard: "Standard",
  active: "Active",
  expired: "Expired",
  suspended: "Suspended",
  converted: "Converted to paid",
};

/**
 * Compute the pilot status for an organization. `grant` is the active
 * organization-wide grant, if any.
 */
export function computePilotStatus(
  tenant: PilotTenantLike | null | undefined,
  grant: GrantLike | null | undefined,
  nowMs: number,
): PilotStatus {
  if (!tenant || tenant.account_type !== "free_pilot") return "standard";
  if (tenant.pilot_converted_at != null) return "converted";
  const grantStatus = complimentaryGrantStatus(grant, nowMs);
  if (grantStatus === "revoked") return "suspended";
  if (grantStatus === "expired") return "expired";
  return "active";
}

/** Only an active pilot confers access. */
export function isPilotActive(status: PilotStatus): boolean {
  return status === "active";
}

/** True when the organization is a pilot in any lifecycle state. */
export function isPilotOrganization(tenant: PilotTenantLike | null | undefined): boolean {
  return tenant?.account_type === "free_pilot";
}

/**
 * Display string for a pilot's expiration. `null` means no expiration, which
 * is intentional — never an arbitrary far-future date.
 */
export function formatPilotExpiration(expiresAt: number | null | undefined): string {
  if (expiresAt == null) return "Never";
  return new Date(expiresAt).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Pilot expiration input
// ---------------------------------------------------------------------------

export interface ParsedPilotExpiration {
  ok: boolean;
  /** epoch ms, or null for "no expiration" */
  expiresAt: number | null;
  error?: string;
}

/**
 * Parse the expiration the super admin typed.
 *
 * Empty input means NO EXPIRATION (a pilot that stays active until revoked) —
 * that is a legitimate choice, not an error. A supplied date must be a real
 * date in the future; a past date is rejected here and again in SQL, because
 * granting an already-expired entitlement is always a mistake.
 */
export function parsePilotExpiration(input: string | null | undefined, nowMs: number): ParsedPilotExpiration {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: true, expiresAt: null };

  // Accept YYYY-MM-DD (a `<input type="date">` value) as end-of-day local so
  // the pilot is not expired by timezone drift on the chosen date.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const ms = dateOnly
    ? new Date(`${raw}T23:59:59.999Z`).getTime()
    : new Date(raw).getTime();

  if (!Number.isFinite(ms)) {
    return { ok: false, expiresAt: null, error: "Enter a valid date (YYYY-MM-DD)." };
  }
  if (ms <= nowMs) {
    return { ok: false, expiresAt: null, error: "The pilot expiration must be in the future." };
  }
  return { ok: true, expiresAt: ms };
}

// ---------------------------------------------------------------------------
// Pilot limits — RESERVED CONFIGURATION, NOT ENFORCED
// ---------------------------------------------------------------------------
// Atlas's only usage/limit system is plan-based: `plan_seat_limits` +
// `org_seat_status` (seats) and the advertised per-plan storage allowance.
// A Free Pilot organization holds an active `complimentary_access` grant, and
// `org_seat_status` intentionally BYPASSES plan limits for complimentary
// access — so a pilot tests the REAL product, uncrippled.
//
// `pilot_limits` therefore must NOT be presented as an enforceable limit: no
// gate, worker, RPC or UI consults it. It is reserved metadata only. Any limit
// left set is stored on the tenant and echoed back to the super-admin view,
// but it changes nothing. Do not add invented caps to a pilot to make this
// surface "work" — that would contradict the Free Pilot objective.

export const PILOT_LIMIT_KEYS = ["claims", "storageMb", "teamMembers", "aiRuns"] as const;
export type PilotLimitKey = (typeof PILOT_LIMIT_KEYS)[number];

export interface PilotLimits {
  claims?: number;
  storageMb?: number;
  teamMembers?: number;
  aiRuns?: number;
}

/**
 * Normalize RESERVED pilot-limit metadata (non-positive / non-numeric entries
 * dropped; `null` = unrestricted). This does not enforce anything — see the
 * section note above. Exposed for tests and future, deliberate use only.
 */
export function normalizePilotLimits(input: Record<string, unknown> | null | undefined): PilotLimits | null {
  if (!input || typeof input !== "object") return null;
  const out: PilotLimits = {};
  for (const key of PILOT_LIMIT_KEYS) {
    const raw = input[key];
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(n) && n > 0) out[key] = Math.trunc(n);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Human description of a pilot's limit posture for the internal admin view.
 * Always truthful: Free Pilot organizations are intentionally unrestricted,
 * regardless of any reserved `pilot_limits` metadata that may be stored.
 */
export function describePilotLimits(): string {
  return "Unrestricted — full product (complimentary access bypasses plan limits)";
}

// ---------------------------------------------------------------------------
// Internal billing description
// ---------------------------------------------------------------------------

export interface PilotBillingLike {
  has_stripe_subscription?: boolean | null;
  has_stripe_customer?: boolean | null;
  status?: string | null;
}

/**
 * Internal-only billing description for the super-admin view. Never shown to
 * pilot users, who simply see the normal Atlas product.
 */
export function describePilotBilling(billing: PilotBillingLike | null | undefined): string {
  if (!billing || !billing.has_stripe_subscription) {
    return "No Stripe subscription";
  }
  return billing.status ? `Stripe: ${billing.status}` : "Stripe subscription";
}