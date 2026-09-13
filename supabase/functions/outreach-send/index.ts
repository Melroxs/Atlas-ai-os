// ---------------------------------------------------------------------------
// Atlas CRM — Outreach Send Edge Function (Resend integration)
//
// Actions: send_email, send_test_email, check_suppression, add_suppression,
//          remove_suppression, list_suppression
//
// SECURITY MODEL:
//   - RESEND_API_KEY is required — function fails closed if missing
//   - Only authenticated super_admin / atlas_admin users can send
//   - Suppressed/bounced leads are blocked before sending
//   - Test mode redirects all sends to a test recipient
//   - CORS restricted to production origins only
//   - Credentials never exposed to browser or in error messages
//   - Rate limiting: max 50 emails per request, configurable per minute
// ---------------------------------------------------------------------------

// ── CORS ────────────────────────────────────────────────────────────────

const ATLAS_ALLOWED_ORIGINS = [
  "https://atlas-ai-os.com",
  "https://atlasmvp.freebuff.app",
  "https://atlasuniversalos.freebuff.app",
];

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

// ── Safe error helper ───────────────────────────────────────────────────

function ok(data: Record<string, unknown>) {
  return { ok: true, ...data };
}

function fail(message: string, detail?: string) {
  if (detail) console.error(`[outreach-send] ${message}: ${detail}`);
  return { ok: false, error: message };
}

// ── Supabase helpers ────────────────────────────────────────────────────

async function getSupabaseFromRequest(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return { admin: null, user: null, error: "missing token" };

  // Parse SUPABASE_SECRET_KEYS (modern built-in env var)
  const secretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!secretKeysRaw) return { admin: null, user: null, error: "server config" };

  let serviceRoleKey: string;
  try {
    const secretKeys = JSON.parse(secretKeysRaw);
    serviceRoleKey = secretKeys["default"];
  } catch {
    return { admin: null, user: null, error: "server config" };
  }
  if (!serviceRoleKey) return { admin: null, user: null, error: "server config" };

  // Parse SUPABASE_PUBLISHABLE_KEYS for anon key
  const publishableKeysRaw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  let anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (publishableKeysRaw) {
    try {
      const pk = JSON.parse(publishableKeysRaw);
      anonKey = pk["default"] ?? anonKey;
    } catch { /* use fallback */ }
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!supabaseUrl) return { admin: null, user: null, error: "server config" };

  // Create user client (respects RLS, validates JWT)
  const { createClient } = await import(
    "https://esm.sh/@supabase/supabase-js@2"
  );
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  // Create admin client (bypasses RLS for admin checks)
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  // Validate the user's JWT by fetching their profile
  const { data: profile, error: profileErr } = await userClient
    .from("profiles")
    .select("_id, platform_role, account_status")
    .single();

  if (profileErr || !profile) {
    return { admin: adminClient, user: null, error: "no atlas profile" };
  }

  return { admin: adminClient, user: profile, error: null };
}

// ── Resend API ──────────────────────────────────────────────────────────

const RESEND_API = "https://api.resend.com";

interface ResendSendResult {
  id: string;
}

async function resendSendEmail(params: {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text?: string;
  tags?: Array<{ name: string; value: string }>;
  reply_to?: string;
}): Promise<{ messageId: string }> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    throw new Error(
      "Email provider is not configured. Contact your Atlas administrator.",
    );
  }

  const res = await fetch(`${RESEND_API}/emails`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: params.from,
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
      tags: params.tags,
      reply_to: params.reply_to,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error(`[outreach-send] Resend API error ${res.status}: ${errBody.slice(0, 300)}`);

    if (res.status === 401 || res.status === 403) {
      throw new Error("Email provider authentication failed. Check RESEND_API_KEY.");
    }
    if (res.status === 429) {
      throw new Error("Email sending rate limit reached. Please try again in a moment.");
    }
    if (res.status === 422) {
      try {
        const errJson = JSON.parse(errBody);
        const msg = errJson.message || errJson.error || "Invalid request";
        throw new Error(`Email validation error: ${msg}`);
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("Email")) throw e;
        throw new Error("Invalid email request. Check recipient address and content.");
      }
    }
    throw new Error("Email delivery failed. Please try again later.");
  }

  const data: ResendSendResult = await res.json();
  return { messageId: data.id || "" };
}

// ── Rate limiter (in-memory, per-instance) ──────────────────────────────

const sendTimestamps: number[] = [];
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX = parseInt(Deno.env.get("OUTREACH_MAX_PER_MINUTE") || "50", 10);

function checkRateLimit(): boolean {
  const now = Date.now();
  // Prune old entries
  while (sendTimestamps.length > 0 && sendTimestamps[0] < now - RATE_LIMIT_WINDOW) {
    sendTimestamps.shift();
  }
  if (sendTimestamps.length >= RATE_LIMIT_MAX) return false;
  sendTimestamps.push(now);
  return true;
}

// ── Activity logging ────────────────────────────────────────────────────

async function logOutreachActivity(
  admin: any,
  params: {
    leadId?: string;
    recipientEmail: string;
    recipientName?: string;
    subject: string;
    status: string;
    providerMessageId?: string;
    errorMessage?: string;
    outreachType: string;
  },
) {
  try {
    await admin.rpc("crm_add_activity", {
      p_lead_id: params.leadId || null,
      p_activity_type: "email",
      p_title: `Email ${params.status}: ${params.subject}`,
      p_description: `To: ${params.recipientName ? params.recipientName + " <" + params.recipientEmail + ">" : params.recipientEmail}\nStatus: ${params.status}${params.providerMessageId ? `\nProvider ID: ${params.providerMessageId}` : ""}${params.errorMessage ? `\nError: ${params.errorMessage}` : ""}`,
    });
  } catch (e) {
    console.error("[outreach-send] Failed to log activity:", e);
  }
}

// ── Sender configuration ────────────────────────────────────────────────

function getSenderConfig() {
  return {
    email: Deno.env.get("RESEND_SENDER_EMAIL") || "admin@atlas-ai-os.com",
    name: Deno.env.get("RESEND_SENDER_NAME") || "Melissa October",
  };
}

function formatResendFrom(sender: { email: string; name: string }): string {
  // Resend from format: "Name <email>"
  return `${sender.name} <${sender.email}>`;
}

function getTestModeConfig() {
  const testMode = (Deno.env.get("OUTREACH_TEST_MODE") || "true").toLowerCase() === "true";
  const testRecipient = Deno.env.get("OUTREACH_TEST_RECIPIENT") || "test@atlas-ai-os.com";
  return { testMode, testRecipient };
}

// ── HTML escape ─────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ── Main handler ────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(req) });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "Method not allowed" }),
      { status: 405, headers: { "Content-Type": "application/json", ...corsHeaders(req) } },
    );
  }

  const headers = { "Content-Type": "application/json", ...corsHeaders(req) };

  try {
    const { action, ...params } = await req.json();

    // Authenticate
    const { admin, user, error: authError } = await getSupabaseFromRequest(req);
    if (authError || !user) {
      return new Response(
        JSON.stringify(fail(authError || "Authentication required")),
        { status: 401, headers },
      );
    }

    // Authorize: only super_admin and atlas_admin can use outreach
    const allowedRoles = ["super_admin", "atlas_admin"];
    if (!allowedRoles.includes(user.platform_role)) {
      return new Response(
        JSON.stringify(fail("You do not have permission to send outreach emails.")),
        { status: 403, headers },
      );
    }

    // ── Action: send_email ────────────────────────────────────────────
    if (action === "send_email") {
      const { to, subject, body, htmlBody, leadId, leadName, outreachType, templateId } = params;

      if (!to || !subject || (!body && !htmlBody)) {
        return new Response(
          JSON.stringify(fail("Recipient, subject, and body are required.")),
          { status: 400, headers },
        );
      }

      const recipientEmail = to as string;
      const recipientName = (leadName as string) || "";

      // Check suppression list
      const { data: suppressed } = await admin
        .from("outreach_suppression")
        .select("id, reason")
        .eq("email", recipientEmail.toLowerCase().trim())
        .limit(1)
        .maybeSingle();

      if (suppressed) {
        return new Response(
          JSON.stringify(fail(
            `This email address is suppressed (${suppressed.reason || "unsubscribed"}). Cannot send.`,
          )),
          { status: 400, headers },
        );
      }

      // Rate limit
      if (!checkRateLimit()) {
        return new Response(
          JSON.stringify(fail("Rate limit reached. Please try again in a moment.")),
          { status: 429, headers },
        );
      }

      // Test mode check
      const { testMode, testRecipient } = getTestModeConfig();
      const actualTo = testMode ? testRecipient : recipientEmail;
      const sender = getSenderConfig();

      // Build HTML email
      const finalHtml = htmlBody || `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; line-height: 1.6; color: #333;">${(body || "").split("\n").map((line: string) => `<p style="margin: 0 0 12px 0;">${escapeHtml(line) || "&nbsp;"}</p>`).join("")}</div>`;

      try {
        const result = await resendSendEmail({
          from: formatResendFrom(sender),
          to: [actualTo],
          subject,
          html: finalHtml,
          text: body || "",
          tags: [
            { name: "campaign", value: "atlas-outreach" },
            { name: "type", value: outreachType || "manual" },
          ],
        });

        // Log to CRM activity timeline
        await logOutreachActivity(admin, {
          leadId: leadId as string | undefined,
          recipientEmail,
          recipientName,
          subject,
          status: testMode ? "sent-test" : "sent",
          providerMessageId: result.messageId,
          outreachType: (outreachType as string) || "manual",
        });

        return new Response(
          JSON.stringify(ok({
            messageId: result.messageId,
            testMode,
            recipient: testMode ? `(redirected to test inbox)` : recipientEmail,
          })),
          { status: 200, headers },
        );
      } catch (sendError) {
        const errMsg = sendError instanceof Error ? sendError.message : "Unknown error";

        // Log the failure
        await logOutreachActivity(admin, {
          leadId: leadId as string | undefined,
          recipientEmail,
          recipientName,
          subject,
          status: "failed",
          errorMessage: errMsg,
          outreachType: (outreachType as string) || "manual",
        });

        return new Response(
          JSON.stringify(fail(errMsg)),
          { status: 500, headers },
        );
      }
    }

    // ── Action: send_test_email ───────────────────────────────────────
    if (action === "send_test_email") {
      const { to, subject, body } = params;

      if (!to || !subject || !body) {
        return new Response(
          JSON.stringify(fail("Recipient, subject, and body are required for test send.")),
          { status: 400, headers },
        );
      }

      const sender = getSenderConfig();

      try {
        const result = await resendSendEmail({
          from: formatResendFrom(sender),
          to: [to as string],
          subject: `[Atlas Test] ${subject}` as string,
          html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; line-height: 1.6; color: #333;"><div style="background: #f0f9ff; border-left: 4px solid #0ea5e9; padding: 12px 16px; margin-bottom: 16px; font-size: 13px; color: #0369a1;">This is a test email from Atlas CRM.</div>${(body as string).split("\n").map((line: string) => `<p style="margin: 0 0 12px 0;">${escapeHtml(line) || "&nbsp;"}</p>`).join("")}</div>`,
          text: `[Atlas Test] ${body}` as string,
          tags: [{ name: "campaign", value: "atlas-test" }],
        });

        return new Response(
          JSON.stringify(ok({
            messageId: result.messageId,
            recipient: to,
          })),
          { status: 200, headers },
        );
      } catch (sendError) {
        const errMsg = sendError instanceof Error ? sendError.message : "Unknown error";
        return new Response(
          JSON.stringify(fail(errMsg)),
          { status: 500, headers },
        );
      }
    }

    // ── Action: check_suppression ─────────────────────────────────────
    if (action === "check_suppression") {
      const { email } = params;
      if (!email) {
        return new Response(
          JSON.stringify(fail("Email address is required.")),
          { status: 400, headers },
        );
      }

      const { data } = await admin
        .from("outreach_suppression")
        .select("id, email, reason, created_at")
        .eq("email", (email as string).toLowerCase().trim())
        .limit(1)
        .maybeSingle();

      return new Response(
        JSON.stringify(ok({ suppressed: !!data, record: data || null })),
        { status: 200, headers },
      );
    }

    // ── Action: add_suppression ───────────────────────────────────────
    if (action === "add_suppression") {
      const { email: suppressEmail, reason } = params;
      if (!suppressEmail) {
        return new Response(
          JSON.stringify(fail("Email address is required.")),
          { status: 400, headers },
        );
      }

      const normalizedEmail = (suppressEmail as string).toLowerCase().trim();

      const { error: insertErr } = await admin
        .from("outreach_suppression")
        .upsert(
          {
            email: normalizedEmail,
            reason: (reason as string) || "manual",
            added_by: user._id,
          },
          { onConflict: "email" },
        );

      if (insertErr) {
        return new Response(
          JSON.stringify(fail("Failed to add suppression.")),
          { status: 500, headers },
        );
      }

      return new Response(
        JSON.stringify(ok({ email: normalizedEmail, suppressed: true })),
        { status: 200, headers },
      );
    }

    // ── Action: remove_suppression ────────────────────────────────────
    if (action === "remove_suppression") {
      const { email: removeEmail } = params;
      if (!removeEmail) {
        return new Response(
          JSON.stringify(fail("Email address is required.")),
          { status: 400, headers },
        );
      }

      await admin
        .from("outreach_suppression")
        .delete()
        .eq("email", (removeEmail as string).toLowerCase().trim());

      return new Response(
        JSON.stringify(ok({ email: removeEmail, suppressed: false })),
        { status: 200, headers },
      );
    }

    // ── Action: list_suppression ──────────────────────────────────────
    if (action === "list_suppression") {
      const { data, error } = await admin
        .from("outreach_suppression")
        .select("id, email, reason, created_at")
        .order("created_at", { ascending: false })
        .limit(200);

      if (error) {
        return new Response(
          JSON.stringify(fail("Failed to list suppression list.")),
          { status: 500, headers },
        );
      }

      return new Response(
        JSON.stringify(ok({ records: data || [] })),
        { status: 200, headers },
      );
    }

    // ── Unknown action ────────────────────────────────────────────────
    return new Response(
      JSON.stringify(fail(`Unknown action: ${action}`)),
      { status: 400, headers },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[outreach-send] Unhandled error:", msg);
    return new Response(
      JSON.stringify(fail("An unexpected error occurred. Please try again.")),
      { status: 500, headers },
    );
  }
});
