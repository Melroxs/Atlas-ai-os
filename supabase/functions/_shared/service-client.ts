// ---------------------------------------------------------------------------
// Atlas Edge Functions — service-role client + platform role lookup
//
// The Stripe functions need the service role for exactly two things:
//   * reading/writing public.organization_subscriptions (revoked from client
//     roles) and the webhook ledger tables,
//   * resolving a caller's platform_role for the billing authorization check.
//
// The key is read from the environment (SUPABASE_SECRET_KEYS JSON, or the
// legacy SUPABASE_SERVICE_ROLE_KEY) and never leaves the function.
// ---------------------------------------------------------------------------

import { createClient } from "jsr:@supabase/supabase-js@2";

export function atlasServiceRoleKey(): string {
  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    try {
      const parsed = JSON.parse(secretKeys) as Record<string, string>;
      const key = parsed.default ?? parsed.service_role ?? "";
      if (key) return key;
    } catch {
      // fall through to the legacy variable
    }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

/** Service-role Supabase client (auth sessions are never persisted). */
export function atlasServiceClient() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = atlasServiceRoleKey();
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Platform role from public.profiles (super_admin | atlas_admin | customer_* |
 * pilot_user | user). Null when unknown — callers must fail closed.
 */
export async function resolvePlatformRole(userId: string): Promise<string | null> {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = atlasServiceRoleKey();
  if (!url || !key) return null;

  const query =
    `${url}/rest/v1/profiles` +
    `?select=platform_role` +
    `&_id=eq.${encodeURIComponent(userId)}` +
    `&limit=1`;
  try {
    const response = await fetch(query, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!response.ok) return null;
    const rows = (await response.json()) as Array<Record<string, unknown>>;
    const role = rows[0]?.platform_role;
    return typeof role === "string" ? role : null;
  } catch {
    return null;
  }
}

/** Workspace roles that may purchase or manage Atlas billing. */
export const ATLAS_BILLING_ROLES = ["owner", "admin"];

/** Platform roles that may manage any organization's billing (support). */
export const ATLAS_BILLING_PLATFORM_ROLES = ["super_admin", "atlas_admin"];

/**
 * Whether the caller may purchase / manage billing for their organization.
 *
 * FAIL-CLOSED: an unknown role is never authorized. The database and Edge
 * Functions remain the authority; the client cannot influence this value.
 */
export async function canManageAtlasBilling(input: {
  userId: string;
  role: string | null;
}): Promise<boolean> {
  const role = (input.role ?? "").trim().toLowerCase();
  if (ATLAS_BILLING_ROLES.includes(role)) return true;
  const platformRole = await resolvePlatformRole(input.userId);
  if (platformRole && ATLAS_BILLING_PLATFORM_ROLES.includes(platformRole.toLowerCase())) {
    return true;
  }
  return false;
}
