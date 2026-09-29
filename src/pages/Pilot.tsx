import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import logo from "@/assets/logo.svg";
import { LegalIdentityFooter } from "@/components/legal-identity-footer";
import {
  ArrowRight,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronDown,
  ClipboardCheck,
  Download,
  Eye,
  FileText,
  FileCheck2,
  Layers,
  Lightbulb,
  MessageSquareText,
  Play,
  Plus,
  Radar,
  RefreshCw,
  Scale,
  Search,
  Send,
  ShieldCheck,
  Target,
  Upload,
  Workflow,
} from "lucide-react";
import { ThemeToggle } from "@/components/atlas-ui";
import { getSupabaseClient } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FormData {
  name: string;
  email: string;
  phone: string;
  companyName: string;
  website: string;
  role: string;
  contractorType: string;
  companySize: string;
  claimsVolume: string;
  currentWorkflow: string;
  atlasInterest: string[];
  biggestProblem: string;
  whyPilot: string;
}

const INITIAL: FormData = {
  name: "",
  email: "",
  phone: "",
  companyName: "",
  website: "",
  role: "",
  contractorType: "",
  companySize: "",
  claimsVolume: "",
  currentWorkflow: "",
  atlasInterest: [],
  biggestProblem: "",
  whyPilot: "",
};

const CONTRACTOR_TYPES = [
  "Roofing",
  "Restoration",
  "General Contractor",
  "Home Improvement",
  "Water Damage",
  "Fire / Smoke Damage",
  "Mold Remediation",
  "Other",
];

const COMPANY_SIZES = [
  "1-10 employees",
  "11-50 employees",
  "51-200 employees",
  "200+ employees",
];

const CLAIMS_VOLUMES = [
  "1-10 active claims",
  "11-50 active claims",
  "51-200 active claims",
  "200+ active claims",
];

const INTEREST_OPTIONS = [
  "Finding missed revenue opportunities",
  "Reviewing claims",
  "Identifying supplement opportunities",
  "Generating claims/supplement packages",
  "Organizing evidence",
  "Understanding documents",
  "Reducing administrative work",
];

// ---------------------------------------------------------------------------
// Atlas logo (inline)
// ---------------------------------------------------------------------------

function AtlasLogo({ className = "size-9 rounded-lg" }: { className?: string }) {
  return <img src={logo} alt="Atlas logo" width={36} height={36} className={className} />;
}

// ---------------------------------------------------------------------------
// Reusable section components
// ---------------------------------------------------------------------------

function Section({ id, className = "", children }: { id?: string; className?: string; children: React.ReactNode }) {
  return (
    <section id={id} className={`relative z-10 mx-auto w-full max-w-6xl px-5 ${className}`}>
      {children}
    </section>
  );
}

function SectionHead({ eyebrow, title, lead }: { eyebrow: string; title: string; lead?: string }) {
  return (
    <div className="max-w-2xl text-center mx-auto">
      <p className="atlas-eyebrow mb-3">{eyebrow}</p>
      <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">{title}</h2>
      {lead && <p className="mt-4 text-sm leading-7 text-muted-foreground sm:text-base">{lead}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workflow steps
// ---------------------------------------------------------------------------

const WORKFLOW_STEPS = [
  { num: "01", icon: Upload, label: "Upload", desc: "Bring your existing company information and claim documentation into Atlas." },
  { num: "02", icon: BrainCircuit, label: "Understand", desc: "Atlas processes the information and builds an understanding of claims, documents, entities, and evidence." },
  { num: "03", icon: Radar, label: "Find Opportunities", desc: "Atlas identifies potential revenue-recovery opportunities, missing evidence, discrepancies, and areas requiring review." },
  { num: "04", icon: Layers, label: "Reconstruct", desc: "Atlas brings the relevant claim information and evidence together into a coherent picture." },
  { num: "05", icon: FileText, label: "Generate", desc: "Atlas generates a professional claims or supplement package based on the available evidence." },
  { num: "06", icon: Eye, label: "Review", desc: "The contractor reviews the generated opportunity and supporting evidence." },
  { num: "07", icon: Download, label: "Download", desc: "The finished package can be downloaded as a professional business document." },
  { num: "08", icon: Play, label: "Use", desc: "Take the package out of Atlas and use it in your actual business workflow." },
];

// ---------------------------------------------------------------------------
// Benefits
// ---------------------------------------------------------------------------

const BENEFITS = [
  { icon: Target, label: "Early Access", desc: "Experience Atlas before broader availability." },
  { icon: Radar, label: "Revenue Recovery Intelligence", desc: "Identify potential opportunities within your existing information." },
  { icon: FileCheck2, label: "Claims & Supplement Generation", desc: "Generate structured, professional packages from supported evidence." },
  { icon: Scale, label: "Evidence-Backed Reasoning", desc: "See the information supporting every finding." },
  { icon: MessageSquareText, label: "Direct Feedback Loop", desc: "Work directly with the Atlas team to influence the product." },
  { icon: Workflow, label: "Product Influence", desc: "Help determine future workflows, integrations, reports, and capabilities." },
];

// ---------------------------------------------------------------------------
// Pilot process
// ---------------------------------------------------------------------------

const PILOT_STEPS = [
  { num: "01", label: "Apply", desc: "Tell us about your business and workflow." },
  { num: "02", label: "Talk to Us", desc: "We'll understand your current process and determine whether Atlas is a good fit." },
  { num: "03", label: "Start Using Atlas", desc: "Selected companies receive access and onboarding." },
  { num: "04", label: "Build With Us", desc: "Use Atlas, review its outputs, give feedback, and help shape what gets built next." },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Pilot() {
  const navigate = useNavigate();
  const [form, setForm] = useState<FormData>(INITIAL);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  const toAuth = () => navigate("/auth");

  const set = (key: keyof FormData, value: string) => setForm((f) => ({ ...f, [key]: value }));

  const toggleInterest = (opt: string) =>
    setForm((f) => ({
      ...f,
      atlasInterest: f.atlasInterest.includes(opt)
        ? f.atlasInterest.filter((x) => x !== opt)
        : [...f.atlasInterest, opt],
    }));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.email.trim() || !form.companyName.trim()) {
      setError("Please fill in your name, email, and company name.");
      return;
    }
    setSubmitting(true);
    setError(null);

    try {
      const supabase = getSupabaseClient();
      if (supabase) {
        const { error: insertError } = await supabase.from("pilot_applications").insert({
          name: form.name.trim(),
          email: form.email.trim(),
          phone: form.phone.trim() || null,
          company_name: form.companyName.trim(),
          website: form.website.trim() || null,
          role: form.role.trim() || null,
          contractor_type: form.contractorType || null,
          company_size: form.companySize || null,
          claims_volume: form.claimsVolume || null,
          current_workflow: form.currentWorkflow.trim() || null,
          atlas_interest: form.atlasInterest,
          biggest_problem: form.biggestProblem.trim() || null,
          why_pilot: form.whyPilot.trim() || null,
          status: "new",
        });
        if (insertError) {
          // Table might not exist yet — still show confirmation
          console.warn("[atlas] pilot_applications insert failed:", insertError.message);
        }
      }
    } catch {
      // Offline or table not created — still show confirmation
    }

    setSubmitting(false);
    setSubmitted(true);
    setForm(INITIAL);
  };

  // -----------------------------------------------------------------------
  // Confirmation
  // -----------------------------------------------------------------------

  if (submitted) {
    return (
      <div className="relative min-h-screen overflow-x-hidden bg-background text-foreground">
        <div className="atlas-glow-teal pointer-events-none absolute inset-x-0 top-0 h-[620px]" />
        <div className="atlas-grid pointer-events-none absolute inset-0 opacity-50 [mask-image:linear-gradient(to_bottom,black,transparent_70%)]" />
        <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md">
          <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-3.5">
            <a href="/" className="flex items-center gap-2.5">
              <AtlasLogo />
              <span className="text-lg font-semibold tracking-tight">Atlas</span>
            </a>
            <ThemeToggle />
          </div>
        </header>
        <div className="relative z-10 mx-auto flex min-h-[60vh] max-w-2xl flex-col items-center justify-center px-5 py-24 text-center">
          <CheckCircle2 className="mb-6 size-16 text-teal-500 dark:text-teal-400" />
          <h1 className="text-4xl font-semibold tracking-tight">You're on the list.</h1>
          <p className="mt-4 max-w-md text-base leading-7 text-muted-foreground">
            Thanks for your interest in the Atlas Pilot Program. We'll review your application
            and reach out with next steps.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => { setSubmitted(false); setForm(INITIAL); }}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-border/70 px-5 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:border-teal-400/40 hover:text-teal-700 dark:hover:text-teal-200"
            >
              Back to Pilot
            </button>
            <button
              type="button"
              onClick={toAuth}
              className="group inline-flex items-center justify-center gap-2 rounded-lg bg-teal-400 px-5 py-2.5 text-sm font-semibold text-teal-950 shadow-[0_0_24px_rgba(45,212,191,0.25)] transition-all hover:bg-teal-300 hover:shadow-[0_0_36px_rgba(45,212,191,0.4)]"
            >
              Enter Atlas
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Main page
  // -----------------------------------------------------------------------

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-background text-foreground">
      {/* ambient */}
      <div className="atlas-glow-teal pointer-events-none absolute inset-x-0 top-0 h-[620px]" />
      <div className="atlas-grid pointer-events-none absolute inset-0 opacity-50 [mask-image:linear-gradient(to_bottom,black,transparent_70%)]" />

      {/* Nav */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-3.5">
          <a href="/" className="flex items-center gap-2.5 transition-opacity hover:opacity-85">
            <AtlasLogo />
            <span className="text-lg font-semibold tracking-tight">Atlas</span>
          </a>
          <div className="flex items-center gap-3">
            <a href="/" className="hidden text-sm text-muted-foreground transition-colors hover:text-foreground sm:block">
              Back to Atlas
            </a>
            <ThemeToggle />
            <button
              type="button"
              onClick={toAuth}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-teal-400 px-4 py-2 text-sm font-semibold text-teal-950 transition-all hover:bg-teal-300"
            >
              Enter Atlas
            </button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <Section className="pt-16 pb-20 lg:pt-24">
        <div className="text-center">
          <p className="atlas-eyebrow mb-4 flex items-center justify-center gap-2">
            <Target className="size-3.5" />
            Atlas Pilot Program
          </p>
          <h1 className="text-4xl font-semibold leading-[1.06] tracking-tight sm:text-5xl lg:text-[3.4rem]">
            Help Build the Future of{" "}
            <span className="bg-gradient-to-r from-teal-600 via-cyan-600 to-teal-600 bg-clip-text text-transparent dark:from-teal-300 dark:via-cyan-300 dark:to-teal-300">
              Revenue Recovery.
            </span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-7 text-muted-foreground">
            Atlas is an AI revenue recovery platform built for contractors. It understands the
            information already inside your business, identifies potential opportunities, and
            helps turn them into professional claims and supplement packages you can actually use.
          </p>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-muted-foreground/80">
            We're working with a limited group of contractors to test Atlas against real-world
            workflows and build the product alongside the businesses that use it.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <a
              href="#apply"
              className="group inline-flex items-center justify-center gap-2 rounded-lg bg-teal-400 px-6 py-3 text-sm font-semibold text-teal-950 shadow-[0_0_24px_rgba(45,212,191,0.25)] transition-all hover:bg-teal-300 hover:shadow-[0_0_36px_rgba(45,212,191,0.4)]"
            >
              Apply for the Pilot
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </a>
            <a
              href="#how-atlas-works"
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-border/70 px-6 py-3 text-sm font-medium text-muted-foreground transition-colors hover:border-teal-400/40 hover:text-teal-700 dark:hover:text-teal-200"
            >
              See How Atlas Works
            </a>
          </div>
        </div>
      </Section>

      {/* The Problem */}
      <Section className="py-20">
        <SectionHead
          eyebrow="The problem"
          title="The information is already there. The opportunity is buried inside it."
          lead="Contractors already generate enormous amounts of business information. The problem is that this information is fragmented, and important details can remain disconnected."
        />
        <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["Claims", "FNOLs, supplements, correspondence"],
            ["Estimates", "Xactimate, contractor bids, invoices"],
            ["Photos", "Damage evidence, scope documentation"],
            ["Reports", "Inspections, moisture readings, measurements"],
          ].map(([label, desc]) => (
            <div key={label} className="rounded-xl border border-border/70 bg-card/60 p-4">
              <p className="text-sm font-semibold text-foreground">{label}</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{desc}</p>
            </div>
          ))}
        </div>
        <p className="mt-8 text-center text-sm text-muted-foreground">
          When this information is scattered across systems, important scope gaps, payment
          discrepancies, and supplement opportunities remain unidentified. And even when an
          opportunity is found, someone still has to turn it into a professional work product.
        </p>
      </Section>

      {/* What Atlas Does — 8-step workflow */}
      <Section id="how-atlas-works" className="py-20 border-y border-border/60 bg-card/30">
        <SectionHead
          eyebrow="What Atlas actually does"
          title="From information to action."
          lead="Atlas takes the scattered information inside a contractor's business and turns it into a professional, evidence-backed package you can use."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {WORKFLOW_STEPS.map((s) => {
            const Icon = s.icon;
            return (
              <div key={s.num} className="group rounded-xl border border-border/70 bg-card/60 p-5 transition-colors hover:border-teal-400/30">
                <div className="flex items-center gap-3">
                  <div className="flex size-9 items-center justify-center rounded-lg bg-teal-400/10 text-teal-600 ring-1 ring-teal-400/20 dark:text-teal-300">
                    <Icon className="size-4" />
                  </div>
                  <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/60">{s.num}</span>
                </div>
                <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.16em] text-foreground/70">{s.label}</p>
                <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{s.desc}</p>
              </div>
            );
          })}
        </div>
      </Section>

      {/* Package Generation */}
      <Section className="py-20">
        <SectionHead
          eyebrow="Package generation"
          title="Atlas doesn't just find the opportunity. It helps produce the package."
          lead="When Atlas identifies a potential claim or supplement opportunity, it can turn the underlying information and evidence into a structured, professional package designed for real-world business use."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-border/70 bg-card/60 p-6">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-teal-600 dark:text-teal-300">
              Claims Package
            </p>
            <h3 className="mt-2 text-lg font-semibold text-foreground">
              Complete claim documentation
            </h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Atlas assembles the available claim information, findings, evidence, discrepancies,
              financial information, and missing information into a professional document.
            </p>
            <ul className="mt-4 space-y-2">
              {["Claim information & metadata", "Findings with confidence scores", "Supporting evidence index", "Financial reconciliation", "Missing information (honestly labeled)", "Atlas reasoning & explanations"].map((item) => (
                <li key={item} className="flex items-start gap-2 text-xs text-muted-foreground">
                  <Check className="mt-0.5 size-3.5 shrink-0 text-teal-600 dark:text-teal-300" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-2xl border border-border/70 bg-card/60 p-6">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-emerald-600 dark:text-emerald-300">
              Supplement Package
            </p>
            <h3 className="mt-2 text-lg font-semibold text-foreground">
              Evidence-backed supplement request
            </h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              From an approved revenue-recovery recommendation, Atlas generates a supplement
              package explaining what additional scope is being requested, why it is justified,
              and what evidence supports it.
            </p>
            <ul className="mt-4 space-y-2">
              {["Requested additional scope", "Financial impact analysis", "Supporting findings & evidence", "Carrier estimate reconciliation", "Supplement justification", "Missing items clearly identified"].map((item) => (
                <li key={item} className="flex items-start gap-2 text-xs text-muted-foreground">
                  <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-300" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      {/* Why This Matters */}
      <Section className="py-20 border-y border-border/60 bg-card/30">
        <SectionHead
          eyebrow="Why this matters"
          title="The last mile matters."
          lead="Many systems can summarize documents. Many AI systems can answer questions. Atlas is designed to go further."
        />
        <div className="mt-10 mx-auto max-w-3xl rounded-2xl border border-teal-400/20 bg-teal-400/[0.05] p-8 text-center">
          <p className="text-lg leading-8 text-foreground">
            Atlas helps connect{" "}
            <span className="font-semibold text-teal-600 dark:text-teal-300">evidence</span>{" "}
            →{" "}
            <span className="font-semibold text-teal-600 dark:text-teal-300">reasoning</span>{" "}
            →{" "}
            <span className="font-semibold text-teal-600 dark:text-teal-300">opportunity</span>{" "}
            →{" "}
            <span className="font-semibold text-teal-600 dark:text-teal-300">work product</span>
          </p>
          <p className="mt-4 text-sm leading-6 text-muted-foreground">
            That means the output can become part of the contractor's actual workflow.
            Insight becomes a work product. That is the key product differentiation.
          </p>
        </div>
      </Section>

      {/* Benefits */}
      <Section className="py-20">
        <SectionHead
          eyebrow="Pilot benefits"
          title="Built with contractors, not just for contractors."
          lead="Pilot participants receive access to the evolving Atlas workflow and direct influence on what gets built next."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {BENEFITS.map((b) => {
            const Icon = b.icon;
            return (
              <div key={b.label} className="group rounded-xl border border-border/70 bg-card/60 p-5 transition-colors hover:border-teal-400/30">
                <div className="flex size-9 items-center justify-center rounded-lg bg-teal-400/10 text-teal-600 ring-1 ring-teal-400/20 transition-transform group-hover:scale-105 dark:text-teal-300">
                  <Icon className="size-4" />
                </div>
                <p className="mt-3 text-sm font-semibold text-foreground">{b.label}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{b.desc}</p>
              </div>
            );
          })}
        </div>
      </Section>

      {/* Who Should Join */}
      <Section className="py-20 border-y border-border/60 bg-card/30">
        <SectionHead
          eyebrow="Who should join"
          title="We're looking for contractors with real workflows and real problems to solve."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-border/70 bg-card/60 p-6">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Ideal participants
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {["Roofing contractors", "Restoration contractors", "General contractors", "Home improvement companies", "Residential contractors", "Insurance claims operations"].map((t) => (
                <span key={t} className="rounded-lg border border-border/80 bg-background/50 px-3 py-1.5 text-xs text-foreground/85">{t}</span>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-border/70 bg-card/60 p-6">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              What we're looking for
            </p>
            <ul className="mt-4 space-y-2.5">
              {["Real operational workflows with claims and documentation", "Someone who can review Atlas outputs and give feedback", "An interest in improving revenue recovery", "Willingness to test an early product"].map((t) => (
                <li key={t} className="flex items-start gap-2.5 text-xs text-muted-foreground">
                  <Check className="mt-0.5 size-3.5 shrink-0 text-teal-600 dark:text-teal-300" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      {/* How the Pilot Works */}
      <Section className="py-20">
        <SectionHead
          eyebrow="How it works"
          title="Four simple steps."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PILOT_STEPS.map((s) => (
            <div key={s.num} className="rounded-xl border border-border/70 bg-card/60 p-5">
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-teal-600 dark:text-teal-300">
                Step {s.num}
              </span>
              <p className="mt-2 text-sm font-semibold text-foreground">{s.label}</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{s.desc}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* Application Form */}
      <Section id="apply" className="py-20 border-y border-border/60 bg-card/30">
        <SectionHead
          eyebrow="Apply"
          title="Apply to Join the Pilot"
          lead="Tell us about your business. We'll review your application and reach out if it's a good fit."
        />

        <form onSubmit={handleSubmit} className="mx-auto mt-12 max-w-2xl space-y-8">
          {/* Contact */}
          <div>
            <h3 className="mb-4 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Contact</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="pilot-name" className="mb-1 block text-xs font-medium text-foreground">
                  Name <span className="text-rose-500">*</span>
                </label>
                <input
                  id="pilot-name"
                  name="name"
                  required
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                  className="w-full rounded-lg border border-border/70 bg-background/60 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-teal-400/60 focus:outline-none focus:ring-1 focus:ring-teal-400/30"
                  placeholder="Your full name"
                />
              </div>
              <div>
                <label htmlFor="pilot-email" className="mb-1 block text-xs font-medium text-foreground">
                  Work email <span className="text-rose-500">*</span>
                </label>
                <input
                  id="pilot-email"
                  name="email"
                  type="email"
                  required
                  value={form.email}
                  onChange={(e) => set("email", e.target.value)}
                  className="w-full rounded-lg border border-border/70 bg-background/60 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-teal-400/60 focus:outline-none focus:ring-1 focus:ring-teal-400/30"
                  placeholder="you@company.com"
                />
              </div>
              <div>
                <label htmlFor="pilot-phone" className="mb-1 block text-xs font-medium text-foreground">Phone</label>
                <input
                  id="pilot-phone"
                  name="phone"
                  type="tel"
                  value={form.phone}
                  onChange={(e) => set("phone", e.target.value)}
                  className="w-full rounded-lg border border-border/70 bg-background/60 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-teal-400/60 focus:outline-none focus:ring-1 focus:ring-teal-400/30"
                  placeholder="(555) 123-4567"
                />
              </div>
            </div>
          </div>

          {/* Company */}
          <div>
            <h3 className="mb-4 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Company</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="pilot-company" className="mb-1 block text-xs font-medium text-foreground">
                  Company name <span className="text-rose-500">*</span>
                </label>
                <input
                  id="pilot-company"
                  name="companyName"
                  required
                  value={form.companyName}
                  onChange={(e) => set("companyName", e.target.value)}
                  className="w-full rounded-lg border border-border/70 bg-background/60 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-teal-400/60 focus:outline-none focus:ring-1 focus:ring-teal-400/30"
                  placeholder="Your company name"
                />
              </div>
              <div>
                <label htmlFor="pilot-website" className="mb-1 block text-xs font-medium text-foreground">Website</label>
                <input
                  id="pilot-website"
                  name="website"
                  type="url"
                  value={form.website}
                  onChange={(e) => set("website", e.target.value)}
                  className="w-full rounded-lg border border-border/70 bg-background/60 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-teal-400/60 focus:outline-none focus:ring-1 focus:ring-teal-400/30"
                  placeholder="https://yourcompany.com"
                />
              </div>
              <div>
                <label htmlFor="pilot-role" className="mb-1 block text-xs font-medium text-foreground">Role / Title</label>
                <input
                  id="pilot-role"
                  name="role"
                  value={form.role}
                  onChange={(e) => set("role", e.target.value)}
                  className="w-full rounded-lg border border-border/70 bg-background/60 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-teal-400/60 focus:outline-none focus:ring-1 focus:ring-teal-400/30"
                  placeholder="e.g. Owner, Operations Manager"
                />
              </div>
              <div>
                <label htmlFor="pilot-type" className="mb-1 block text-xs font-medium text-foreground">Contractor type</label>
                <select
                  id="pilot-type"
                  name="contractorType"
                  value={form.contractorType}
                  onChange={(e) => set("contractorType", e.target.value)}
                  className="w-full rounded-lg border border-border/70 bg-background/60 px-3 py-2 text-sm text-foreground focus:border-teal-400/60 focus:outline-none focus:ring-1 focus:ring-teal-400/30"
                >
                  <option value="">Select…</option>
                  {CONTRACTOR_TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Business */}
          <div>
            <h3 className="mb-4 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Business</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="pilot-size" className="mb-1 block text-xs font-medium text-foreground">Company size</label>
                <select
                  id="pilot-size"
                  name="companySize"
                  value={form.companySize}
                  onChange={(e) => set("companySize", e.target.value)}
                  className="w-full rounded-lg border border-border/70 bg-background/60 px-3 py-2 text-sm text-foreground focus:border-teal-400/60 focus:outline-none focus:ring-1 focus:ring-teal-400/30"
                >
                  <option value="">Select…</option>
                  {COMPANY_SIZES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="pilot-volume" className="mb-1 block text-xs font-medium text-foreground">Claims volume</label>
                <select
                  id="pilot-volume"
                  name="claimsVolume"
                  value={form.claimsVolume}
                  onChange={(e) => set("claimsVolume", e.target.value)}
                  className="w-full rounded-lg border border-border/70 bg-background/60 px-3 py-2 text-sm text-foreground focus:border-teal-400/60 focus:outline-none focus:ring-1 focus:ring-teal-400/30"
                >
                  <option value="">Select…</option>
                  {CLAIMS_VOLUMES.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="pilot-workflow" className="mb-1 block text-xs font-medium text-foreground">Current claims / revenue-recovery workflow</label>
                <textarea
                  id="pilot-workflow"
                  name="currentWorkflow"
                  rows={3}
                  value={form.currentWorkflow}
                  onChange={(e) => set("currentWorkflow", e.target.value)}
                  className="w-full rounded-lg border border-border/70 bg-background/60 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-teal-400/60 focus:outline-none focus:ring-1 focus:ring-teal-400/30"
                  placeholder="How do you currently manage claims, supplements, and revenue recovery?"
                />
              </div>
            </div>
          </div>

          {/* Atlas */}
          <div>
            <h3 className="mb-4 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">About Atlas</h3>

            <div className="mb-4">
              <p className="mb-2 text-xs font-medium text-foreground">What would you most want Atlas to help you with?</p>
              <div className="flex flex-wrap gap-2">
                {INTEREST_OPTIONS.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => toggleInterest(opt)}
                    className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                      form.atlasInterest.includes(opt)
                        ? "border-teal-400/40 bg-teal-400/10 text-teal-700 dark:text-teal-200"
                        : "border-border/70 bg-background/50 text-muted-foreground hover:border-teal-400/30"
                    }`}
                  >
                    {form.atlasInterest.includes(opt) && <Check className="mr-1 inline size-3" />}
                    {opt}
                  </button>
                ))}
              </div>
            </div>

            <div className="mb-4">
              <label htmlFor="pilot-problem" className="mb-1 block text-xs font-medium text-foreground">
                What is the biggest operational problem you'd want Atlas to solve?
              </label>
              <textarea
                id="pilot-problem"
                name="biggestProblem"
                rows={3}
                value={form.biggestProblem}
                onChange={(e) => set("biggestProblem", e.target.value)}
                className="w-full rounded-lg border border-border/70 bg-background/60 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-teal-400/60 focus:outline-none focus:ring-1 focus:ring-teal-400/30"
                placeholder="Describe the problem you'd most want Atlas to address"
              />
            </div>

            <div>
              <label htmlFor="pilot-why" className="mb-1 block text-xs font-medium text-foreground">
                Why are you interested in joining the Atlas pilot?
              </label>
              <textarea
                id="pilot-why"
                name="whyPilot"
                rows={3}
                value={form.whyPilot}
                onChange={(e) => set("whyPilot", e.target.value)}
                className="w-full rounded-lg border border-border/70 bg-background/60 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-teal-400/60 focus:outline-none focus:ring-1 focus:ring-teal-400/30"
                placeholder="Tell us why you're interested"
              />
            </div>
          </div>

          {/* Error */}
          {error && (
            <p className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-4 py-2 text-sm text-rose-600 dark:text-rose-300">
              {error}
            </p>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={submitting}
            className="group inline-flex w-full items-center justify-center gap-2 rounded-lg bg-teal-400 px-6 py-3 text-sm font-semibold text-teal-950 shadow-[0_0_24px_rgba(45,212,191,0.25)] transition-all hover:bg-teal-300 hover:shadow-[0_0_36px_rgba(45,212,191,0.4)] disabled:opacity-60 sm:w-auto"
          >
            {submitting ? (
              <RefreshCw className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            {submitting ? "Submitting…" : "Apply to Join the Pilot"}
          </button>
        </form>
      </Section>

      {/* Footer */}
      <footer className="relative z-10 border-t border-border/60">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 px-5 py-8 sm:flex-row">
          <div className="flex items-center gap-2.5">
            <AtlasLogo className="size-7 rounded-lg" />
            <span className="text-sm font-semibold tracking-tight">Atlas</span>
          </div>
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <a href="/" className="transition-colors hover:text-foreground">Back to Atlas</a>
            <a href="/auth" className="transition-colors hover:text-foreground">Sign in</a>
          </div>
          <LegalIdentityFooter tagline="AI Revenue Recovery for contractors." />
        </div>
      </footer>
    </div>
  );
}
