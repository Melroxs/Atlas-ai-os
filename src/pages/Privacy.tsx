import LegalLayout from "@/components/legal-layout";
import type { ReactNode } from "react";

/**
 * Public Privacy Policy (https://atlas-ai-os.com/privacy).
 *
 * Content reflects what Atlas actually collects and does today:
 *   - accounts are created with name/email/company (src/pages/Auth.tsx)
 *   - workspace + membership model (tenants/members)
 *   - customer-provided claims/documents/estimates/evidence are uploaded into
 *     per-tenant storage and processed by the Atlas pipeline
 *   - AI functionality may process submitted information (src/lib/ai-runtime,
 *     src/lib/agents) — vendors are not named because production usage is
 *     not confirmed
 *   - payments are processed by Paddle (src/lib/billing/paddle.ts,
 *     src/pages/BillingSettings.tsx)
 *   - theme preference + auth session are stored in browser local storage
 * No claims are made about specific regulations, certifications, or
 * model-training practices that cannot be verified from the repository.
 */

function Section({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`privacy-${n}`}>
      <h2 id={`privacy-${n}`} className="flex items-baseline gap-3 text-lg font-semibold tracking-tight text-foreground">
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

export default function Privacy() {
  return (
    <LegalLayout
      title="Privacy Policy"
      metaTitle="Privacy Policy | Atlas"
      metaDescription="How Atlas collects, uses, protects and processes information."
      eyebrow="Legal"
      updatedLabel="Last updated: September 2026"
    >
      <Section n="1" title="Introduction">
        <P>
          This Privacy Policy explains how Atlas ("we", "us", or "our") collects, uses, stores,
          and protects information in connection with the Atlas website, applications, software,
          AI functionality, and related services (the "Service"). This policy applies to
          information we collect when you use the Service, including when you visit our website,
          create an account, subscribe to a plan, or upload information to Atlas.
        </P>
      </Section>

      <Section n="2" title="Information We Collect">
        <P>We collect information in the following categories:</P>

        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Account Information</h3>
            <P>
              When you create an account, we collect information needed to establish and maintain
              your account, such as your name, email address, organization, role, authentication
              information (such as a password hash or sign-in tokens), and account preferences.
            </P>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-foreground">Organization and Business Information</h3>
            <P>
              When you set up a workspace, we collect information about your organization, such as
              company information, team members and their roles, claim and project information, and
              workflow information you provide or configure.
            </P>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-foreground">Customer-Provided Content</h3>
            <P>
              When you upload information to Atlas — including claims data, documents, estimates,
              evidence, notes, communications, and other information — we collect and process that
              content to provide the Service. You are responsible for ensuring that you have the
              appropriate rights and permissions to provide information to Atlas, and that your
              collection and sharing of that information complies with applicable law.
            </P>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-foreground">Usage and Technical Information</h3>
            <P>
              As you use the Service, we may collect technical and usage information such as IP
              addresses, browser and device information, log data, application activity,
              diagnostic information, and security events. This information helps us operate,
              secure, and improve the Service.
            </P>
          </div>
        </div>
      </Section>

      <Section n="3" title="How We Use Information">
        <P>We use the information we collect to:</P>
        <UL
          items={[
            "provide, operate, and maintain the Service;",
            "authenticate users and manage accounts;",
            "process subscriptions and related billing matters;",
            "provide AI functionality, including analyzing information you submit and generating outputs;",
            "process your requests and respond to your questions;",
            "improve the reliability, security, and performance of the Service;",
            "prevent abuse and fraud;",
            "communicate with you about your account, the Service, and important notices;",
            "comply with legal obligations.",
          ]}
        />
      </Section>

      <Section n="4" title="AI Processing">
        <P>
          Atlas uses artificial intelligence to analyze information submitted to the Service and
          generate outputs. Information you submit to Atlas may be processed by our AI systems and
          by the AI service providers we use where necessary to provide Atlas functionality. We
          do not use customer data to train third-party models unless a specific provider
          configuration or agreement confirms that this occurs.
        </P>
      </Section>

      <Section n="5" title="Payment Processing">
        <P>
          Subscription payments are processed through Paddle or another payment provider used by
          Atlas. Payment-card details are handled by the payment provider and are not stored by
          Atlas. Atlas retains only the subscription identifiers and billing state needed to
          resolve your access to the Service.
        </P>
      </Section>

      <Section n="6" title="Service Providers">
        <P>
          We may share information with service providers that help us deliver the Service,
          including providers of:
        </P>
        <UL
          items={[
            "hosting and infrastructure;",
            "database and storage services;",
            "authentication;",
            "payment processing;",
            "email and communications;",
            "analytics;",
            "AI and machine-learning services.",
          ]}
        />
        <P>
          These providers are permitted to use the information only as necessary to provide
          services to us and are expected to protect it appropriately.
        </P>
      </Section>

      <Section n="7" title="Data Retention">
        <P>
          We retain information for as long as reasonably necessary to provide the Service, comply
          with legal obligations, resolve disputes, and enforce our agreements. When you delete
          information from the Service, we will take reasonable steps to remove it from active use,
          subject to technical and legal retention requirements.
        </P>
      </Section>

      <Section n="8" title="Data Security">
        <P>
          We use reasonable technical and organizational safeguards designed to protect
          information against unauthorized access, alteration, disclosure, or destruction,
          including access controls and tenant isolation between customer workspaces. No method
          of transmission or storage is completely secure, and we cannot guarantee absolute
          security.
        </P>
      </Section>

      <Section n="9" title="International Data Transfers">
        <P>
          Atlas may process information in countries other than your own, depending on where our
          infrastructure and service providers are located. Where information is transferred
          across borders, we rely on appropriate safeguards and applicable legal mechanisms.
        </P>
      </Section>

      <Section n="10" title="Cookies and Similar Technologies">
        <P>
          Atlas uses local storage and similar browser technologies to store your theme preference
          and your authentication session so you can stay signed in. Atlas does not use
          advertising cookies or cross-site tracking cookies. You can clear browser storage at any
          time through your browser settings, which may sign you out of the Service.
        </P>
      </Section>

      <Section n="11" title="Customer Responsibilities">
        <P>You are responsible for ensuring that your use of the Service complies with applicable privacy and data-protection requirements. In particular, you are responsible for:</P>
        <UL
          items={[
            "lawfully collecting and using any personal information you provide to Atlas;",
            "obtaining necessary permissions from individuals whose information you upload;",
            "implementing appropriate access controls within your workspace;",
            "avoiding the unnecessary inclusion of sensitive information in content you upload;",
            "complying with applicable privacy and data-protection laws in your jurisdiction.",
          ]}
        />
      </Section>

      <Section n="12" title="Data Rights">
        <P>
          Depending on your jurisdiction, you may have rights regarding the personal information
          we hold about you, such as the right to access, correct, delete, or restrict the
          processing of your information, and the right to object to certain processing or to
          lodge a complaint with a supervisory authority. To exercise these rights, contact us
          using the information below. We will respond in accordance with applicable law.
        </P>
      </Section>

      <Section n="13" title="Children's Privacy">
        <P>
          Atlas is not intended for children, and we do not knowingly collect personal information
          from children. If you believe a child has provided us with personal information, please
          contact us so that we can take appropriate steps.
        </P>
      </Section>

      <Section n="14" title="Changes to the Privacy Policy">
        <P>
          We may update this Privacy Policy from time to time. When we make material changes, we
          will provide reasonable notice — for example, by updating the "Last updated" date above,
          posting a notice in the Service, or contacting you by email where required. Your
          continued use of the Service after changes take effect constitutes acceptance of the
          updated policy.
        </P>
      </Section>

      <Section n="15" title="Contact">
        <P>
          If you have questions or concerns about this Privacy Policy or how your information is
          handled, contact us at{" "}
          <a
            href="mailto:admin@atlas-ai-os.com"
            className="text-teal-700 underline underline-offset-2 transition-colors hover:text-teal-600 dark:text-teal-300"
          >
            admin@atlas-ai-os.com
          </a>
          , the public Atlas contact address.
        </P>
      </Section>
    </LegalLayout>
  );
}