// ---------------------------------------------------------------------------
// Atlas — Branded transactional email system (Resend)
//
// One centralized layer for every Atlas application email:
//   config      — sender / reply-to / app URL / support address (env-driven)
//   components  — email-safe building blocks (no JS, tables + inline styles)
//   templates   — 12 branded templates driven by {{variable}} placeholders
//   delivery    — single sendAtlasEmail() → Resend (centralized errors/logging)
//
// SECURITY:
//   - RESEND_API_KEY exists ONLY in Supabase Edge Function secrets. Never in
//     VITE_*/NEXT_PUBLIC_*, never committed, never logged, never rendered
//     into template HTML, never returned to clients.
//   - Dynamic values are HTML-escaped before interpolation.
//   - Logs mask recipient addresses and never contain secrets.
//
// BRAND (mirrors the app): teal signal #0d9488, deep ink #0f172a,
// slate #334155, border #e2e8f0. The header uses the text wordmark (the app's
// SVG logo is a gradient mark that cannot be reliably hotlinked by email
// clients; per the brand spec a text-based header is preferred).
//
// Paddle / billing templates do NOT calculate trial behavior — Paddle remains
// authoritative for dates, amounts, and subscription state.
// ---------------------------------------------------------------------------

// ═══════════════════════════════════════════════════════════════════════════
// 1. Configuration
// ═══════════════════════════════════════════════════════════════════════════

// Canonical Atlas correspondence address — every Atlas email (transactional,
// auth, billing, complimentary access, support, administration) sends from
// and replies to this single address. Configurable via env vars for
// non-production overrides; defaults must never point anywhere else.
const DEFAULT_ADMIN_EMAIL = "admin@atlas-ai-os.com";
const DEFAULT_SENDER_NAME = "Atlas AI OS";

/** Full sender identity: "Atlas AI OS <admin@atlas-ai-os.com>" */
export const DEFAULT_FROM = `${DEFAULT_SENDER_NAME} <${DEFAULT_ADMIN_EMAIL}>`;

export interface AtlasEmailConfig {
  /** Full sender identity: "Atlas AI OS <admin@atlas-ai-os.com>" */
  from: string;
  /** Reply-to address (or null to omit). */
  replyTo: string | null;
  /** Production app URL, no trailing slash. */
  siteUrl: string;
  /** Support address used in footers and templates. */
  supportEmail: string;
}

const DEFAULT_SITE_URL = "https://atlas-ai-os.com";

/**
 * Load email configuration from the Edge Function environment.
 * Env vars: ATLAS_EMAIL_FROM, ATLAS_EMAIL_REPLY_TO, ATLAS_APP_URL,
 * SITE_URL (legacy), ATLAS_SUPPORT_EMAIL, RESEND_SENDER_NAME/EMAIL (legacy).
 *
 * Production defaults (used when no env override is present):
 *   From      "Atlas AI OS <admin@atlas-ai-os.com>"
 *   Reply-To  admin@atlas-ai-os.com
 *   Support   admin@atlas-ai-os.com
 *   App URL   https://atlas-ai-os.com
 */
export function loadEmailConfig(
  env: { get(key: string): string | null } = Deno.env,
): AtlasEmailConfig {
  const configuredFrom = env.get("ATLAS_EMAIL_FROM") ?? "";
  const from = configuredFrom.trim() ||
    `${env.get("RESEND_SENDER_NAME") ?? DEFAULT_SENDER_NAME} <${env.get("RESEND_SENDER_EMAIL") ?? DEFAULT_ADMIN_EMAIL}>`;

  const replyToRaw = env.get("ATLAS_EMAIL_REPLY_TO") ?? "";
  const replyTo = replyToRaw.trim() || DEFAULT_ADMIN_EMAIL;

  const siteUrl = (env.get("ATLAS_APP_URL") ?? env.get("SITE_URL") ?? DEFAULT_SITE_URL)
    .replace(/\/+$/, "");

  const supportEmail = (env.get("ATLAS_SUPPORT_EMAIL") ?? DEFAULT_ADMIN_EMAIL).trim();

  return { from, replyTo, siteUrl, supportEmail };
}

/** Legacy helper: resolved sender identity (kept for existing callers). */
export function atlasEmailFrom(): string {
  return loadEmailConfig().from;
}

/** Legacy helper: resolved site URL (kept for existing callers). */
export function atlasSiteUrl(): string {
  return loadEmailConfig().siteUrl;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Primitives
// ═══════════════════════════════════════════════════════════════════════════

export function escapeHtml(s: string | number | null | undefined): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

/** Never log full recipient addresses. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  const shown = local.slice(0, Math.min(2, local.length));
  return `${shown}***@${domain}`;
}

/** "Jane, " greeting or "" — keeps complimentary mailings grammatical when
 *  a recipient name is unknown (org-wide sends to many members at once). */
export function greetingLine(name: string | null | undefined): string {
  const trimmed = String(name ?? "").trim();
  return trimmed ? `${trimmed}, ` : "";
}

/** Readable date for email content ("October 8, 2026"). */
export function formatDate(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const ms = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) return String(value);
  return new Date(ms).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** "USD 149.00" style amount; empty when the amount is missing. */
export function formatAmount(amount: string | number | null | undefined, currency?: string | null): string {
  if (amount === null || amount === undefined || amount === "") return "";
  const code = (currency ?? "USD").toUpperCase();
  return `${code} ${amount}`;
}

/** Lifetime grants render as "No expiration (lifetime)". */
export function formatExpiration(expiresAtMs: number | null): string {
  if (expiresAtMs === null || expiresAtMs === undefined) return "No expiration (lifetime)";
  return new Date(expiresAtMs).toUTCString();
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Email-safe design-system components
// ═══════════════════════════════════════════════════════════════════════════
//
// Every component is pure string HTML: tables for layout, inline styles only,
// no JavaScript, no unsupported CSS, high-contrast colors. All values passed
// in are pre-escaped by callers/templates.

export type EmailTone = "neutral" | "success" | "warning" | "danger" | "info";

const TONE_COLORS: Record<EmailTone, { bg: string; text: string }> = {
  neutral: { bg: "#f1f5f9", text: "#334155" },
  success: { bg: "#ecfdf5", text: "#047857" },
  warning: { bg: "#fffbeb", text: "#b45309" },
  danger: { bg: "#fef2f2", text: "#b91c1c" },
  info: { bg: "#f0f9ff", text: "#0369a1" },
};

/** Outer document shell — full HTML email wrapper. */
export function emailShell(params: {
  preheader: string;
  bodyHtml: string;
  footerHtml: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<title>Atlas</title>
</head>
<body style="margin:0;padding:0;background-color:#f8fafc;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(params.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f8fafc;">
    <tr>
      <td align="center" style="padding:24px 12px 40px 12px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
          ${params.bodyHtml}
        </table>
      </td>
    </tr>
  </table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f8fafc;">
    <tr>
      <td align="center" style="padding:0 12px 40px 12px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
          ${params.footerHtml}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Text-based Atlas wordmark (email-safe — no external image dependency). */
export function headerHtml(config: AtlasEmailConfig): string {
  return `
    <tr><td style="padding:8px 4px 24px 4px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:22px;font-weight:800;letter-spacing:-0.02em;line-height:1;">
            <span style="color:#0d9488;">ATLAS</span><span style="color:#0f172a;">AI&nbsp;OS</span>
          </td>
        </tr>
        <tr><td style="height:6px;"></td></tr>
        <tr><td style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:11px;font-weight:500;letter-spacing:0.14em;text-transform:uppercase;color:#64748b;">
          AI workforce intelligence for restoration
        </td></tr>
      </table>
    </td></tr>`;
}

/** Brand footer: Atlas, domain, support, copyright. */
export function footerHtml(config: AtlasEmailConfig): string {
  const year = new Date().getUTCFullYear();
  const base = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
    <tr><td style="border-top:1px solid #e2e8f0;padding-top:20px;">
      <p style="margin:0 0 6px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;color:#0f172a;">
        <span style="color:#0d9488;">ATLAS</span>AI&nbsp;OS
      </p>
      <p style="margin:0 0 4px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:#64748b;">
        <a href="${config.siteUrl}" style="color:#0d9488;text-decoration:none;">${escapeHtml(config.siteUrl.replace(/^https?:\/\//, ""))}</a>
      </p>
      <p style="margin:0 0 12px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:#64748b;">
        Support: <a href="mailto:${escapeHtml(config.supportEmail)}" style="color:#0d9488;text-decoration:none;">${escapeHtml(config.supportEmail)}</a>
      </p>
      ${legalFooterHtml(config)}
      <p style="margin:14px 0 0 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:11px;color:#94a3b8;">
        &copy; ${year} Atlas AI OS. All rights reserved.
      </p>
    </td></tr>
  </table>`;
  return `<tr><td style="padding:24px 4px 0 4px;">${base}</td></tr>`;
}

/** Terms / Privacy links using the existing production legal routes. */
export function legalFooterHtml(config: AtlasEmailConfig): string {
  return `<p style="margin:0 0 0 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:11px;color:#94a3b8;">
    <a href="${config.siteUrl}/terms" style="color:#94a3b8;text-decoration:underline;">Terms of Service</a>
    &nbsp;&middot;&nbsp;
    <a href="${config.siteUrl}/privacy" style="color:#94a3b8;text-decoration:underline;">Privacy Policy</a>
  </p>`;
}

/** Bulletproof primary CTA (table + bgcolor for Outlook, anchor for the rest). */
export function primaryButtonHtml(params: { href: string; label: string }): string {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
      <tr>
        <td align="center" bgcolor="#0d9488" style="border-radius:8px;">
          <a href="${escapeHtml(params.href)}" target="_blank"
             style="display:inline-block;padding:12px 26px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;letter-spacing:0.01em;">
            ${escapeHtml(params.label)}
          </a>
        </td>
      </tr>
    </table>`;
}

/** Secondary/outline CTA. */
export function secondaryButtonHtml(params: { href: string; label: string }): string {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
      <tr>
        <td align="center" bgcolor="#ffffff" style="border:1px solid #0d9488;border-radius:8px;">
          <a href="${escapeHtml(params.href)}" target="_blank"
             style="display:inline-block;padding:11px 24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;color:#0d9488;text-decoration:none;border-radius:8px;">
            ${escapeHtml(params.label)}
          </a>
        </td>
      </tr>
    </table>`;
}

export function headingHtml(text: string): string {
  return `<h1 style="margin:0 0 12px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:24px;line-height:1.3;font-weight:800;letter-spacing:-0.02em;color:#0f172a;">${escapeHtml(text)}</h1>`;
}

export function paragraphHtml(text: string): string {
  return `<p style="margin:0 0 16px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#334155;">${escapeHtml(text)}</p>`;
}

/** Small muted paragraph (secondary info). */
export function mutedParagraphHtml(text: string): string {
  return `<p style="margin:0 0 16px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:#64748b;">${escapeHtml(text)}</p>`;
}

export function dividerHtml(): string {
  return `<tr><td style="padding:4px 0 20px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid #e2e8f0;"></td></tr></table></td></tr>`;
}

export function spacerHtml(height = 16): string {
  return `<tr><td style="height:${Math.max(0, height)}px;line-height:${Math.max(0, height)}px;font-size:0;">&nbsp;</td></tr>`;
}

export interface InfoRow {
  label: string;
  value: string;
}

/** Table-based info card (labels left, values right). */
export function infoCardHtml(rows: InfoRow[]): string {
  const rowsHtml = rows
    .map(
      (r) => `
        <tr>
          <td style="padding:10px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:#64748b;">${escapeHtml(r.label)}</td>
          <td style="padding:10px 0 10px 16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;color:#0f172a;text-align:right;">${escapeHtml(r.value)}</td>
        </tr>`,
    )
    .join("");
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="border:1px solid #e2e8f0;border-radius:10px;">
      <tr><td style="padding:4px 16px;">${rowsHtml}</td></tr>
    </table>`;
}

/** Pill badge with semantic tone. */
export function statusBadgeHtml(label: string, tone: EmailTone = "neutral"): string {
  const c = TONE_COLORS[tone];
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;">
      <tr>
        <td style="background-color:${c.bg};border-radius:999px;padding:6px 14px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:${c.text};">
          ${escapeHtml(label)}
        </td>
      </tr>
    </table>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Template variables
// ═══════════════════════════════════════════════════════════════════════════

export type TemplateVars = Record<string, string | number | null | undefined>;

/**
 * Render {{placeholders}} into HTML, escaping every value. Unknown variables
 * render as empty (never raw braces, never raw values).
 */
export function renderVars(html: string, vars: TemplateVars): string {
  return html.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) =>
    escapeHtml(vars[key] ?? ""),
  );
}

/** Same interpolation for plain text (subjects) — no HTML escaping needed. */
export function renderPlainVars(text: string, vars: TemplateVars): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) =>
    String(vars[key] ?? ""),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Templates
// ═══════════════════════════════════════════════════════════════════════════

export interface RenderedEmail {
  subject: string;
  html: string;
}

export type EmailTemplateName =
  | "invitation"
  | "welcome"
  | "email_verification"
  | "password_reset"
  | "complimentary_granted"
  | "complimentary_expiring"
  | "complimentary_revoked"
  | "subscription_activated"
  | "payment_successful"
  | "payment_failed"
  | "subscription_cancelled"
  | "trial_ending";

/** Build a complete email document from a content fragment + footer config. */
function compose(params: {
  config: AtlasEmailConfig;
  preheader: string;
  contentHtml: string;
}): string {
  return emailShell({
    preheader: params.preheader,
    bodyHtml: `
      <tr><td style="background-color:#ffffff;border-radius:14px;border:1px solid #eef2f7;padding:32px 32px 28px 32px;">
        ${headerHtml(params.config)}
        ${params.contentHtml}
      </td></tr>`,
    footerHtml: footerHtml(params.config),
  });
}

type EmailTemplateRenderer = (
  vars: TemplateVars,
  config: AtlasEmailConfig,
) => RenderedEmail;

export const EMAIL_TEMPLATES: Record<EmailTemplateName, EmailTemplateRenderer> = {
  // ── 1. Team invitation ──────────────────────────────────────────────────
  invitation: (v, config) => ({
    subject: renderPlainVars("You've been invited to Atlas", v),
    html: compose({
      config,
      preheader: "Your Atlas workspace is ready — accept your invitation.",
      contentHtml: `
        ${headingHtml("You've been invited to Atlas")}
        ${paragraphHtml("{{full_name}}, {{inviter_name}} has invited you to join {{organization_name}} on Atlas.")}
        ${paragraphHtml("Atlas helps restoration companies recover revenue that would otherwise be missed — with an AI workforce across claims, supplements, estimating, recovery, and customer success.")}
        ${spacerHtml(8)}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">${primaryButtonHtml({ href: "{{invite_url}}", label: "Accept Invitation" })}</td></tr></table>
        ${spacerHtml(12)}
        ${mutedParagraphHtml("If the button above doesn't work, copy and paste this link into your browser: {{invite_url}}")}
        ${mutedParagraphHtml("If you weren't expecting this invitation, you can safely ignore this email. Questions? Contact {{support_email}}.")}
      `,
    }),
  }),

  // ── 2. Welcome ──────────────────────────────────────────────────────────
  welcome: (v, config) => ({
    subject: renderPlainVars("Welcome to Atlas", v),
    html: compose({
      config,
      preheader: "Welcome to Atlas — your workspace is ready.",
      contentHtml: `
        ${headingHtml("Welcome to Atlas")}
        ${paragraphHtml("{{full_name}}, welcome aboard. Your workspace{{organization_name_phrase}} is ready.")}
        ${paragraphHtml("Atlas coordinates your AI workforce — claims, supplements, estimating, revenue recovery, and customer success — so nothing slips through the cracks.")}
        ${spacerHtml(8)}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">${primaryButtonHtml({ href: "{{login_url}}", label: "Open Atlas" })}</td></tr></table>
        ${spacerHtml(12)}
        ${mutedParagraphHtml("Need help getting started? Reply to this email or contact {{support_email}}.")}
      `,
    }),
  }),

  // ── 3. Email verification ───────────────────────────────────────────────
  email_verification: (v, config) => ({
    subject: renderPlainVars("Verify your Atlas email", v),
    html: compose({
      config,
      preheader: "Confirm your email address to finish setting up your Atlas account.",
      contentHtml: `
        ${headingHtml("Verify your email address")}
        ${paragraphHtml("{{full_name}}, confirm your email address to finish setting up your Atlas account. Verification protects your account and keeps your workspace secure.")}
        ${spacerHtml(8)}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">${primaryButtonHtml({ href: "{{verification_url}}", label: "Verify Email" })}</td></tr></table>
        ${spacerHtml(12)}
        ${mutedParagraphHtml("If you didn't create an Atlas account, you can safely ignore this email.")}
        ${mutedParagraphHtml("Questions? Contact {{support_email}}.")}
      `,
    }),
  }),

  // ── 4. Password reset ───────────────────────────────────────────────────
  password_reset: (v, config) => ({
    subject: renderPlainVars("Reset your Atlas password", v),
    html: compose({
      config,
      preheader: "Use the link below to choose a new password for your Atlas account.",
      contentHtml: `
        ${headingHtml("Reset your password")}
        ${paragraphHtml("{{full_name}}, we received a request to reset your Atlas password. Click below to choose a new one. This link expires shortly and can only be used once.")}
        ${spacerHtml(8)}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">${primaryButtonHtml({ href: "{{reset_url}}", label: "Reset Password" })}</td></tr></table>
        ${spacerHtml(12)}
        ${mutedParagraphHtml("Security note: never share this link or your password with anyone. Atlas will never ask for your password by email.")}
        ${mutedParagraphHtml("If you didn't request a password reset, you can safely ignore this email — your password will remain unchanged. Contact {{support_email}} if you need help.")}
      `,
    }),
  }),

  // ── 5. Complimentary access granted ─────────────────────────────────────
  complimentary_granted: (v, config) => ({
    subject: renderPlainVars("Your Atlas access is ready", v),
    html: compose({
      config,
      preheader: "Complimentary Atlas access has been granted to your organization.",
      contentHtml: `
        ${headingHtml("Your Atlas access is ready")}
        ${statusBadgeHtml("Complimentary Access", "success")}
        ${paragraphHtml("{{greeting}}Atlas access has been granted{{organization_name_phrase}}{{reason_phrase}}.")}
        ${spacerHtml(4)}
        ${infoCardHtml([
          { label: "Organization", value: "{{organization_name}}" },
          { label: "Access type", value: "Complimentary" },
          { label: "Expiration", value: "{{expiration_date}}" },
        ])}
        ${spacerHtml(16)}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">${primaryButtonHtml({ href: "{{login_url}}", label: "Open Atlas" })}</td></tr></table>
        ${spacerHtml(12)}
        ${mutedParagraphHtml("Sign in with your invited email address to get started. If you haven't accepted your invitation yet, you'll receive a separate invitation email with your sign-in link.")}
        ${mutedParagraphHtml("Questions? Contact {{support_email}}.")}
      `,
    }),
  }),

  // ── 6. Complimentary access expiring ────────────────────────────────────
  complimentary_expiring: (v, config) => ({
    subject: renderPlainVars("Your Atlas access expires soon", v),
    html: compose({
      config,
      preheader: "Your complimentary Atlas access ends on {{expiration_date}}.",
      contentHtml: `
        ${headingHtml("Your Atlas access expires soon")}
        ${statusBadgeHtml("Complimentary Access", "warning")}
        ${paragraphHtml("{{greeting}}complimentary access for {{organization_name}} ends on {{expiration_date}}.")}
        ${paragraphHtml("After that date, access to Atlas features for this workspace will end unless your organization subscribes to a plan.")}
        ${spacerHtml(8)}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">${primaryButtonHtml({ href: "{{upgrade_url}}", label: "Open Atlas" })}</td></tr></table>
        ${spacerHtml(12)}
        ${mutedParagraphHtml("If your access should continue, reach out to your Atlas contact or {{support_email}}.")}
      `,
    }),
  }),

  // ── 7. Complimentary access revoked ─────────────────────────────────────
  complimentary_revoked: (v, config) => ({
    subject: renderPlainVars("Your Atlas access has ended", v),
    html: compose({
      config,
      preheader: "Complimentary Atlas access for your organization has ended.",
      contentHtml: `
        ${headingHtml("Your complimentary access has ended")}
        ${statusBadgeHtml("Access Ended", "neutral")}
        ${paragraphHtml("{{greeting}}complimentary Atlas access for {{organization_name}} has been revoked, effective {{effective_date}}.")}
        ${paragraphHtml("If you believe this was a mistake, contact the Atlas team at {{support_email}} and we'll be happy to help.")}
      `,
    }),
  }),

  // ── 8. Subscription activated ───────────────────────────────────────────
  subscription_activated: (v, config) => ({
    subject: renderPlainVars("Your Atlas subscription is active", v),
    html: compose({
      config,
      preheader: "Your {{plan_name}} subscription is active.",
      contentHtml: `
        ${headingHtml("Your Atlas subscription is active")}
        ${statusBadgeHtml("Subscription Active", "success")}
        ${paragraphHtml("{{full_name}}, your {{plan_name}} subscription for {{organization_name}} is now active.")}
        ${spacerHtml(4)}
        ${infoCardHtml([
          { label: "Plan", value: "{{plan_name}}" },
          { label: "Billing interval", value: "{{billing_interval}}" },
          { label: "Amount", value: "{{amount}}" },
          { label: "Activation date", value: "{{activation_date}}" },
        ])}
        ${spacerHtml(16)}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">${primaryButtonHtml({ href: "{{login_url}}", label: "Open Atlas" })}</td></tr></table>
        ${spacerHtml(12)}
        ${mutedParagraphHtml("Questions about billing? Contact {{support_email}}.")}
      `,
    }),
  }),

  // ── 9. Payment successful ───────────────────────────────────────────────
  payment_successful: (v, config) => ({
    subject: renderPlainVars("Atlas payment received", v),
    html: compose({
      config,
      preheader: "Thank you — your Atlas payment was received.",
      contentHtml: `
        ${headingHtml("Payment received")}
        ${statusBadgeHtml("Payment Received", "success")}
        ${paragraphHtml("{{full_name}}, thank you. We received your Atlas payment.")}
        ${spacerHtml(4)}
        ${infoCardHtml([
          { label: "Amount", value: "{{amount}}" },
          { label: "Plan", value: "{{plan_name}}" },
          { label: "Billing date", value: "{{billing_date}}" },
          { label: "Organization", value: "{{organization_name}}" },
        ])}
        ${spacerHtml(16)}
        ${mutedParagraphHtml("This is a receipt for your records. Questions? Contact {{support_email}}.")}
      `,
    }),
  }),

  // ── 10. Payment failed ──────────────────────────────────────────────────
  payment_failed: (v, config) => ({
    subject: renderPlainVars("Action needed: Atlas payment failed", v),
    html: compose({
      config,
      preheader: "We couldn't process your Atlas payment — update your billing to avoid interruption.",
      contentHtml: `
        ${headingHtml("Action needed: your payment didn't go through")}
        ${statusBadgeHtml("Payment Failed", "danger")}
        ${paragraphHtml("{{full_name}}, we were unable to process your Atlas payment{{amount_phrase}} for the {{plan_name}} plan on {{organization_name}}.")}
        ${paragraphHtml("To avoid any interruption to your workspace, please update your billing information.")}
        ${spacerHtml(8)}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">${primaryButtonHtml({ href: "{{update_billing_url}}", label: "Update Billing" })}</td></tr></table>
        ${spacerHtml(12)}
        ${mutedParagraphHtml("Your current access is not affected by this message. If you believe this is a mistake, contact {{support_email}}.")}
      `,
    }),
  }),

  // ── 11. Subscription cancelled ──────────────────────────────────────────
  subscription_cancelled: (v, config) => ({
    subject: renderPlainVars("Your Atlas subscription has been cancelled", v),
    html: compose({
      config,
      preheader: "Your Atlas subscription has been cancelled.",
      contentHtml: `
        ${headingHtml("Your subscription has been cancelled")}
        ${statusBadgeHtml("Subscription Cancelled", "neutral")}
        ${paragraphHtml("{{full_name}}, your {{plan_name}} subscription for {{organization_name}} has been cancelled, effective {{effective_date}}.")}
        ${paragraphHtml("You'll continue to have access through the end of your current billing period. After that, the workspace will lose access to paid Atlas features.")}
        ${mutedParagraphHtml("Changed your mind? You can resubscribe anytime at {{login_url}}. Questions? Contact {{support_email}}.")}
      `,
    }),
  }),

  // ── 12. Trial ending ────────────────────────────────────────────────────
  trial_ending: (v, config) => ({
    subject: renderPlainVars("Your Atlas trial is ending soon", v),
    html: compose({
      config,
      preheader: "Your Atlas trial ends on {{trial_end_date}}.",
      contentHtml: `
        ${headingHtml("Your trial is ending soon")}
        ${statusBadgeHtml("Trial", "info")}
        ${paragraphHtml("{{full_name}}, your Atlas trial on the {{plan_name}} plan for {{organization_name}} ends on {{trial_end_date}}.")}
        ${paragraphHtml("To keep your workspace running without interruption, make sure your billing information is up to date before the trial ends.")}
        ${spacerHtml(8)}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">${primaryButtonHtml({ href: "{{manage_url}}", label: "Manage Subscription" })}</td></tr></table>
        ${spacerHtml(12)}
        ${mutedParagraphHtml("Questions? Contact {{support_email}}.")}
      `,
    }),
  }),
};

// ═══════════════════════════════════════════════════════════════════════════
// 6. Rendering + delivery
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Render a template with variables. `config` is required for a pure render
 * (previews, tests); `sendAtlasEmail` supplies it from the environment.
 */
export function renderEmail(
  name: EmailTemplateName,
  vars: TemplateVars,
  config: AtlasEmailConfig,
): RenderedEmail {
  const template = EMAIL_TEMPLATES[name];
  if (!template) {
    throw new Error(`Unknown email template: ${name}`);
  }
  const rendered = template(vars, config);
  // Interpolate {{placeholders}} across the full document (body + preheader),
  // escaping every value — nothing raw ever survives into the final HTML.
  return { subject: rendered.subject, html: renderVars(rendered.html, vars) };
}

export type EmailSendResult =
  | { ok: true; messageId: string | null }
  | { ok: false; error: string };

export interface SendAtlasEmailParams {
  to: string | string[];
  template: EmailTemplateName;
  vars: TemplateVars;
  config?: AtlasEmailConfig;
}

/**
 * Send a transactional email through Resend. Fail-open, never throws to the
 * caller: provider errors return a safe result. The API key is never part of
 * any error message or log.
 */
export async function sendAtlasEmail(params: SendAtlasEmailParams): Promise<EmailSendResult> {
  const apiKey = Deno.env.get("RESEND_API_KEY") ?? "";
  if (!apiKey) {
    console.error("[atlas-email] RESEND_API_KEY is not configured; email not sent.");
    return { ok: false, error: "Email service is not configured (RESEND_API_KEY missing)." };
  }

  const config = params.config ?? loadEmailConfig();
  const recipients = Array.isArray(params.to) ? params.to : [params.to];
  if (recipients.length === 0) {
    return { ok: false, error: "No recipient." };
  }

  let rendered: RenderedEmail;
  try {
    // Inject config-derived vars (caller values win on collision) so templates
    // never disagree with the footer and callers can't hard-code them.
    const vars: TemplateVars = {
      support_email: config.supportEmail,
      site_url: config.siteUrl,
      ...params.vars,
    };
    rendered = renderEmail(params.template, vars, config);
  } catch (e) {
    console.error("[atlas-email] template render failed:", e instanceof Error ? e.message : String(e));
    return { ok: false, error: "The email template could not be rendered." };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.from,
        ...(config.replyTo ? { reply_to: [config.replyTo] } : {}),
        to: recipients,
        subject: rendered.subject,
        html: rendered.html,
      }),
    });

    const body = await res.json().catch(() => null);

    if (!res.ok) {
      const providerError =
        body && typeof body === "object" && typeof body.message === "string"
          ? body.message.slice(0, 200)
          : `HTTP ${res.status}`;
      console.error(`[atlas-email] Resend rejected: HTTP ${res.status} ${providerError}`);
      const friendly =
        res.status === 401 || res.status === 403
          ? "Email service authentication failed."
          : res.status === 422
            ? "The email service rejected this recipient or sender configuration."
            : "The email service could not be reached.";
      return { ok: false, error: friendly };
    }

    const messageId =
      body && typeof body === "object" && typeof body.id === "string" ? body.id : null;
    console.info(
      `[atlas-email] ${params.template} accepted by provider for ${recipients.map(maskEmail).join(",")} id=${messageId ?? "?"}`,
    );
    return { ok: true, messageId };
  } catch (err) {
    console.error("[atlas-email] send failed:", err instanceof Error ? err.message : String(err));
    return { ok: false, error: "The email service could not be reached." };
  }
}