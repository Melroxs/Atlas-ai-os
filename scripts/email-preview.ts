// scripts/email-preview.ts
//
// Local-only email template preview generator (Phase 9 — development support).
//
// Renders every branded Atlas email template with realistic sample data into
// `email-preview/` as static HTML so the team can inspect desktop/mobile
// rendering without sending a single email. Never contacts Resend, never
// reads or prints secrets.
//
// Usage:
//   bun run email:preview      (or: bun scripts/email-preview.ts)
// Then open email-preview/index.html in a browser.
//
// The email module only touches Deno.env inside delivery functions; this
// script calls renderEmail() with an explicit preview config, so it runs
// cleanly under Bun without a Deno global.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  renderEmail,
  formatExpiration,
  formatDate,
  formatAmount,
  greetingLine,
  type AtlasEmailConfig,
  type EmailTemplateName,
} from "../supabase/functions/_shared/email.ts";

// Preview-only config — mirrors the production contract but is not a secret.
const CONFIG: AtlasEmailConfig = {
  from: "Atlas <notifications@atlas-ai-os.com>",
  replyTo: "support@atlas-ai-os.com",
  siteUrl: "https://atlas-ai-os.com",
  supportEmail: "support@atlas-ai-os.com",
};

const ORG = "Everest Restoration Co.";
const NAME = "Jane Cooper";
const LOGIN_URL = `${CONFIG.siteUrl}/auth?returnTo=%2Fdashboard`;
const BILLING_URL = `${CONFIG.siteUrl}/dashboard/billing`;
const EXPIRES_MS = Date.UTC(2026, 9, 8); // Oct 8, 2026

const PREVIEW_VARS: Record<EmailTemplateName, Record<string, string | number | null | undefined>> = {
  invitation: {
    full_name: NAME,
    inviter_name: "Melissa Reyes",
    organization_name: ORG,
    invite_url: LOGIN_URL,
  },
  welcome: {
    full_name: NAME,
    organization_name_phrase: ` for ${ORG}`,
    login_url: LOGIN_URL,
  },
  email_verification: {
    full_name: NAME,
    verification_url: `${CONFIG.siteUrl}/verify?token=demo-token`,
  },
  password_reset: {
    full_name: NAME,
    reset_url: `${CONFIG.siteUrl}/reset?token=demo-token`,
  },
  complimentary_granted: {
    greeting: greetingLine(NAME),
    organization_name: ORG,
    organization_name_phrase: ` for ${ORG}`,
    reason_phrase: " (Pilot customer)",
    expiration_date: formatExpiration(EXPIRES_MS),
    login_url: LOGIN_URL,
  },
  complimentary_expiring: {
    greeting: greetingLine(NAME),
    organization_name: ORG,
    expiration_date: formatDate(EXPIRES_MS),
    upgrade_url: BILLING_URL,
  },
  complimentary_revoked: {
    greeting: greetingLine(NAME),
    organization_name: ORG,
    effective_date: formatDate(Date.now()),
  },
  subscription_activated: {
    full_name: NAME,
    plan_name: "Atlas Growth",
    billing_interval: "Monthly",
    amount: formatAmount("149.00", "USD"),
    activation_date: formatDate(Date.now()),
    organization_name: ORG,
    login_url: LOGIN_URL,
  },
  payment_successful: {
    full_name: NAME,
    amount: formatAmount("149.00", "USD"),
    plan_name: "Atlas Growth",
    billing_date: formatDate(Date.now()),
    organization_name: ORG,
  },
  payment_failed: {
    full_name: NAME,
    amount_phrase: " of USD 149.00",
    plan_name: "Atlas Growth",
    organization_name: ORG,
    update_billing_url: BILLING_URL,
  },
  subscription_cancelled: {
    full_name: NAME,
    plan_name: "Atlas Growth",
    organization_name: ORG,
    effective_date: formatDate(Date.now()),
    login_url: LOGIN_URL,
  },
  trial_ending: {
    full_name: NAME,
    plan_name: "Atlas Growth",
    organization_name: ORG,
    trial_end_date: formatDate(Date.UTC(2026, 8, 10)),
    manage_url: BILLING_URL,
  },
};

const OUT_DIR = join(process.cwd(), "email-preview");

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function buildGallery(templates: { name: EmailTemplateName; subject: string }[]): string {
  const cards = templates
    .map(
      (t) => `
    <section style="margin:0 0 40px 0;">
      <h2 style="margin:0 0 2px 0;font-family:sans-serif;font-size:18px;">${escapeAttr(t.name)}</h2>
      <p style="margin:0 0 12px 0;font-family:sans-serif;font-size:13px;color:#64748b;">Subject: ${escapeAttr(t.subject)}</p>
      <div style="display:flex;gap:16px;flex-wrap:wrap;">
        <div>
          <p style="margin:0 0 6px 0;font-family:sans-serif;font-size:11px;color:#94a3b8;text-transform:uppercase;">Desktop (600px)</p>
          <iframe title="${escapeAttr(t.name)} desktop" src="./${escapeAttr(t.name)}.html" style="width:600px;height:520px;border:1px solid #e2e8f0;border-radius:8px;background:#fff;"></iframe>
        </div>
        <div>
          <p style="margin:0 0 6px 0;font-family:sans-serif;font-size:11px;color:#94a3b8;text-transform:uppercase;">Mobile (375px)</p>
          <iframe title="${escapeAttr(t.name)} mobile" src="./${escapeAttr(t.name)}.html" style="width:375px;height:520px;border:1px solid #e2e8f0;border-radius:8px;background:#fff;"></iframe>
        </div>
      </div>
    </section>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Atlas Email Templates — Preview</title>
</head>
<body style="margin:0;padding:32px;background:#f8fafc;">
  <h1 style="margin:0 0 4px 0;font-family:sans-serif;font-size:24px;">Atlas Email Templates</h1>
  <p style="margin:0 0 32px 0;font-family:sans-serif;font-size:13px;color:#64748b;">
    Local preview of all branded transactional emails. No emails were sent — these are static renders.
  </p>
  ${cards}
</body>
</html>`;
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });

  const names = Object.keys(PREVIEW_VARS) as EmailTemplateName[];
  const entries: { name: EmailTemplateName; subject: string }[] = [];

  for (const name of names) {
    const rendered = renderEmail(name, PREVIEW_VARS[name], CONFIG);
    writeFileSync(join(OUT_DIR, `${name}.html`), rendered.html, "utf8");
    entries.push({ name, subject: rendered.subject });
    console.log(`  rendered ${name}.html  (${rendered.subject})`);
  }

  writeFileSync(join(OUT_DIR, "index.html"), buildGallery(entries), "utf8");
  console.log(`\nDone — ${entries.length} templates written to ${OUT_DIR}/`);
  console.log(`Open ${OUT_DIR}/index.html in a browser to review desktop + mobile widths.`);
}

main();