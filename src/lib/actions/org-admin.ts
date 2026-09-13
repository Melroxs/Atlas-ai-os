/**
 * Super Admin → organization/team administration client.
 *
 * Every operation is executed by the admin-provision-user Edge Function,
 * which verifies the caller is an authenticated super_admin inside the server
 * boundary. The browser never holds service-role or Resend credentials; it
 * only sends the caller's own Supabase JWT.
 *
 * The Edge Function enforces authorization — hiding buttons in the UI is a
 * convenience, never the security boundary.
 */
import { getSupabaseClient, resolvedSupabaseUrl } from "@/lib/supabase";

export type OrgRole = "owner" | "admin" | "manager" | "analyst" | "viewer";

export type ComplimentaryDuration = "7d" | "30d" | "90d" | "1y" | "lifetime";

export interface OrgMember {
  userId: string;
  role: string;
  status: string;
  joinedAt: number | null;
  profile: {
    _id: string;
    name: string | null;
    email: string | null;
    platform_role: string | null;
    account_status: string | null;
  } | null;
}

export interface ComplimentaryGrant {
  id: string;
  organization_id: string;
  user_id: string | null;
  granted_by: string | null;
  granted_at: number;
  expires_at: number | null;
  reason: string;
  status: "active" | "revoked";
  revoked_at: number | null;
  user_name?: string | null;
  user_email?: string | null;
}

export interface OrgAdminResult<T = Record<string, unknown>> {
  ok: boolean;
  error?: string;
  data?: T;
}

async function callAdminEdge<T = Record<string, unknown>>(
  action: string,
  payload: Record<string, unknown>,
): Promise<OrgAdminResult<T>> {
  const supabase = getSupabaseClient();
  if (!supabase) return { ok: false, error: "Supabase is not configured" };

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) return { ok: false, error: "Not authenticated" };

  const functionUrl = `${resolvedSupabaseUrl}/functions/v1/admin-provision-user`;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

  try {
    const response = await fetch(functionUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
        ...(anonKey ? { apikey: anonKey } : {}),
      },
      body: JSON.stringify({ action, ...payload }),
    });

    const result = await response.json().catch(() => null);

    if (!response.ok) {
      const serverError =
        result && typeof result === "object" && typeof result.error === "string"
          ? result.error
          : null;
      let reason: string;
      switch (response.status) {
        case 400:
          reason = serverError ?? "Invalid request";
          break;
        case 401:
          reason = "Your session has expired. Please sign in again.";
          break;
        case 403:
          reason = serverError ?? "You do not have permission to perform this action.";
          break;
        case 404:
          reason =
            "The admin service is not deployed yet (admin-provision-user Edge Function is missing). Contact your administrator.";
          break;
        default:
          reason = serverError ?? `Admin service error (HTTP ${response.status})`;
      }
      return { ok: false, error: reason };
    }

    if (result && typeof result === "object" && result.ok === false) {
      return {
        ok: false,
        error:
          typeof result.error === "string" ? result.error : "The admin service rejected the request.",
      };
    }

    return { ok: true, data: (result ?? {}) as T };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: /failed to fetch|networkerror|load failed/i.test(msg)
        ? `Could not reach the admin service (network or CORS blocked the request — check that the Edge Function is deployed and the origin is allowed): ${msg}`
        : msg,
    };
  }
}

export const orgAdmin = {
  createOrg: (name: string) =>
    callAdminEdge<{ tenant_id?: string }>("create_org", { name }),

  listOrgs: () =>
    callAdminEdge<{ organizations: Array<{ _id: string; name: string | null; member_count?: number }> }>(
      "list_orgs",
      {},
    ),

  listOrgMembers: (tenantId: string) =>
    callAdminEdge<{ members: OrgMember[] }>("list_org_members", { tenantId }),

  inviteMember: (params: {
    firstName: string;
    lastName: string;
    email: string;
    tenantId: string;
    orgRole: OrgRole;
  }) => callAdminEdge<{ user_id?: string; created?: boolean; invitation_sent?: boolean }>("invite", params),

  removeMember: (tenantId: string, userId: string) =>
    callAdminEdge<{ ok: boolean }>("remove_member", { tenantId, userId }),

  deleteUser: (userId: string) => callAdminEdge<{ ok: boolean }>("delete_user", { userId }),

  grantComplimentary: (params: {
    tenantId: string;
    userId?: string | null;
    duration: ComplimentaryDuration;
    reason: string;
  }) =>
    callAdminEdge<{ grant?: ComplimentaryGrant | null; email_sent?: boolean }>(
      "grant_complimentary",
      {
        tenantId: params.tenantId,
        userId: params.userId ?? null,
        duration: params.duration,
        reason: params.reason,
      },
    ),

  revokeComplimentary: (grantId: string) =>
    callAdminEdge<{ grant?: ComplimentaryGrant | null; email_sent?: boolean }>("revoke_complimentary", {
      grantId,
    }),

  listComplimentary: (tenantId: string) =>
    callAdminEdge<{ grants: ComplimentaryGrant[] }>("list_complimentary", { tenantId }),
};