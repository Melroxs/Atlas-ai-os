import LegalLayout from "@/components/legal-layout";
import type { ReactNode } from "react";

/**
 * Public Terms of Service (https://atlas-ai-os.com/terms).
 *
 * Subscription language reflects the actual Atlas billing model:
 *   - Plans: Atlas Starter, Atlas Growth, Atlas Scale
 *   - Intervals: monthly or annual
 *   - Provider: Paddle (Merchant of Record), per src/lib/billing/*
 * No prices, limits, or features are stated here beyond the plan names —
 * those live in the product's pricing surface and are not repeated here.
 */

function Section({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`tos-${n}`}>
      <h2 id={`tos-${n}`} className="flex items-baseline gap-3 text-lg font-semibold tracking-tight text-foreground">
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

export default function Terms() {
  return (
    <LegalLayout
      title="Terms of Service"
      metaTitle="Terms of Service | Atlas"
      metaDescription="Terms governing use of Atlas and its services."
      eyebrow="Legal"
      updatedLabel="Last updated: September 2026"
    >
      <Section n="1" title="Introduction">
        <P>
          These Terms of Service ("Terms") govern your access to and use of Atlas, including the
          Atlas website, applications, software, AI functionality, and related services (collectively,
          the "Service"). The Service is provided by the Atlas company identified in the Service
          (the "Company", "we", "us", or "our"). By accessing or using the Service, you agree to be
          bound by these Terms. If you do not agree to these Terms, you may not access or use the
          Service.
        </P>
      </Section>

      <Section n="2" title="Acceptance of Terms">
        <P>
          By accessing or using the Service — whether by creating an account, subscribing to a
          plan, uploading information, or otherwise — you acknowledge that you have read,
          understood, and agree to be bound by these Terms, as well as our Privacy Policy and
          Refund &amp; Cancellation Policy, which are incorporated by reference.
        </P>
      </Section>

      <Section n="3" title="Eligibility and Authority">
        <P>
          You must be at least 18 years old to use the Service. If you are using the Service on
          behalf of an organization, you represent and warrant that you have the authority to bind
          that organization to these Terms, and "you" will refer to both you individually and the
          organization. Where the Service is used in connection with claims, insurance, or other
          regulated matters, you are responsible for ensuring that you and your organization are
          properly licensed and authorized to perform the work you use Atlas for.
        </P>
      </Section>

      <Section n="4" title="Atlas Account and Organization">
        <P>When you create an Atlas account, you may be required to establish or join an organization ("workspace"). You are responsible for:</P>
        <UL
          items={[
            "providing accurate and complete account information, and keeping it up to date;",
            "maintaining the confidentiality of your account credentials;",
            "managing team members and their access to your workspace;",
            "all activity performed through your account, whether by you, your team members, or anyone using your credentials;",
            "safeguarding your account against unauthorized use, and promptly notifying us of any suspected unauthorized access.",
          ]}
        />
        <P>
          The organization that creates a workspace owns that workspace. Members you add may have
          access to the information and capabilities available in the workspace according to the
          permissions you assign. We are not responsible for activity performed by users you
          authorized to access your workspace.
        </P>
      </Section>

      <Section n="5" title="Atlas Subscription Plans">
        <P>
          Atlas offers subscription plans — including Atlas Starter, Atlas Growth, and Atlas
          Scale — each of which may be offered on monthly or annual billing intervals. The
          features, limits, and pricing applicable to each plan are described on the Atlas pricing
          page and in the checkout flow at the time of purchase. These Terms do not alter the
          terms of any plan you select; the plan you subscribe to, together with these Terms,
          governs your use of the Service.
        </P>
      </Section>

      <Section n="6" title="Billing and Automatic Renewal">
        <P>By subscribing to a paid plan, you agree to the following:</P>
        <UL
          items={[
            "subscriptions are billed according to the billing interval you select at checkout (monthly or annual);",
            "monthly subscriptions renew monthly and annual subscriptions renew annually;",
            "subscriptions continue on an automatic renewal basis until canceled;",
            "recurring charges are authorized through the applicable payment provider;",
            "applicable taxes may be collected in connection with your subscription as determined by the payment provider and applicable law;",
            "your billing information and payment processing may be handled by Atlas's payment provider, which may act as the merchant of record for transactions.",
          ]}
        />
        <P>
          We will not store full payment-card numbers in our systems. Payment details are processed
          by our payment provider in accordance with its terms and applicable law.
        </P>
      </Section>

      <Section n="7" title="Cancellation">
        <P>
          You may cancel your subscription at any time through the billing management portal
          available in your Atlas account settings, or by contacting us. Cancellation generally
          prevents the next renewal; you will continue to have access to the Service through the
          end of the period you have already paid for. Unless the Refund &amp; Cancellation Policy
          or applicable law provides otherwise, cancellation does not automatically create a
          refund for fees already paid.
        </P>
      </Section>

      <Section n="8" title="Refunds">
        <P>
          Refunds are governed by our Refund &amp; Cancellation Policy, available at
          <a href="/refunds" className="text-teal-700 underline underline-offset-2 transition-colors hover:text-teal-600 dark:text-teal-300">
            {" "}atlas-ai-os.com/refunds
          </a>. That policy controls whether and when refunds are issued; these Terms do not create
          any additional refund rights.
        </P>
      </Section>

      <Section n="9" title="Acceptable Use">
        <P>You agree not to use the Service to:</P>
        <UL
          items={[
            "engage in unlawful, abusive, or harmful activity;",
            "gain or attempt to gain unauthorized access to the Service, other users' accounts, or any systems or networks connected to the Service;",
            "commit fraud or misrepresent your identity, affiliation, or the content you provide;",
            "upload, transmit, or process content you do not have the right to process;",
            "interfere with, disrupt, or impair the operation of the Service, including by transmitting malware or conducting denial-of-service attacks;",
            "infringe the intellectual property, privacy, or other rights of third parties;",
            "attempt to circumvent access controls, billing, or payment mechanisms;",
            "use the Service in a manner that violates applicable law or regulation.",
          ]}
        />
      </Section>

      <Section n="10" title="Customer Content">
        <P>
          You may upload or submit information to the Service, including claims information,
          documents, estimates, evidence, project information, communications, and other business
          data ("Customer Content"). You retain ownership of your Customer Content. By providing
          Customer Content to the Service, you grant us a limited license to process, store, and
          use that content as necessary to provide, maintain, and improve the Service for you. We
          do not claim ownership of your Customer Content.
        </P>
      </Section>

      <Section n="11" title="AI-Generated Output">
        <P>
          Atlas may use artificial intelligence to analyze information you provide and generate
          outputs such as summaries, analyses, recommendations, drafts, and reports. AI-generated
          outputs may contain errors, omissions, or inaccuracies. You are responsible for
          reviewing AI-generated outputs before relying on or acting on them, and for any
          decisions you make based on them. We do not guarantee that AI-generated outputs are
          accurate, complete, or suitable for every situation. The Service is a tool to support
          qualified human judgment — it does not provide legal, insurance, financial, engineering,
          or other regulated professional advice, and should not be used as a substitute for the
          judgment of appropriately qualified professionals.
        </P>
      </Section>

      <Section n="12" title="Intellectual Property">
        <P>
          The Service — including our software, platform, branding, interfaces, documentation,
          proprietary technology, workflows, and underlying systems — is owned by us or our
          licensors and is protected by intellectual property laws. Subject to these Terms, we
          grant you a limited, non-exclusive, non-transferable right to use the Service for your
          internal business purposes. You retain all rights in your Customer Content, and nothing
          in these Terms transfers ownership of your content to us.
        </P>
      </Section>

      <Section n="13" title="Third-Party Services">
        <P>
          The Service may integrate with, or rely upon, third-party services, APIs, hosting
          providers, AI providers, payment providers, and other infrastructure. We are not
          responsible for the availability, performance, or practices of third-party services, and
          your use of any third-party service is subject to that service's own terms. The
          availability or performance of third-party services may affect Atlas functionality.
        </P>
      </Section>

      <Section n="14" title="Confidentiality">
        <P>
          Each party agrees to hold the other party's non-public information disclosed in
          connection with the Service in confidence, and to use it only for the purposes of the
          Service relationship. This obligation does not apply to information that is publicly
          available, independently developed, lawfully received from a third party, or required
          to be disclosed by law.
        </P>
      </Section>

      <Section n="15" title="Security">
        <P>
          We use reasonable technical and organizational safeguards designed to protect Customer
          Content and the Service against unauthorized access, loss, or alteration. No method of
          transmission or storage is completely secure, and we cannot guarantee that our systems
          are immune to every security threat.
        </P>
      </Section>

      <Section n="16" title="Suspension and Termination">
        <P>We may suspend or terminate your access to the Service, in whole or in part, if:</P>
        <UL
          items={[
            "you fail to pay amounts due when required;",
            "you violate these Terms or our Acceptable Use rules;",
            "we reasonably believe your use constitutes abuse, unlawful activity, or a security risk;",
            "continued operation is required for operational or legal necessity.",
          ]}
        />
        <P>
          Where we suspend or terminate for reasons within your control, we will use reasonable
          efforts to notify you in advance where practicable. Upon termination, you remain
          responsible for fees incurred through the end of the applicable billing period, subject
          to the Refund &amp; Cancellation Policy and applicable law.
        </P>
      </Section>

      <Section n="17" title="Disclaimers">
        <P>
          The Service is provided on an "as available" basis. To the maximum extent permitted by
          applicable law, we disclaim all warranties, whether express, implied, or statutory,
          including implied warranties of merchantability, fitness for a particular purpose, and
          non-infringement. We do not warrant that the Service will be uninterrupted, error-free,
          or that AI-generated outputs will be accurate or complete. Nothing in these Terms
          excludes or limits warranties or rights that cannot be excluded or limited under
          applicable law.
        </P>
      </Section>

      <Section n="18" title="Limitation of Liability">
        <P>
          To the maximum extent permitted by applicable law, neither we nor our affiliates,
          licensors, or service providers will be liable for any indirect, incidental, special,
          consequential, or punitive damages, or for lost profits, revenue, data, or business
          opportunities, arising out of or related to your use of the Service. Our total
          aggregate liability arising out of or related to the Service, whether in contract, tort,
          or otherwise, will not exceed the amounts you paid to us for the Service during the
          twelve (12) months preceding the event giving rise to the claim. Nothing in these Terms
          limits liability that cannot be limited under applicable law.
        </P>
      </Section>

      <Section n="19" title="Indemnification">
        <P>
          To the extent permitted by applicable law, you agree to indemnify, defend, and hold
          harmless the Company and its affiliates, officers, directors, employees, and agents from
          and against any claims, liabilities, damages, losses, and expenses (including reasonable
          attorneys' fees) arising out of or related to: (a) your use of the Service; (b) your
          Customer Content; (c) your violation of these Terms; or (d) your violation of
          applicable law or the rights of any third party.
        </P>
      </Section>

      <Section n="20" title="Changes to Terms">
        <P>
          We may update these Terms from time to time to reflect changes in the Service, our
          practices, or legal requirements. When we make material changes, we will provide
          reasonable notice — for example, by updating the "Last updated" date above, posting a
          notice in the Service, or contacting you by email where required. Your continued use of
          the Service after the updated Terms take effect constitutes acceptance of the updated
          Terms.
        </P>
      </Section>

      <Section n="21" title="Governing Law">
        <P>
          These Terms and your use of the Service are governed by the laws of the jurisdiction of
          the Company's principal place of business, without regard to conflict-of-law
          principles, to be confirmed as follows:
        </P>
        <p className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-3 font-medium text-amber-800 dark:text-amber-200">
          [GOVERNING LAW / JURISDICTION TO BE CONFIRMED]
        </p>
        <P>
          Any dispute arising out of or relating to these Terms or the Service will be subject to
          the exclusive jurisdiction of the courts in that jurisdiction, subject to any
          mandatory provisions of applicable law.
        </P>
      </Section>

      <Section n="22" title="Contact">
        <P>
          If you have questions about these Terms or the Service, you may contact us at{" "}
          <a
            href="mailto:sales@atlas-ai-os.com"
            className="text-teal-700 underline underline-offset-2 transition-colors hover:text-teal-600 dark:text-teal-300"
          >
            sales@atlas-ai-os.com
          </a>
          , the public Atlas contact address. If that address is not yet confirmed for legal
          correspondence, please reach out through the contact information displayed on the Atlas
          website.
        </P>
      </Section>
    </LegalLayout>
  );
}