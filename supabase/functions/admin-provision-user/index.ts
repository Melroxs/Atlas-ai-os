// supabase/functions/admin-provision-user/index.ts
//
// Server-side Super Admin user + organization management.
//
// SECURITY MODEL:
//   - The caller's Supabase JWT is verified (function is deployed with JWT
//     verification ON).
//   - EVERY action re-verifies the caller inside the function boundary:
//     platform_role = 'super_admin' AND account_status = 'active'. This is
//     enforced here, in the admin_* RPCs (is_super_admin()), and by RLS —
//     never by hidden UI buttons.
//   - Service-role writes happen ONLY server-side (this Edge Function).
//     Resend / Supabase / Paddle secrets are never exposed to the browser.
//   - The legacy `provision` action is preserved (Users & Access page), now
//     gated to super_admin like everything else.
//   - New-user invitations NEVER assign platform admin roles; the
//     organization role is restricted to owner/admin/manager/analyst/viewer.
//
// Actions (body.action):
//   provision             legacy single-user provisioning (email, name, role, status, companyName)
//   create_org            { name }
//   list_orgs             {}
//   list_org_members      { tenantId }
//   list_complimentary    { tenantId }
//   invite                { firstName?, lastName?, email, tenantId, orgRole }
//   remove_member         { tenantId, userId }   — membership only, Auth account stays
//   delete_user           { userId }              — permanent Auth deletion (confirm in UI)
//   grant_complimentary   { tenantId, userId?, duration, reason }
//   revoke_complimentary  { grantId }

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import {
  sendAtlasEmail,
  atlasSiteUrl,
  formatExpiration,
  formatDate,
  greetingLine,
} from "../_shared/email.ts";

const ATLAS_ALLOWED_ORIGINS = [
  "https://atlas-ai-os.com",
  "https://atlasmvp.freebuff.app",
  "https://atlasuniversalos.freebuff.app",
];

const ORG_ROLES = new Set(["owner", "admin", "manager", "analyst", "viewer"]);
const COMPLIMENTARY_DURATIONS = new Set(["7d", "30d", "90d", "1y", "lifetime"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (ATLAS_ALLOWED_ORIGINS.includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
  }
  return h;
}

function respond(corsH: Record<string, string>, status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsH, "Content-Type": "application/json" },
  });
}

function fail(message: string, detail?: string) {
  if (detail) console.error(`[admin-provision-user] ${message}: ${detail}`);
  return { ok: false, error: message };
}

// ── Environment helpers (never expose values) ──────────────────────────────

interface Clients {
  serviceKey: string;
  anonKey: string;
  supabaseUrl: string;
}

function resolveClients(): Clients | null {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const secretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS") ?? "";
  let serviceKey = "";
  if (secretKeysRaw) {
    try {
      serviceKey = JSON.parse(secretKeysRaw)["default"] ?? "";
    } catch {
      serviceKey = "";
    }
  }
  if (!serviceKey) serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  let anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const publishableRaw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "";
  if (publishableRaw) {
    try {
      anonKey = JSON.parse(publishableRaw)["default"] ?? anonKey;
    } catch {
      /* keep fallback */
    }
  }

  if (!supabaseUrl || !serviceKey || !anonKey) return null;
  return { serviceKey, anonKey, supabaseUrl };
}

async function makeClients(callerJwt: string): Promise<{
  user: any;
  admin: any;
} | null> {
  const c = resolveClients();
  if (!c) return null;
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
  const user = createClient(c.supabaseUrl, c.anonKey, {
    global: { headers: { Authorization: `Bearer ${callerJwt}` } },
  });
  const admin = createClient(c.supabaseUrl, c.serviceKey, {
    auth: { persistSession: false },
  });
  return { user, admin };
}

// ── Audit helper (service-role write; actor captured server-side) ──────────

async function audit(
  admin: any,
  entry: {
    actorId: string;
    actorEmail: string | null;
    action: string;
    targetType: string;
    targetId?: string | null;
    details: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await admin.from("atlas_audit_log").insert({
    actor_id: entry.actorId,
    actor_email: entry.actorEmail,
    action: entry.action,
    target_type: entry.targetType,
    target_id: entry.targetId ?? null,
    details: entry.details,
  });
  if (error) {
    console.error(`[admin-provision-user] audit insert failed (${entry.action}):`, error.message.slice(0, 200));
  }
}

// ── Action handlers ─────────────────────────────────────────────────────────

interface AdminContext {
  user: any;
  admin: any;
  callerId: string;
  callerEmail: string | null;
}

async function handleProvision(ctx: AdminContext, body: Record<string, unknown>) {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const name = typeof body.name === "string" ? body.name : undefined;
  const role = typeof body.role === "string" ? body.role : "customer_user";
  const status = typeof body.status === "string" ? body.status : "active";
  const companyName = typeof body.companyName === "string" ? body.companyName : undefined;

  if (!email || !EMAIL_RE.test(email)) {
    return { ok: false, error: "A valid email is required." };
  }

  // Only super_admin can assign admin roles
  if (role === "super_admin" || role === "atlas_admin") {
    return { ok: false, error: "Only super_admin can assign admin roles." };
  }

  // 1. Resolve or create the Auth user
  const { data: existingUsers, error: listError } =
    await ctx.admin.auth.admin.listUsers({ filter: `email = "${email}"` });
  if (listError) {
    return fail("Failed to check existing users.", listError.message);
  }
  const existing = existingUsers?.users?.find(
    (u: { email?: string }) => u.email?.toLowerCase() === email,
  );
  let authUserId: string;
  let action: string;
  if (existing) {
    authUserId = existing.id;
    action = "existing_user_provisioned";
  } else {
    const { data: inviteData, error: inviteError } =
      await ctx.admin.auth.admin.inviteUserByEmail(email, {
        data: { full_name: name || email.split("@")[0] },
        redirectTo: `${atlasSiteUrl()}/auth?returnTo=%2Fdashboard`,
      });
    if (inviteError || !inviteData?.id) {
      return fail("Failed to create/invite user.", inviteError?.message ?? "no id returned");
    }
    authUserId = inviteData.id;
    action = "new_user_invited";
  }

  // 2. Provision the Atlas profile (existing RPC, called with the caller's JWT)
  const { error: rpcError } = await ctx.user.rpc("admin_invite_user", {
    p_email: email,
    p_name: name || null,
    p_role: role,
    p_status: status,
    p_company_name: companyName || null,
  });
  if (rpcError) {
    console.error("[admin-provision-user] profile provisioning warning:", rpcError.message.slice(0, 200));
  }

  await audit(ctx, {
    actorId: ctx.callerId,
    actorEmail: ctx.callerEmail,
    action: "user_invited",
    targetType: "user",
    targetId: authUserId,
    details: { email, role, status, action },
  });

  // 3. Branded invitation email (best-effort; the Auth invite link is authoritative)
  let emailResult: { ok: boolean; error?: string } = { ok: true };
  if (action === "new_user_invited") {
    emailResult = await sendAtlasEmail({
      to: email,
      template: "invitation",
      vars: {
        full_name: name || email.split("@")[0],
        inviter_name: ctx.callerEmail?.split("@")[0] || "the Atlas team",
        organization_name: "your team",
        invite_url: `${atlasSiteUrl()}/auth?returnTo=%2Fdashboard`,
      },
    });
  }

  return {
    ok: true,
    user_id: authUserId,
    action,
    message:
      action === "new_user_invited"
        ? emailResult.ok
          ? `Invitation email sent to ${email}`
          : `Invitation created for ${email}.`
        : `Existing user ${email} has been provisioned.`,
    invitation_sent: emailResult.ok,
    warning: emailResult.ok ? null : `Invitation created but email could not be sent (${emailResult.error}). The user can still sign in normally.`,
  };
}

async function handleCreateOrg(ctx: AdminContext, body: Record<string, unknown>) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return fail("Organization name is required.");
  const { data, error } = await ctx.user.rpc("admin_create_tenant", { p_name: name });
  if (error) return fail("Could not create organization.", error.message);
  return { ok: true, ...(data ?? {}) };
}

async function handleListOrgs(ctx: AdminContext) {
  const { data, error } = await ctx.user.rpc("admin_list_tenants", { p_limit: 500 });
  if (error) return fail("Could not list organizations.", error.message);
  return { ok: true, organizations: data ?? [] };
}

async function handleListOrgMembers(ctx: AdminContext, body: Record<string, unknown>) {
  const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
  if (!tenantId) return fail("Organization id is required.");

  // Two deterministic queries (no reliance on the generated FK constraint
  // name): memberships for the org, then profiles for those user ids.
  const { data: members, error } = await ctx.admin
    .from("memberships")
    .select('"userId", role, status, "joinedAt"')
    .eq("tenantId", tenantId)
    .order("_creationTime", { ascending: true });

  if (error) return fail("Could not list organization members.", error.message);

  const userIds = (members ?? []).map((m: { userId?: string }) => m.userId).filter(Boolean);
  const profiles = new Map<string, Record<string, unknown>>();
  if (userIds.length > 0) {
    const { data: rows, error: pErr } = await ctx.admin
      .from("profiles")
      .select("_id, name, email, platform_role, account_status")
      .in("_id", userIds);
    if (pErr) return fail("Could not list organization member profiles.", pErr.message);
    for (const row of rows ?? []) profiles.set(row._id, row);
  }

  const normalized = (members ?? []).map((m: Record<string, any>) => ({
    userId: m.userId,
    role: m.role,
    status: m.status,
    joinedAt: m.joinedAt,
    profile: profiles.get(m.userId) ?? null,
  }));

  return { ok: true, members: normalized };
}

async function handleInvite(ctx: AdminContext, body: Record<string, unknown>) {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const firstName = typeof body.firstName === "string" ? body.firstName.trim() : "";
  const lastName = typeof body.lastName === "string" ? body.lastName.trim() : "";
  const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
  const orgRole = typeof body.orgRole === "string" ? body.orgRole : "";

  if (!email || !EMAIL_RE.test(email)) return fail("A valid email is required.");
  if (!tenantId) return fail("Organization is required.");
  if (!ORG_ROLES.has(orgRole)) {
    return fail("Organization role must be one of owner, admin, manager, analyst, viewer.");
  }

  // Organization must exist
  const { data: org, error: orgError } = await ctx.admin
    .from("tenants")
    .select("_id, name")
    .eq("_id", tenantId)
    .maybeSingle();
  if (orgError || !org) return fail("Organization not found.", orgError?.message);

  // Resolve or create the Auth user
  const { data: existingUsers, error: listError } =
    await ctx.admin.auth.admin.listUsers({ filter: `email = "${email}"` });
  if (listError) return fail("Failed to check existing users.", listError.message);
  const existing = existingUsers?.users?.find(
    (u: { email?: string }) => u.email?.toLowerCase() === email,
  );

  let authUserId: string;
  let created = false;
  if (existing) {
    authUserId = existing.id;
  } else {
    const fullName = [firstName, lastName].filter(Boolean).join(" ") || email.split("@")[0];
    const { data: inviteData, error: inviteError } =
      await ctx.admin.auth.admin.inviteUserByEmail(email, {
        data: { full_name: fullName },
        redirectTo: `${atlasSiteUrl()}/auth?returnTo=%2Fdashboard`,
      });
    if (inviteError || !inviteData?.id) {
      return fail("Failed to create/invite user.", inviteError?.message ?? "no id returned");
    }
    authUserId = inviteData.id;
    created = true;
  }

  // Upsert the Atlas profile (name + active status)
  const displayName = [firstName, lastName].filter(Boolean).join(" ") || email.split("@")[0];
  const { data: profile } = await ctx.admin
    .from("profiles")
    .select("_id")
    .eq("_id", authUserId)
    .maybeSingle();
  if (profile) {
    const { error: uErr } = await ctx.admin
      .from("profiles")
      .update({ name: displayName, account_status: "active", email, _updated_at: new Date().toISOString() })
      .eq("_id", authUserId);
    if (uErr) console.error("[admin-provision-user] profile update failed:", uErr.message.slice(0, 200));
  } else {
    const { error: iErr } = await ctx.admin.from("profiles").insert({
      _id: authUserId,
      name: displayName,
      email,
      platform_role: "user",
      account_status: "active",
      role: "user",
      _creationTime: Date.now(),
    });
    if (iErr) console.error("[admin-provision-user] profile insert failed:", iErr.message.slice(0, 200));
  }

  // Upsert the organization membership (never a platform role)
  const { data: membership } = await ctx.admin
    .from("memberships")
    .select("_id")
    .eq("tenantId", tenantId)
    .eq("userId", authUserId)
    .maybeSingle();
  if (membership) {
    const { error: mErr } = await ctx.admin
      .from("memberships")
      .update({ role: orgRole, status: "active" })
      .eq("_id", membership._id);
    if (mErr) return fail("Could not update membership.", mErr.message);
  } else {
    const { error: mErr } = await ctx.admin.from("memberships").insert({
      tenantId,
      userId: authUserId,
      role: orgRole,
      status: "active",
      joinedAt: Date.now(),
      _creationTime: Date.now(),
    });
    if (mErr) return fail("Could not create membership.", mErr.message);
  }

  await audit(ctx, {
    actorId: ctx.callerId,
    actorEmail: ctx.callerEmail,
    action: created ? "user_invited" : "user_added_to_organization",
    targetType: "user",
    targetId: authUserId,
    details: { email, organization_id: tenantId, organization_role: orgRole, created },
  });

  const emailResult = await sendAtlasEmail({
    to: email,
    template: "invitation",
    vars: {
      full_name: displayName,
      inviter_name: ctx.callerEmail?.split("@")[0] || "a teammate",
      organization_name: org.name,
      invite_url: `${atlasSiteUrl()}/auth?returnTo=%2Fdashboard`,
    },
  });

  return {
    ok: true,
    user_id: authUserId,
    created,
    invitation_sent: emailResult.ok,
    warning: emailResult.ok ? null : `Invitation created but email could not be sent (${emailResult.error}).`,
  };
}

async function handleRemoveMember(ctx: AdminContext, body: Record<string, unknown>) {
  const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
  const userId = typeof body.userId === "string" ? body.userId : "";
  if (!tenantId || !userId) return fail("Organization and user are required.");

  const { data: member } = await ctx.admin
    .from("memberships")
    .select("_id, role")
    .eq("tenantId", tenantId)
    .eq("userId", userId)
    .maybeSingle();
  if (!member) return fail("The user is not a member of this organization.");

  // Never remove the last owner (would orphan the organization)
  if (member.role === "owner") {
    const { count } = await ctx.admin
      .from("memberships")
      .select("_id", { count: "exact", head: true })
      .eq("tenantId", tenantId)
      .eq("role", "owner")
      .eq("status", "active");
    if (count !== null && count <= 1) {
      return fail("Cannot remove the last active owner of an organization.");
    }
  }

  const { error } = await ctx.admin.from("memberships").delete().eq("_id", member._id);
  if (error) return fail("Could not remove member.", error.message);

  await audit(ctx, {
    actorId: ctx.callerId,
    actorEmail: ctx.callerEmail,
    action: "user_removed_from_organization",
    targetType: "user",
    targetId: userId,
    details: { organization_id: tenantId, membership_id: member._id },
  });

  return { ok: true };
}

async function handleDeleteUser(ctx: AdminContext, body: Record<string, unknown>) {
  const userId = typeof body.userId === "string" ? body.userId : "";
  if (!userId) return fail("User id is required.");
  if (userId === ctx.callerId) return fail("You cannot delete your own account through this workflow.");

  // 1. FK-safe cleanup + audit (super_admin-gated RPC, called with the caller's JWT)
  const { data, error } = await ctx.user.rpc("admin_prepare_user_deletion", {
    p_user_id: userId,
  });
  if (error) return fail("Could not prepare user deletion.", error.message);

  // 2. Permanent Auth deletion via the Admin API (server-side only)
  const { error: delError } = await ctx.admin.auth.admin.deleteUser(userId);
  if (delError) return fail("Auth account deletion failed.", delError.message);

  return { ok: true, user_id: userId };
}

async function handleGrantComplimentary(ctx: AdminContext, body: Record<string, unknown>) {
  const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
  const userId = typeof body.userId === "string" && body.userId ? body.userId : null;
  const duration = typeof body.duration === "string" ? body.duration : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";

  if (!tenantId) return fail("Organization is required.");
  if (!COMPLIMENTARY_DURATIONS.has(duration)) {
    return fail("Duration must be one of 7d, 30d, 90d, 1y, lifetime.");
  }
  if (!reason) return fail("A reason is required for complimentary access.");

  // Super-admin-gated RPC (called with the caller's JWT; audits internally)
  const { data: grant, error } = await ctx.user.rpc("admin_grant_complimentary_access", {
    p_tenant_id: tenantId,
    p_user_id: userId,
    p_duration: duration,
    p_reason: reason,
  });
  if (error) return fail("Could not grant complimentary access.", error.message);

  // Notify (best-effort). Specific user → that user; org-wide → active members.
  let recipients: string[] = [];
  const orgNameRes = await ctx.admin.from("tenants").select("name").eq("_id", tenantId).maybeSingle();
  const organizationName = orgNameRes?.data?.name ?? "your organization";

  if (userId) {
    const { data: p } = await ctx.admin.from("profiles").select("email").eq("_id", userId).maybeSingle();
    if (p?.email) recipients = [p.email];
  } else {
    const { data: rows } = await ctx.admin
      .from("memberships")
      .select('"userId"')
      .eq("tenantId", tenantId)
      .eq("status", "active")
      .limit(10);
    const memberIds = (rows ?? []).map((r: any) => r.userId).filter(Boolean);
    if (memberIds.length > 0) {
      const { data: profiles } = await ctx.admin
        .from("profiles")
        .select("email")
        .in("_id", memberIds);
      recipients = (profiles ?? [])
        .map((p: any) => p.email)
        .filter((e: unknown): e is string => typeof e === "string" && EMAIL_RE.test(e));
    }
  }

  const emailResult = recipients.length
    ? await sendAtlasEmail({
        to: recipients,
        template: "complimentary_granted",
        vars: {
          greeting: greetingLine(""),
          organization_name: organizationName,
          organization_name_phrase: ` for ${organizationName}`,
          reason_phrase: reason ? ` (${reason})` : "",
          expiration_date: formatExpiration(grant?.expires_at ?? null),
          login_url: `${atlasSiteUrl()}/auth?returnTo=%2Fdashboard`,
        },
      })
    : { ok: true as const };

  return {
    ok: true,
    grant: grant ?? null,
    email_sent: emailResult.ok,
    warning: emailResult.ok ? null : "Access granted but the notification email could not be sent.",
  };
}

async function handleRevokeComplimentary(ctx: AdminContext, body: Record<string, unknown>) {
  const grantId = typeof body.grantId === "string" ? body.grantId : "";
  if (!grantId) return fail("Grant id is required.");

  const { data: grant, error } = await ctx.user.rpc("admin_revoke_complimentary_access", {
    p_grant_id: grantId,
  });
  if (error) return fail("Could not revoke complimentary access.", error.message);

  // Notify the grant's user (best-effort)
  let emailResult: { ok: boolean } = { ok: true };
  if (grant?.user_id) {
    const { data: p } = await ctx.admin.from("profiles").select("email").eq("_id", grant.user_id).maybeSingle();
    if (p?.email) {
      const orgNameRes = await ctx.admin
        .from("tenants")
        .select("name")
        .eq("_id", grant.organization_id)
        .maybeSingle();
      emailResult = await sendAtlasEmail({
        to: p.email,
        template: "complimentary_revoked",
        vars: {
          greeting: greetingLine(""),
          organization_name: orgNameRes?.data?.name ?? "your organization",
          effective_date: formatDate(Date.now()),
        },
      });
    }
  }

  return {
    ok: true,
    grant: grant ?? null,
    email_sent: emailResult.ok,
    warning: emailResult.ok ? null : "Access revoked but the notification email could not be sent.",
  };
}

async function handleListComplimentary(ctx: AdminContext, body: Record<string, unknown>) {
  const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
  if (!tenantId) return fail("Organization id is required.");
  const { data, error } = await ctx.user.rpc("admin_list_complimentary_access", {
    p_tenant_id: tenantId,
  });
  if (error) return fail("Could not list complimentary access.", error.message);
  return { ok: true, grants: data ?? [] };
}

// ── Main handler ───────────────────────────────────────────────────────────

serve(async (req: Request) => {
  const corsH = corsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsH });
  }
  if (req.method !== "POST") {
    return respond(corsH, 405, fail("Method not allowed"));
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return respond(corsH, 401, fail("Missing authorization header"));
    }

    const clients = await makeClients(authHeader.replace(/^Bearer\s+/i, ""));
    if (!clients) {
      return respond(corsH, 500, fail("Server configuration error"));
    }

    // Verify the caller
    const { data: userData, error: authError } = await clients.user.auth.getUser();
    if (authError || !userData?.user) {
      return respond(corsH, 401, fail("Not authenticated"));
    }

    // Server-side authorization: super_admin with an active account ONLY.
    // Normal members — and even atlas_admin — cannot perform these operations
    // by manipulating frontend requests.
    const { data: callerProfile, error: profileError } = await clients.admin
      .from("profiles")
      .select("platform_role, account_status, email, name")
      .eq("_id", userData.user.id)
      .maybeSingle();
    if (profileError || !callerProfile) {
      return respond(corsH, 403, fail("Profile not found"));
    }
    if (callerProfile.account_status !== "active" || callerProfile.platform_role !== "super_admin") {
      return respond(corsH, 403, fail("Access denied: super_admin role required"));
    }

    const body = await req.json().catch(() => ({}));
    const action = typeof body.action === "string" ? body.action : "provision";

    const ctx: AdminContext = {
      user: clients.user,
      admin: clients.admin,
      callerId: userData.user.id,
      callerEmail: callerProfile.email ?? null,
    };

    let result: unknown;
    switch (action) {
      case "provision":
        result = await handleProvision(ctx, body);
        break;
      case "create_org":
        result = await handleCreateOrg(ctx, body);
        break;
      case "list_orgs":
        result = await handleListOrgs(ctx);
        break;
      case "list_org_members":
        result = await handleListOrgMembers(ctx, body);
        break;
      case "invite":
        result = await handleInvite(ctx, body);
        break;
      case "remove_member":
        result = await handleRemoveMember(ctx, body);
        break;
      case "delete_user":
        result = await handleDeleteUser(ctx, body);
        break;
      case "grant_complimentary":
        result = await handleGrantComplimentary(ctx, body);
        break;
      case "revoke_complimentary":
        result = await handleRevokeComplimentary(ctx, body);
        break;
      case "list_complimentary":
        result = await handleListComplimentary(ctx, body);
        break;
      default:
        return respond(corsH, 400, fail(`Unknown action: ${action}`));
    }

    return respond(corsH, 200, result);
  } catch (err) {
    console.error("[admin-provision-user] unexpected error:", err instanceof Error ? err.message : String(err));
    return respond(corsH, 500, fail("Unexpected server error."));
  }
});