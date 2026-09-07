import LegalLayout from "@/components/legal-layout";
import type { ReactNode } from "react";

/**
 * Public Refund & Cancellation Policy (https://atlas-ai-os.com/refunds).
 *
 * Consistent with the actual Atlas billing implementation:
 *   - Plans bill monthly or annually (src/lib/billing/plans.ts)
 *   - Subscriptions renew automatically at the applicable interval
 *   - Cancellation is handled through the billing management portal
 *     (Paddle customer portal, linked from Atlas billing settings as
 *     "Manage billing" — src/pages/BillingSettings.tsx) and by contacting
 *     support
 *   - Paddle processes payments as Merchant of Record (per BillingSettings)
 * No exact retry schedules, refund guarantees, or downgrade mechanics are
 * stated because they are not implemented in the repository.
 */

function Section({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`refunds-${n}`}>
      <h2 id={`refunds-${n}`} className="flex items-baseline gap-3 text-lg font-semibold tracking-tight text-foreground">
        <span className="font-mono text-xs text-teal-600 dark:text-teal-300">{n}</span>
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-sm leading-7 text-muted-foreground">{children}</div>
    </section>
  );
}

function P({ children }: { children: ReactNode }) {
  return <p>{children}</p>;
}

function UL({ items }: { items: ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5 marker:text-teal-600/70 dark:marker:text-teal-300/70">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

export default function Refunds() {
  return (
    <LegalLayout
      title="Refund & Cancellation Policy"
      metaTitle="Refund & Cancellation Policy | Atlas"
      metaDescription="Atlas subscription cancellation, billing and refund policy."
      eyebrow="Legal"
      updatedLabel="Last updated: September 2026"
    >
      <Section n="1" title="Subscription Billing">
        <P>
          Atlas subscriptions may be billed monthly or annually according to the plan and billing
          interval selected during checkout. When you subscribe, you authorize charges for the
          applicable billing interval in accordance with the Terms of Service.
        </P>
      </Section>

      <Section n="2" title="Automatic Renewal">
        <P>
          Subscriptions automatically renew at the applicable interval (monthly or annual) unless
          you cancel before the renewal date. When a subscription renews, the applicable recurring
          charge is processed through the payment method associated with your account.
        </P>
      </Section>

      <Section n="3" title="Cancellation">
        <P>You can cancel your subscription at any time:</P>
        <UL
          items={[
            "through the billing management portal available in your Atlas account (under Billing settings), which is provided by Atlas's payment processor; or",
            "by contacting Atlas support using the contact information below.",
          ]}
        />
        <P>
          Cancellation takes effect at the end of the current billing period. You will retain
          access to the Service through the end of the period you have already paid for.
        </P>
      </Section>

      <Section n="4" title="Refunds">
        <P>Our refund policy is as follows:</P>
        <UL
          items={[
            "subscription fees are generally non-refundable, except where required by law or expressly stated otherwise;",
            "billing errors or duplicate charges can be reported to support for review and correction;",
            "refund requests may be reviewed individually;",
            "approved refunds will be processed through the applicable payment provider.",
          ]}
        />
        <P>
          We evaluate refund requests on a case-by-case basis. Approval of a refund request does
          not create an ongoing refund entitlement.
        </P>
      </Section>

      <Section n="5" title="Failed Payments">
        <P>
          If a payment fails or becomes overdue, we may attempt to retry the payment, restrict
          access to paid features, suspend your account, or cancel your subscription, as
          appropriate under the circumstances. We will use reasonable efforts to notify you before
          your access is suspended or your subscription is canceled.
        </P>
      </Section>

      <Section n="6" title="Downgrades">
        <P>
          Downgrade availability is subject to the applicable billing functionality available in
          your Atlas account at the time. If you change plans, the change takes effect according
          to the terms presented during the change, and billing may be prorated as applicable.
        </P>
      </Section>

      <Section n="7" title="Taxes">
        <P>
          Applicable taxes may be charged on your subscription as determined by the payment
          provider and applicable law. Where taxes are charged, they will be reflected on your
          invoice.
        </P>
      </Section>

      <Section n="8" title="Payment Provider">
        <P>
          Paddle may process payments and related billing transactions on Atlas's behalf. Paddle
          acts as the Merchant of Record for Atlas subscriptions, handling payment processing,
          invoicing, tax handling, and customer billing management. Payment-card details are
          handled by Paddle and are not stored by Atlas.
        </P>
      </Section>

      <Section n="9" title="Contact">
        <P>
          For questions about billing, cancellation, or refunds, contact us at{" "}
          <a
            href="mailto:sales@atlas-ai-os.com"
            className="text-teal-700 underline underline-offset-2 transition-colors hover:text-teal-600 dark:text-teal-300"
          >
            sales@atlas-ai-os.com
          </a>
          , the public Atlas contact address.
        </P>
      </Section>
    </LegalLayout>
  );
}