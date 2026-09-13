/**
 * Tests for the shared Atlas branded email system (supabase/functions/_shared/email.ts).
 *
 * The module reads secrets via Deno.env at call time, so we stub a minimal
 * Deno global — the same way the Supabase Edge Runtime provides it. The tests
 * pin the production contract: branded templates, config-driven sender,
 * auto-injected support/site vars, provider-error safety, and that secrets
 * never leak into rendered HTML, logs, or client-visible results.
 */
import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import {
  EMAIL_TEMPLATES,
  renderEmail,
  sendAtlasEmail,
  loadEmailConfig,
  atlasEmailFrom,
  atlasSiteUrl,
  maskEmail,
  escapeHtml,
  formatExpiration,
  formatDate,
  formatAmount,
  greetingLine,
  type EmailTemplateName,
  type AtlasEmailConfig,
} from "./email.ts";

const API_KEY = "re_secret_test_key_1234567890";
const envStore = new Map<string, string>();

const CONFIG: AtlasEmailConfig = {
  from: "Atlas AI OS <admin@atlas-ai-os.com>",
  replyTo: "admin@atlas-ai-os.com",
  siteUrl: "https://atlas-ai-os.com",
  supportEmail: "admin@atlas-ai-os.com",
};

function stubDeno() {
  (globalThis as Record<string, unknown>).Deno = {
    env: {
      get: (key: string) => envStore.get(key) ?? null,
    },
  };
}

/** Realistic sample variables for every template. */
const SAMPLE: Record<EmailTemplateName, Record<string, string | number | null | undefined>> = {
  invitation: {
    full_name: "Jane Cooper",
    inviter_name: "Melissa Reyes",
    organization_name: "Everest Restoration Co.",
    invite_url: "https://atlas-ai-os.com/auth?returnTo=%2Fdashboard",
  },
  welcome: {
    full_name: "Jane Cooper",
    organization_name_phrase: " for Everest Restoration Co.",
    login_url: "https://atlas-ai-os.com/auth?returnTo=%2Fdashboard",
  },
  email_verification: {
    full_name: "Jane Cooper",
    verification_url: "https://atlas-ai-os.com/verify?token=abc123",
  },
  password_reset: {
    full_name: "Jane Cooper",
    reset_url: "https://atlas-ai-os.com/reset?token=abc123",
  },
  complimentary_granted: {
    greeting: "Jane Cooper, ",
    organization_name: "Everest Restoration Co.",
    organization_name_phrase: " for Everest Restoration Co.",
    reason_phrase: " (Pilot customer)",
    expiration_date: "October 8, 2026",
    login_url: "https://atlas-ai-os.com/auth?returnTo=%2Fdashboard",
  },
  complimentary_expiring: {
    greeting: "Jane Cooper, ",
    organization_name: "Everest Restoration Co.",
    expiration_date: "October 8, 2026",
    upgrade_url: "https://atlas-ai-os.com/dashboard/billing",
  },
  complimentary_revoked: {
    greeting: "Jane Cooper, ",
    organization_name: "Everest Restoration Co.",
    effective_date: "September 8, 2026",
  },
  subscription_activated: {
    full_name: "Jane Cooper",
    plan_name: "Atlas Growth",
    billing_interval: "Monthly",
    amount: "USD 149.00",
    activation_date: "September 8, 2026",
    organization_name: "Everest Restoration Co.",
    login_url: "https://atlas-ai-os.com/auth?returnTo=%2Fdashboard",
  },
  payment_successful: {
    full_name: "Jane Cooper",
    amount: "USD 149.00",
    plan_name: "Atlas Growth",
    billing_date: "September 8, 2026",
    organization_name: "Everest Restoration Co.",
  },
  payment_failed: {
    full_name: "Jane Cooper",
    amount_phrase: " of USD 149.00",
    plan_name: "Atlas Growth",
    organization_name: "Everest Restoration Co.",
    update_billing_url: "https://atlas-ai-os.com/dashboard/billing",
  },
  subscription_cancelled: {
    full_name: "Jane Cooper",
    plan_name: "Atlas Growth",
    organization_name: "Everest Restoration Co.",
    effective_date: "September 8, 2026",
    login_url: "https://atlas-ai-os.com/auth?returnTo=%2Fdashboard",
  },
  trial_ending: {
    full_name: "Jane Cooper",
    plan_name: "Atlas Growth",
    organization_name: "Everest Restoration Co.",
    trial_end_date: "September 10, 2026",
    manage_url: "https://atlas-ai-os.com/dashboard/billing",
  },
};

describe("email module", () => {
  beforeEach(() => {
    envStore.clear();
    envStore.set("RESEND_API_KEY", API_KEY);
    envStore.set("ATLAS_EMAIL_FROM", "Atlas AI OS <admin@atlas-ai-os.com>");
    envStore.set("ATLAS_EMAIL_REPLY_TO", "admin@atlas-ai-os.com");
    envStore.set("ATLAS_APP_URL", "https://atlas-ai-os.com");
    stubDeno();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    envStore.clear();
  });

  describe("configuration", () => {
    it("loads sender, reply-to, and site URL from ATLAS_* env vars", () => {
      const cfg = loadEmailConfig();
      expect(cfg.from).toBe("Atlas AI OS <admin@atlas-ai-os.com>");
      expect(cfg.replyTo).toBe("admin@atlas-ai-os.com");
      expect(cfg.siteUrl).toBe("https://atlas-ai-os.com");
      expect(cfg.supportEmail).toBe("admin@atlas-ai-os.com");
    });

    it("falls back to RESEND_SENDER_NAME / RESEND_SENDER_EMAIL when ATLAS_EMAIL_FROM is unset", () => {
      envStore.delete("ATLAS_EMAIL_FROM");
      envStore.set("RESEND_SENDER_NAME", "Atlas Team");
      envStore.set("RESEND_SENDER_EMAIL", "team@atlas-ai-os.com");
      expect(atlasEmailFrom()).toBe("Atlas Team <team@atlas-ai-os.com>");
    });

    it("defaults to the canonical Atlas sender when nothing is configured", () => {
      envStore.delete("ATLAS_EMAIL_FROM");
      envStore.delete("ATLAS_EMAIL_REPLY_TO");
      envStore.delete("ATLAS_SUPPORT_EMAIL");
      envStore.delete("ATLAS_APP_URL");
      envStore.delete("SITE_URL");
      const cfg = loadEmailConfig();
      expect(cfg.from).toBe("Atlas AI OS <admin@atlas-ai-os.com>");
      expect(cfg.replyTo).toBe("admin@atlas-ai-os.com");
      expect(cfg.supportEmail).toBe("admin@atlas-ai-os.com");
      expect(cfg.siteUrl).toBe("https://atlas-ai-os.com");
    });

    it("defaults the site URL and support address when not configured", () => {
      envStore.delete("ATLAS_APP_URL");
      envStore.delete("SITE_URL");
      expect(atlasSiteUrl()).toBe("https://atlas-ai-os.com");
      const cfg = loadEmailConfig();
      expect(cfg.supportEmail).toBe("admin@atlas-ai-os.com");
    });

    it("uses SITE_URL as a legacy fallback for the app URL", () => {
      envStore.delete("ATLAS_APP_URL");
      envStore.set("SITE_URL", "https://atlas-ai-os.com");
      expect(atlasSiteUrl()).toBe("https://atlas-ai-os.com");
    });
  });

  describe("template contract — every template", () => {
    const names = Object.keys(EMAIL_TEMPLATES) as EmailTemplateName[];
    expect(names.length).toBe(12);

    it.each(names)("%s renders a complete branded document", (name) => {
      const t = renderEmail(name, SAMPLE[name] ?? {}, CONFIG);
      expect(t.subject.length).toBeGreaterThan(0);
      expect(t.html).toContain("<!DOCTYPE html>");
      expect(t.html).toContain("<meta name=\"viewport\"");
      expect(t.html).toContain("max-width:600px"); // mobile-safe layout
      expect(t.html).toContain("ATLAS"); // text wordmark (email-safe, no hotlinked logo)
      expect(t.html).toContain("AI&nbsp;OS");
      expect(t.html).toContain("Terms of Service");
      expect(t.html).toContain("Privacy Policy");
      expect(t.html).toContain(CONFIG.siteUrl);
      expect(t.html).toContain("admin@atlas-ai-os.com");
      // No raw placeholders survive rendering
      expect(t.html).not.toContain("{{");
      expect(t.html).not.toContain("}}");
      // No JavaScript ever ships inside an email
      expect(t.html).not.toContain("<script");
      expect(t.html).not.toContain("javascript:");
    });

    it("subject lines match the production contract", () => {
      const subjects: Record<EmailTemplateName, string> = {
        invitation: "You've been invited to Atlas",
        welcome: "Welcome to Atlas",
        email_verification: "Verify your Atlas email",
        password_reset: "Reset your Atlas password",
        complimentary_granted: "Your Atlas access is ready",
        complimentary_expiring: "Your Atlas access expires soon",
        complimentary_revoked: "Your Atlas access has ended",
        subscription_activated: "Your Atlas subscription is active",
        payment_successful: "Atlas payment received",
        payment_failed: "Action needed: Atlas payment failed",
        subscription_cancelled: "Your Atlas subscription has been cancelled",
        trial_ending: "Your Atlas trial is ending soon",
      };
      for (const name of Object.keys(subjects) as EmailTemplateName[]) {
        expect(renderEmail(name, SAMPLE[name] ?? {}, CONFIG).subject).toBe(subjects[name]);
      }
    });
  });

  describe("template rendering details", () => {
    it("renders the invitation with names, org, CTA, and link fallback", () => {
      const t = renderEmail("invitation", SAMPLE.invitation, CONFIG);
      expect(t.html).toContain("Jane Cooper");
      expect(t.html).toContain("Melissa Reyes has invited you");
      expect(t.html).toContain("Everest Restoration Co.");
      expect(t.html).toContain("Accept Invitation");
      expect(t.html).toContain("https://atlas-ai-os.com/auth?returnTo=%2Fdashboard");
    });

    it("escapes user-supplied values (XSS never survives into the email)", () => {
      const t = renderEmail(
        "invitation",
        {
          full_name: "<img src=x onerror=alert(1)>",
          inviter_name: 'ACME & "Sons"',
          organization_name: "<script>alert(1)</script>",
          invite_url: "https://atlas-ai-os.com/auth",
        },
        CONFIG,
      );
      expect(t.html).not.toContain("<img");
      expect(t.html).not.toContain("<script");
      expect(t.html).toContain("ACME &amp; &quot;Sons&quot;");
    });

    it("renders missing optional variables as empty (never raw braces)", () => {
      const t = renderEmail("welcome", { full_name: "Jane" }, CONFIG);
      expect(t.html).not.toContain("{{");
      expect(t.html).toContain("Jane");
    });

    it("welcome renders org phrase and login CTA", () => {
      const t = renderEmail("welcome", SAMPLE.welcome, CONFIG);
      expect(t.html).toContain("for Everest Restoration Co.");
      expect(t.html).toContain("Open Atlas");
    });

    it("email verification and password reset render their CTAs and guidance", () => {
      const v = renderEmail("email_verification", SAMPLE.email_verification, CONFIG);
      expect(v.html).toContain("Verify Email");
      expect(v.html).toContain("confirm your email address");
      const r = renderEmail("password_reset", SAMPLE.password_reset, CONFIG);
      expect(r.html).toContain("Reset Password");
      expect(r.html).toContain("never share this link");
      expect(r.html).toContain("your password will remain unchanged");
    });

    it("complimentary granted: status badge, org, reason, expiration — no Paddle/billing wording", () => {
      const t = renderEmail("complimentary_granted", SAMPLE.complimentary_granted, CONFIG);
      expect(t.html).toContain("Complimentary Access");
      expect(t.html).toContain("Everest Restoration Co.");
      expect(t.html).toContain("Pilot customer");
      expect(t.html).toContain("October 8, 2026");
      expect(t.html).toContain("Open Atlas");
      const low = t.html.toLowerCase();
      expect(low).not.toContain("paddle");
      expect(low).not.toContain("subscription");
      expect(low).not.toContain("$");
      expect(low).not.toContain("billing");
    });

    it("complimentary lifetime renders as no expiration", () => {
      const t = renderEmail(
        "complimentary_granted",
        { ...SAMPLE.complimentary_granted, expiration_date: "No expiration (lifetime)" },
        CONFIG,
      );
      expect(t.html).toContain("No expiration (lifetime)");
      expect(t.html).not.toContain("9999");
    });

    it("complimentary expiring includes the expiration date and what happens next", () => {
      const t = renderEmail("complimentary_expiring", SAMPLE.complimentary_expiring, CONFIG);
      expect(t.html).toContain("October 8, 2026");
      expect(t.html).toContain("access to Atlas features for this workspace will end");
      expect(t.html).toContain("Open Atlas");
    });

    it("complimentary revoked is neutral and professional", () => {
      const t = renderEmail("complimentary_revoked", SAMPLE.complimentary_revoked, CONFIG);
      expect(t.html).toContain("revoked, effective September 8, 2026");
      expect(t.html).toContain("admin@atlas-ai-os.com");
    });

    it("subscription activated shows plan, interval, amount, activation date", () => {
      const t = renderEmail("subscription_activated", SAMPLE.subscription_activated, CONFIG);
      expect(t.html).toContain("Atlas Growth");
      expect(t.html).toContain("Monthly");
      expect(t.html).toContain("USD 149.00");
      expect(t.html).toContain("September 8, 2026");
      expect(t.html).toContain("Subscription Active");
    });

    it("payment successful shows a receipt-style summary", () => {
      const t = renderEmail("payment_successful", SAMPLE.payment_successful, CONFIG);
      expect(t.html).toContain("USD 149.00");
      expect(t.html).toContain("Atlas Growth");
      expect(t.html).toContain("Everest Restoration Co.");
    });

    it("payment failed has a clear, non-alarming action CTA", () => {
      const t = renderEmail("payment_failed", SAMPLE.payment_failed, CONFIG);
      expect(t.html).toContain("Update Billing");
      expect(t.html).toContain("we were unable to process your Atlas payment");
      expect(t.html).toContain("not affected by this message");
    });

    it("subscription cancelled states plan, effective date, and access implications", () => {
      const t = renderEmail("subscription_cancelled", SAMPLE.subscription_cancelled, CONFIG);
      expect(t.html).toContain("Atlas Growth");
      expect(t.html).toContain("effective September 8, 2026");
      expect(t.html).toContain("continue to have access through the end of your current billing period");
      expect(t.html).toContain("resubscribe anytime");
    });

    it("trial ending shows the trial end date and Manage Subscription CTA", () => {
      const t = renderEmail("trial_ending", SAMPLE.trial_ending, CONFIG);
      expect(t.html).toContain("September 10, 2026");
      expect(t.html).toContain("Manage Subscription");
      expect(t.html).toContain("before the trial ends");
    });
  });

  describe("sendAtlasEmail", () => {
    it("sends via Resend with sender, reply-to, and auto-injected support/site vars", async () => {
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "msg_123" }), { status: 200 }),
      );

      const result = await sendAtlasEmail({
        to: "jane@example.com",
        template: "invitation",
        vars: SAMPLE.invitation,
      });

      expect(result).toEqual({ ok: true, messageId: "msg_123" });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.resend.com/emails");
      const body = JSON.parse(String(init.body));
      expect(body.from).toBe("Atlas AI OS <admin@atlas-ai-os.com>");
      expect(body.reply_to).toEqual(["admin@atlas-ai-os.com"]);
      expect(body.to).toEqual(["jane@example.com"]);
      expect(body.subject).toBe("You've been invited to Atlas");
      // The API key travels only in the server-side Authorization header
      expect(String(init.headers?.["Authorization"] ?? init.headers)).toContain(API_KEY);
      // ...and never inside the rendered HTML that reaches the recipient
      expect(body.html).not.toContain(API_KEY);
      expect(body.html).not.toContain("re_secret");
      // Auto-injected config vars made it into the message
      expect(body.html).toContain("admin@atlas-ai-os.com");
    });

    it("handles provider errors safely without leaking the API key or provider internals", async () => {
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "rate limited" }), { status: 429 }),
      );

      const result = await sendAtlasEmail({
        to: "jane@example.com",
        template: "welcome",
        vars: SAMPLE.welcome,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("email service could not be reached");
        expect(result.error).not.toContain(API_KEY);
        expect(result.error).not.toContain("rate limited"); // provider internals stay server-side
      }
    });

    it("fails closed when RESEND_API_KEY is missing", async () => {
      envStore.delete("RESEND_API_KEY");
      const result = await sendAtlasEmail({
        to: "jane@example.com",
        template: "welcome",
        vars: SAMPLE.welcome,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("RESEND_API_KEY");
    });

    it("never throws on network failure and masks internals", async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNRESET"));
      const result = await sendAtlasEmail({
        to: "jane@example.com",
        template: "welcome",
        vars: SAMPLE.welcome,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).not.toContain("ECONNRESET");
    });

    it("rejects an unknown template name without calling the provider", async () => {
      const result = await sendAtlasEmail({
        to: "jane@example.com",
        template: "not_a_template" as EmailTemplateName,
        vars: {},
      });
      expect(result.ok).toBe(false);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });
  });

  describe("helpers", () => {
    it("masks emails in logs", () => {
      expect(maskEmail("jane@example.com")).toBe("ja***@example.com");
      expect(maskEmail("no-at")).toBe("***");
    });

    it("escapes HTML", () => {
      expect(escapeHtml(`<b>&"'`)).toBe("&lt;b&gt;&amp;&quot;&#39;");
    });

    it("formats expiration: lifetime and readable dates", () => {
      expect(formatExpiration(null)).toBe("No expiration (lifetime)");
      expect(formatExpiration(undefined)).toBe("No expiration (lifetime)");
      expect(formatExpiration(Date.parse("2026-10-08T00:00:00Z"))).toContain("2026");
    });

    it("formats readable dates", () => {
      expect(formatDate("2026-09-08T00:00:00Z")).toBe("September 8, 2026");
      expect(formatDate(null)).toBe("");
      expect(formatDate(undefined)).toBe("");
    });

    it("formats amounts with currency", () => {
      expect(formatAmount("149.00", "USD")).toBe("USD 149.00");
      expect(formatAmount(149, null)).toBe("USD 149");
      expect(formatAmount(null, "USD")).toBe("");
    });

    it("greetingLine keeps complimentary mailings grammatical", () => {
      expect(greetingLine("Jane Cooper")).toBe("Jane Cooper, ");
      expect(greetingLine("")).toBe("");
      expect(greetingLine(undefined)).toBe("");
    });
  });
});