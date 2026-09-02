import { motion, MotionConfig, type Variants } from "framer-motion";
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import logo from "@/assets/logo.svg";
import {
  ArrowRight,
  Banknote,
  BrainCircuit,
  Briefcase,
  Building2,
  Cable,
  Check,
  ClipboardCheck,
  Database,
  Eye,
  EyeOff,
  Factory,
  FileCheck2,
  FileSpreadsheet,
  FileText,
  FileType,
  Fingerprint,
  FolderOpen,
  Gauge,
  GitBranch,
  Globe,
  HardHat,
  History,
  Home,
  Landmark,
  Layers,
  Lightbulb,
  ListChecks,
  Lock,
  Mail,
  MessageSquareText,
  Mic2,
  Network,
  Play,
  Quote,
  Radar,
  RefreshCw,
  Repeat,
  Scale,
  ScrollText,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Table2,
  Target,
  TrendingUp,
  Truck,
  Upload,
  Users,
  Waves,
  Workflow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/atlas-ui";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const container: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08 } },
};

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE } },
};

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 26 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-70px" }}
      transition={{ duration: 0.6, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

function SectionHead({
  eyebrow,
  title,
  lead,
  center = true,
}: {
  eyebrow: string;
  title: ReactNode;
  lead?: ReactNode;
  center?: boolean;
}) {
  return (
    <Reveal className={cn("max-w-2xl", center && "mx-auto text-center")}>
      <p className="atlas-eyebrow mb-3">{eyebrow}</p>
      <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">{title}</h2>
      {lead && (
        <p className="mt-4 text-sm leading-7 text-muted-foreground sm:text-base">{lead}</p>
      )}
    </Reveal>
  );
}

function PrimaryCta({
  children,
  onClick,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group inline-flex items-center justify-center gap-2 rounded-lg bg-teal-400 px-5 py-2.5 text-sm font-semibold text-teal-950 shadow-[0_0_24px_rgba(45,212,191,0.25)] transition-all hover:bg-teal-300 hover:shadow-[0_0_36px_rgba(45,212,191,0.4)]",
        className,
      )}
    >
      {children}
      <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

function SecondaryCta({
  children,
  href,
  onClick,
  className,
}: {
  children: ReactNode;
  href?: string;
  onClick?: () => void;
  className?: string;
}) {
  const cls = cn(
    "inline-flex items-center justify-center gap-2 rounded-lg border border-border/70 px-5 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:border-teal-400/40 hover:text-teal-700 dark:hover:text-teal-200",
    className,
  );
  if (href) {
    return (
      <a href={href} className={cls}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cls}>
      {children}
    </button>
  );
}

function StatusChip({
  tone,
  children,
}: {
  tone: "live" | "native" | "soon";
  children: ReactNode;
}) {
  const styles = {
    live: "border-emerald-400/30 bg-emerald-400/10 text-emerald-600 dark:text-emerald-300",
    native: "border-teal-400/30 bg-teal-400/10 text-teal-600 dark:text-teal-300",
    soon: "border-muted-foreground/25 bg-muted text-muted-foreground",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em]",
        styles[tone],
      )}
    >
      {tone === "soon" && <Lock className="size-2.5" />}
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Hero visual — the command layer
// ---------------------------------------------------------------------------

const HERO_SYSTEMS = [
  { icon: Building2, label: "CRM" },
  { icon: Banknote, label: "Accounting" },
  { icon: FolderOpen, label: "Drive" },
  { icon: Mail, label: "Email" },
  { icon: ListChecks, label: "Projects" },
  { icon: FileText, label: "Documents" },
  { icon: Users, label: "HR" },
  { icon: Briefcase, label: "Industry SW" },
];

function FlowDots({ vertical = false }: { vertical?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center justify-center gap-1.5",
        vertical ? "flex-col" : "flex-row",
      )}
      aria-hidden
    >
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="size-1.5 rounded-full bg-teal-500/80 dark:bg-teal-300/80"
          animate={{ opacity: [0.15, 1, 0.15], scale: [0.7, 1.2, 0.7] }}
          transition={{ duration: 1.8, repeat: Infinity, delay: i * 0.35, ease: "easeInOut" }}
        />
      ))}
    </div>
  );
}

function AtlasCoreNode() {
  return (
    <div className="flex flex-col items-center">
      <div className="relative flex size-20 items-center justify-center rounded-2xl border border-teal-400/40 bg-card shadow-[0_0_44px_rgba(45,212,191,0.16)]">
        <img
          src={logo}
          alt="Atlas logo"
          width={56}
          height={56}
          className="size-14 rounded-xl"
        />
        <motion.span
          className="absolute inset-0 rounded-2xl border border-teal-400/40"
          animate={{ opacity: [0.6, 0], scale: [1, 1.35] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: "easeOut" }}
        />
      </div>
      <span className="mt-2.5 font-mono text-[11px] font-semibold uppercase tracking-[0.24em] text-foreground">
        Atlas
      </span>
      <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
        command layer
      </span>
    </div>
  );
}

function HeroVisual() {
  return (
    <div className="atlas-grid-fine relative overflow-hidden rounded-2xl border border-border/70 bg-card/70 p-5 shadow-2xl shadow-black/10 backdrop-blur dark:shadow-black/40">
      <div className="mb-4 flex items-center justify-between px-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Industry + Company + Live Evidence → Atlas Intelligence
        </span>
        <span className="flex items-center gap-1.5 font-mono text-[10px] text-emerald-600 dark:text-emerald-300">
          <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />
          continuously updated
        </span>
      </div>

      <div className="flex flex-col items-center gap-5 lg:flex-row lg:items-center lg:justify-between">
        {/* three knowledge layers */}
        <div className="grid w-full grid-cols-1 gap-2 lg:w-44">
          {[
            { icon: Globe, label: 'Industry', sub: 'knowledge' },
            { icon: Building2, label: 'Company', sub: 'knowledge' },
            { icon: Radar, label: 'Live', sub: 'evidence' },
          ].map((s) => (
            <div
              key={s.label}
              className="flex items-center gap-2 rounded-lg border border-teal-400/25 bg-teal-400/[0.04] px-2.5 py-1.5"
            >
              <s.icon className="size-3.5 shrink-0 text-teal-600 dark:text-teal-300" />
              <span className="truncate text-[10px] font-medium text-foreground/90">{s.label}</span>
              <span className="truncate text-[9px] text-muted-foreground/60">{s.sub}</span>
            </div>
          ))}
        </div>

        {/* mobile connector (down) */}
        <div className="lg:hidden">
          <FlowDots vertical />
        </div>
        {/* desktop connector (right) */}
        <div className="hidden lg:block">
          <FlowDots />
        </div>

        <AtlasCoreNode />

        {/* desktop connector */}
        <div className="hidden lg:block">
          <FlowDots />
        </div>

        {/* intelligence + query */}
        <div className="flex w-full flex-col gap-3 lg:max-w-xs">
          <div className="rounded-xl border border-teal-400/20 bg-teal-400/[0.05] p-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-teal-600 dark:text-teal-300">
              Three-layer intelligence
            </p>
            <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
              Industry knowledge + company knowledge + live evidence — one continuously
              updated intelligence system.
            </p>
          </div>
          <div className="rounded-xl border border-border/70 bg-background/60 p-3">
            <div className="flex items-center gap-2">
              <MessageSquareText className="size-3.5 shrink-0 text-teal-600 dark:text-teal-300" />
              <p className="text-[11px] font-medium text-foreground/90">
                “What revenue opportunities did we miss this week?”
              </p>
            </div>
            <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
              Three claims have unsubmitted supplements, two estimates have scope gaps,
              and one carrier deadline is approaching.{" "}
              <span className="text-emerald-600 dark:text-emerald-300">3 sources · revenue opportunity identified</span>
            </p>
          </div>
          <div className="rounded-xl border border-border/70 bg-background/60 p-3">
            <div className="flex items-center gap-2">
              <Mic2 className="size-3.5 shrink-0 text-teal-600 dark:text-teal-300" />
              <p className="text-[11px] font-medium text-foreground/90">
                Voice · “What does the carrier require for this supplement?”
              </p>
            </div>
            <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
              Per the carrier requirement, supplements must include signed authorization and
              dated completion photos…{" "}
              <span className="text-violet-600 dark:text-violet-300">[1] Carrier Supplement Requirements</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fragmentation visual
// ---------------------------------------------------------------------------

const FRAGMENT_SYSTEMS = [
  "CRM",
  "Accounting",
  "Spreadsheets",
  "Documents",
  "Email",
  "Project Management",
  "Industry Software",
  "Human Knowledge",
];

function FragmentationVisual() {
  return (
    <Reveal className="rounded-2xl border border-border/70 bg-card/60 p-6">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        The company exists across disconnected systems
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {FRAGMENT_SYSTEMS.map((s, i) => (
          <span key={s} className="flex items-center gap-2">
            <span className="rounded-lg border border-border/80 bg-background/60 px-3 py-1.5 text-xs font-medium text-foreground/85">
              {s}
            </span>
            {i < FRAGMENT_SYSTEMS.length - 1 && (
              <span className="text-xs text-muted-foreground/60">+</span>
            )}
          </span>
        ))}
        <span className="text-sm font-medium text-muted-foreground/80">=</span>
        <span className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-1.5 text-xs font-semibold text-rose-600 dark:text-rose-300">
          Fragmented company reality
        </span>
      </div>
      <p className="mt-5 border-t border-border/60 pt-4 text-center text-sm italic text-muted-foreground">
        “The result: revenue opportunities vanish before anyone realizes they existed.”
      </p>
    </Reveal>
  );
}

// ---------------------------------------------------------------------------
// Company model graph
// ---------------------------------------------------------------------------

const MODEL_NODES = [
  { id: "People", x: 280, y: 58 },
  { id: "Projects", x: 452, y: 128 },
  { id: "Customers", x: 452, y: 260 },
  { id: "Documents", x: 280, y: 330 },
  { id: "Policies", x: 108, y: 260 },
  { id: "Workflows", x: 108, y: 128 },
  { id: "Financials", x: 190, y: 62 },
  { id: "Systems", x: 370, y: 326 },
];

function CompanyGraph() {
  return (
    <svg viewBox="0 0 560 390" className="w-full">
      <defs>
        <radialGradient id="modelGlow" cx="50%" cy="50%" r="55%">
          <stop offset="0%" stopColor="oklch(0.752 0.132 178 / 0.2)" />
          <stop offset="100%" stopColor="oklch(0.752 0.132 178 / 0)" />
        </radialGradient>
      </defs>
      <rect width="560" height="390" fill="url(#modelGlow)" rx="18" />
      {MODEL_NODES.map((n) => (
        <motion.line
          key={n.id}
          x1={280}
          y1={195}
          x2={n.x}
          y2={n.y}
          stroke="oklch(0.752 0.132 178 / 0.35)"
          strokeWidth="1"
          initial={{ pathLength: 0, opacity: 0 }}
          whileInView={{ pathLength: 1, opacity: 1 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.7, ease: "easeOut" }}
        />
      ))}
      {MODEL_NODES.map((n, i) => (
        <motion.g
          key={`n-${n.id}`}
          initial={{ opacity: 0, scale: 0.6 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.5, delay: 0.15 + i * 0.06, ease: EASE }}
          style={{ transformOrigin: `${n.x}px ${n.y}px` }}
        >
          <circle cx={n.x} cy={n.y} r={26} fill="oklch(0.157 0.016 258 / 0.72)" />
          <circle
            cx={n.x}
            cy={n.y}
            r={26}
            fill="none"
            stroke="oklch(0.752 0.132 178 / 0.4)"
            strokeWidth="1"
          />
          <text
            x={n.x}
            y={n.y + 3}
            textAnchor="middle"
            fill="oklch(0.95 0.008 258)"
            fontSize="11"
            fontFamily="ui-monospace, monospace"
          >
            {n.id}
          </text>
        </motion.g>
      ))}
      <motion.g
        initial={{ scale: 0.5, opacity: 0 }}
        whileInView={{ scale: 1, opacity: 1 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 0.6, ease: EASE }}
        style={{ transformOrigin: "280px 195px" }}
      >
        <circle cx={280} cy={195} r={34} fill="oklch(0.752 0.132 178 / 0.16)" />
        <circle cx={280} cy={195} r={34} fill="none" stroke="oklch(0.752 0.132 178 / 0.6)" strokeWidth="1.5" />
        <text
          x={280}
          y={199}
          textAnchor="middle"
          fill="oklch(0.95 0.008 258)"
          fontSize="12"
          fontWeight="600"
          fontFamily="ui-monospace, monospace"
        >
          ATLAS
        </text>
      </motion.g>
      <motion.circle
        cx={280}
        cy={195}
        fill="none"
        stroke="oklch(0.752 0.132 178 / 0.45)"
        initial={{ r: 34, opacity: 0.7 }}
        animate={{ r: 70, opacity: 0 }}
        transition={{ duration: 2.6, repeat: Infinity, ease: "easeOut" }}
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Ask Atlas demo
// ---------------------------------------------------------------------------

function AskExchange({
  question,
  answer,
  sources,
  confidence,
  badge,
  citation,
}: {
  question: string;
  answer: string;
  sources: string[];
  confidence: string;
  badge?: string;
  citation?: string;
}) {
  return (
    <div>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background/70">
          <Users className="size-3 text-muted-foreground" />
        </div>
        <p className="text-sm text-muted-foreground">{question}</p>
      </div>
      <div className="mt-3 flex items-start gap-3">
        <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-teal-400/15 text-teal-600 ring-1 ring-teal-400/25 dark:text-teal-300">
          <Radar className="size-3" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-foreground">{answer}</p>
            {badge && (
              <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide text-emerald-600 dark:text-emerald-300">
                {badge}
              </span>
            )}
          </div>
          {citation && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span className="rounded-md border border-teal-400/25 bg-teal-400/5 px-2 py-0.5 font-mono text-[10px] text-teal-700 dark:text-teal-200">
                {citation}
              </span>
            </div>
          )}
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span className="font-mono uppercase tracking-wide text-muted-foreground/70">Sources</span>
            {sources.map((s) => (
              <span key={s} className="flex items-center gap-1">
                <Check className="size-3 text-teal-600 dark:text-teal-300" />
                {s}
              </span>
            ))}
            <span className="ml-auto font-mono text-[10px] text-emerald-600 dark:text-emerald-300">
              Confidence: {confidence}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Closed-loop ring
// ---------------------------------------------------------------------------

const LOOP_STEPS = [
  { label: "CONNECT", icon: Cable },
  { label: "UNDERSTAND", icon: BrainCircuit },
  { label: "QUERY", icon: MessageSquareText },
  { label: "DETECT", icon: Radar },
  { label: "DECIDE", icon: Scale },
  { label: "ACT", icon: Play },
  { label: "MEASURE", icon: Gauge },
  { label: "LEARN", icon: RefreshCw },
];

function ringPos(i: number, total: number, radius: number) {
  const angle = (i / total) * Math.PI * 2 - Math.PI / 2;
  return {
    left: `${50 + radius * Math.cos(angle)}%`,
    top: `${50 + radius * Math.sin(angle)}%`,
  };
}

function ClosedLoopRing() {
  return (
    <Reveal className="relative mx-auto hidden aspect-square w-full max-w-[540px] sm:block">
      {/* rotating dashed ring */}
      <motion.div
        className="absolute inset-[9%] rounded-full border border-dashed border-teal-400/25"
        animate={{ rotate: 360 }}
        transition={{ duration: 90, repeat: Infinity, ease: "linear" }}
      />
      <div className="absolute inset-[18%] rounded-full border border-border/50" />
      <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl border border-teal-400/40 bg-teal-400/10 text-teal-600 dark:text-teal-300">
          <RefreshCw className="size-6" />
        </div>
        <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-foreground">
          The operating loop
        </p>
      </div>
      {LOOP_STEPS.map((s, i) => {
        const Icon = s.icon;
        const pos = ringPos(i, LOOP_STEPS.length, 42);
        return (
          <motion.div
            key={s.label}
            initial={{ opacity: 0, scale: 0.7 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.4, delay: i * 0.07, ease: EASE }}
            className="absolute z-10 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center"
            style={pos}
          >
            <div className="flex size-10 items-center justify-center rounded-xl border border-border/80 bg-card shadow-lg shadow-black/10 dark:shadow-black/30">
              <Icon className="size-4 text-teal-600 dark:text-teal-300" />
            </div>
            <span className="mt-1.5 font-mono text-[9px] tracking-[0.14em] text-muted-foreground">
              {s.label}
            </span>
          </motion.div>
        );
      })}
    </Reveal>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const NAV_LINKS = [
  { label: "Product", href: "#product" },
  { label: "How It Works", href: "#how" },
  { label: "Industries", href: "#industries" },
  { label: "Security", href: "#security" },
  { label: "Company", href: "#company" },
];

export default function Landing() {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const toAuth = () => navigate("/auth");
  const toPricing = () => navigate("/pricing");

  return (
    <MotionConfig reducedMotion="user">
      <div className="relative min-h-screen overflow-x-hidden bg-background text-foreground">
        {/* ambient background */}
        <div className="atlas-glow-teal pointer-events-none absolute inset-x-0 top-0 h-[620px]" />
        <div className="atlas-grid pointer-events-none absolute inset-0 opacity-50 [mask-image:linear-gradient(to_bottom,black,transparent_70%)]" />

        {/* ------------------------------------------------------------------ */}
        {/* Nav */}
        {/* ------------------------------------------------------------------ */}
        <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md">
          <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-3.5">
            <a href="#top" className="flex items-center gap-2.5 transition-opacity hover:opacity-85">
              <img
                src={logo}
                alt="Atlas logo"
                width={36}
                height={36}
                className="size-9 rounded-lg"
              />
              <span className="text-lg font-semibold tracking-tight text-foreground">Atlas</span>
            </a>
            <nav className="hidden items-center gap-7 text-sm text-muted-foreground md:flex">
              {NAV_LINKS.map((l) => (
                <a key={l.label} href={l.href} className="transition-colors hover:text-foreground">
                  {l.label}
                </a>
              ))}
            </nav>
            <div className="flex items-center gap-2">
              <ThemeToggle />
              <button
                type="button"
                onClick={toAuth}
                className="hidden rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground sm:block"
              >
                Sign in
              </button>
              <PrimaryCta onClick={toAuth} className="hidden sm:inline-flex">
                Enter Atlas
              </PrimaryCta>
              <button
                type="button"
                aria-label="Toggle menu"
                onClick={() => setMenuOpen((o) => !o)}
                className="flex size-9 items-center justify-center rounded-lg border border-border/70 text-muted-foreground md:hidden"
              >
                <ListChecks className="size-4" />
              </button>
            </div>
          </div>
          {menuOpen && (
            <div className="border-t border-border/60 bg-background/95 px-5 py-4 md:hidden">
              <nav className="flex flex-col gap-1">
                {NAV_LINKS.map((l) => (
                  <a
                    key={l.label}
                    href={l.href}
                    onClick={() => setMenuOpen(false)}
                    className="rounded-lg px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {l.label}
                  </a>
                ))}
                <button
                  type="button"
                  onClick={toAuth}
                  className="mt-2 rounded-lg px-2 py-2 text-left text-sm font-medium text-foreground"
                >
                  Sign in
                </button>
                <PrimaryCta onClick={toAuth} className="mt-1 w-full">
                  Connect Your Company
                </PrimaryCta>
              </nav>
            </div>
          )}
        </header>

        {/* ------------------------------------------------------------------ */}
        {/* Hero */}
        {/* ------------------------------------------------------------------ */}
        <section id="top" className="relative z-10 mx-auto w-full max-w-6xl px-5 pb-16 pt-16 lg:pt-24">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <motion.div
              variants={container}
              initial="hidden"
              animate="show"
              className="relative z-10"
            >
              <motion.p variants={fadeUp} className="atlas-eyebrow mb-4 flex items-center gap-2">
                <Sparkles className="size-3.5" />
                Revenue Recovery + Prevention
              </motion.p>                <motion.h1
                variants={fadeUp}
                className="text-4xl font-semibold leading-[1.06] tracking-tight sm:text-5xl lg:text-[3.4rem]"
              >
                Atlas builds an intelligence layer{" "}
                <span className="bg-gradient-to-r from-teal-600 via-cyan-600 to-teal-600 bg-clip-text text-transparent dark:from-teal-300 dark:via-cyan-300 dark:to-teal-300">
                  around your company.
                </span>
              </motion.h1>
              <motion.p variants={fadeUp} className="mt-5 max-w-lg text-base leading-7 text-muted-foreground">
                Atlas combines industry knowledge, your company's own knowledge, and live
                operational evidence — then uses that intelligence to identify missed revenue,
                surface gaps, answer questions, and power specialized AI workflows.
              </motion.p>
              <motion.p variants={fadeUp} className="mt-2 flex items-center gap-2 text-xs text-muted-foreground/80">
                <span className="font-mono uppercase tracking-[0.14em]">Industry knowledge · Company knowledge · Live evidence → Intelligence</span>
              </motion.p>              <motion.div variants={fadeUp} className="mt-8 flex flex-wrap items-center gap-3">
                <PrimaryCta onClick={toPricing}>Sign Up for Atlas</PrimaryCta>
                <SecondaryCta href="#how">See How Atlas Works</SecondaryCta>
              </motion.div>
              <motion.div
                variants={fadeUp}
                className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground"
              >
                {["Evidence-backed intelligence",
                  "Source-aware reasoning with provenance",
                  "Recover missed revenue · Prevent future losses",
                ].map((f) => (
                  <span key={f} className="flex items-center gap-1.5">
                    <Check className="size-3.5 text-teal-600 dark:text-teal-300" />
                    {f}
                  </span>
                ))}
              </motion.div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.8, delay: 0.15, ease: EASE }}
            >
              <HeroVisual />
            </motion.div>
          </div>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Positioning strip — what Atlas is not */}
        {/* ------------------------------------------------------------------ */}
        <section className="relative z-10 border-y border-border/60 bg-card/30 py-8">
          <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-center gap-3 px-5 text-center">
            <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-2 text-[11px] text-muted-foreground">
              <span className="font-mono uppercase tracking-[0.16em] text-muted-foreground/70">
                Atlas is not
              </span>
              {["another CRM", "another ERP", "another project tool", "a document system", "a chatbot"].map(
                (t, i, arr) => (
                  <span key={t} className="flex items-center gap-2">
                    <span className="rounded-md border border-border/70 bg-background/50 px-2 py-1">
                      {t}
                    </span>
                    {i < arr.length - 1 && <span className="text-muted-foreground/40">·</span>}
                  </span>
                ),
              )}
            </div>
            <p className="text-xs text-muted-foreground/80">
              Atlas is an intelligence layer that sits above your existing software — combining industry knowledge,
              your company's knowledge, and live operational evidence into a continuously updated intelligence system.
            </p>
          </div>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Problem */}
        {/* ------------------------------------------------------------------ */}
        <section id="problem" className="relative z-10 mx-auto w-full max-w-6xl px-5 py-20">
          <SectionHead
            eyebrow="The problem"
            title="Revenue gets lost in the gaps."
            lead="Scope gets missed. Evidence gets buried. Documentation is incomplete. Changes aren't captured. Important details live across documents, photos, estimates, conversations, emails, and employee knowledge."
          />
          <div className="mt-12 grid items-start gap-8 lg:grid-cols-[1.15fr_1fr]">
            <FragmentationVisual />
            <Reveal delay={0.1}>
              <h3 className="text-lg font-semibold tracking-tight">The cost of fragmentation</h3>
              <ul className="mt-5 space-y-3.5">
                {[
                  [Search, "Scope gets missed across documents and conversations."],
                  [Repeat, "Evidence sits buried in photos, estimates, and emails."],
                  [FileText, "Documentation is incomplete when it matters most."],
                  [Users, "Changes aren't captured before deadlines pass."],
                  [EyeOff, "Important details live in employee memory, not systems."],
                  [ShieldAlert, "By the time gaps surface, recovery becomes difficult."],
                  [Database, "Revenue opportunities disappear into disconnected workflows."],
                ].map(([Icon, text]) => {
                  const I = Icon as typeof Search;
                  return (
                    <li key={text as string} className="flex items-start gap-3">
                      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background/50 text-teal-600 dark:text-teal-300">
                        <I className="size-3.5" />
                      </div>
                      <p className="text-sm leading-6 text-foreground/90">{text as string}</p>
                    </li>
                  );
                })}
              </ul>
            </Reveal>
          </div>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* How Atlas Thinks — Three-layer intelligence */}
        {/* ------------------------------------------------------------------ */}
        <section className="relative z-10 border-y border-border/60 bg-card/30 py-20">
          <div className="mx-auto w-full max-w-6xl px-5">
            <SectionHead
              eyebrow="How Atlas thinks"
              title={<>Atlas doesn't just search your documents. It connects what the industry knows, what your company knows, and what is happening inside your business — then reasons across all three.</>}
              lead="Most AI tools search one set of documents. Atlas combines three distinct knowledge layers — industry knowledge, your company's proprietary knowledge, and live operational evidence — then uses that combined context to identify gaps, surface contradictions, answer questions, and make recommendations."
            />
            <div className="mt-14 grid gap-4 sm:grid-cols-3">
              {/* Layer 1: Industry Knowledge */}
              <Reveal delay={0}>
                <div className="h-full rounded-2xl border border-teal-400/25 bg-teal-400/[0.04] p-6">
                  <div className="flex size-10 items-center justify-center rounded-lg bg-teal-400/15 text-teal-600 ring-1 ring-teal-400/20 dark:text-teal-300">
                    <Globe className="size-5" />
                  </div>
                  <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.18em] text-teal-600 dark:text-teal-300">
                    Industry Knowledge
                  </p>
                  <h3 className="mt-2 text-lg font-semibold tracking-tight text-foreground">
                    Atlas already knows the industry.
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    Construction terminology, restoration workflows, insurance claims processes, evidence requirements, carrier standards, regulatory context, and industry roles — Atlas brings this baseline knowledge to every company it serves.
                  </p>
                  <div className="mt-4 flex flex-wrap gap-1.5">
                    {['Terminology', 'Workflows', 'Standards', 'Regulations', 'Evidence types'].map((t) => (
                      <span key={t} className="rounded-md border border-teal-400/20 bg-background/50 px-2 py-0.5 font-mono text-[9px] text-foreground/80">{t}</span>
                    ))}
                  </div>
                </div>
              </Reveal>

              {/* Layer 2: Company Knowledge */}
              <Reveal delay={0.08}>
                <div className="h-full rounded-2xl border border-border/70 bg-card/60 p-6">
                  <div className="flex size-10 items-center justify-center rounded-lg bg-teal-400/10 text-teal-600 ring-1 ring-teal-400/20 dark:text-teal-300">
                    <Building2 className="size-5" />
                  </div>
                  <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                    Company Knowledge
                  </p>
                  <h3 className="mt-2 text-lg font-semibold tracking-tight text-foreground">
                    Atlas learns from your business.
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    Your SOPs, estimating procedures, company policies, documentation requirements, workflows, and operating patterns — Atlas builds a company-specific knowledge layer that understands how your business actually works.
                  </p>
                  <div className="mt-4 flex flex-wrap gap-1.5">
                    {['SOPs', 'Policies', 'Workflows', 'Estimates', 'Templates'].map((t) => (
                      <span key={t} className="rounded-md border border-border/70 bg-background/50 px-2 py-0.5 font-mono text-[9px] text-foreground/80">{t}</span>
                    ))}
                  </div>
                </div>
              </Reveal>

              {/* Layer 3: Live Evidence */}
              <Reveal delay={0.16}>
                <div className="h-full rounded-2xl border border-border/70 bg-card/60 p-6">
                  <div className="flex size-10 items-center justify-center rounded-lg bg-teal-400/10 text-teal-600 ring-1 ring-teal-400/20 dark:text-teal-300">
                    <Radar className="size-5" />
                  </div>
                  <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                    Live Evidence
                  </p>
                  <h3 className="mt-2 text-lg font-semibold tracking-tight text-foreground">
                    Atlas sees what's happening now.
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    Claims, documents, estimates, photos, communications, and operational events — Atlas continuously reasons over your live business activity to identify what needs attention.
                  </p>
                  <div className="mt-4 flex flex-wrap gap-1.5">
                    {['Claims', 'Estimates', 'Photos', 'Docs', 'Events'].map((t) => (
                      <span key={t} className="rounded-md border border-border/70 bg-background/50 px-2 py-0.5 font-mono text-[9px] text-foreground/80">{t}</span>
                    ))}
                  </div>
                </div>
              </Reveal>
            </div>

            {/* Convergence arrow */}
            <div className="my-6 flex items-center justify-center gap-3">
              <div className="h-px flex-1 bg-gradient-to-r from-transparent via-teal-400/40 to-transparent" />
              <div className="flex size-10 items-center justify-center rounded-xl border border-teal-400/40 bg-teal-400/10 text-teal-600 dark:text-teal-300">
                <BrainCircuit className="size-5" />
              </div>
              <div className="h-px flex-1 bg-gradient-to-r from-transparent via-teal-400/40 to-transparent" />
            </div>

            {/* Result */}
            <Reveal>
              <div className="mx-auto max-w-2xl rounded-2xl border border-teal-400/25 bg-teal-400/[0.05] p-6 text-center">
                <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-teal-600 dark:text-teal-300">
                  Atlas Intelligence
                </p>
                <p className="mt-3 text-lg font-semibold tracking-tight text-foreground">
                  Evidence · Gaps · Contradictions · Recommendations
                </p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Every answer carries provenance — you can trace where the information came from, what evidence supports it, what is missing, and what conflicts. Atlas distinguishes facts from inference and never fabricates evidence.
                </p>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Introduce Atlas */}
        {/* ------------------------------------------------------------------ */}
        <section
          id="product"
          className="relative z-10 border-y border-border/60 bg-card/30 py-20"
        >
          <div className="mx-auto w-full max-w-6xl px-5">
            <SectionHead
              eyebrow="Introducing Atlas"
              title="Revenue recovery shouldn't begin after revenue is lost."
              lead="Atlas can be used from the beginning of a claim to continuously understand the evidence, scope, documentation, and events surrounding the work — identifying opportunities that were already missed and preventing opportunities from being missed in the first place."
            />
            <div className="mt-14 grid items-start gap-12 lg:grid-cols-2">
              <motion.div
                variants={container}
                initial="hidden"
                whileInView="show"
                viewport={{ once: true, margin: "-70px" }}
                className="relative"
              >
                {[
                  [Building2, "YOUR EXISTING BUSINESS", "CRMs, accounting, drives, spreadsheets, email, industry software — everything you already run."],
                  [Cable, "CONNECT", "Sources link to Atlas through uploads and real connectors. Nothing requires a migration."],
                  [Upload, "INGEST", "PDFs, Word, Excel, CSV and drive files are parsed and normalized into one pipeline."],
                  [BrainCircuit, "UNDERSTAND", "Entities, policies, facts and relationships are extracted from what the business actually has."],
                  [Network, "CONNECT THE CONTEXT", "Cross-source identity resolution joins the same customer, project or vendor across files."],
                  [Layers, "ATLAS COMPANY INTELLIGENCE", "A living knowledge layer with provenance on every assertion."],
                  [MessageSquareText, "QUERY", "Ask anything in natural language or by voice — across every source at once."],
                  [Scale, "DECIDE", "Compare reality against policy, industry standards and regulatory expectations."],
                  [Play, "ACT", "Recommendations surface with evidence, awaiting human approval."],
                ].map(([Icon, label, text], i, arr) => {
                  const I = Icon as typeof Cable;
                  return (
                    <motion.div key={label as string} variants={fadeUp} className="relative flex gap-4">
                      <div className="flex flex-col items-center">
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-teal-400/25 bg-teal-400/10 text-teal-600 dark:text-teal-300">
                          <I className="size-4" />
                        </div>
                        {i < arr.length - 1 && (
                          <div className="my-1 w-px flex-1 bg-gradient-to-b from-teal-400/40 to-transparent" />
                        )}
                      </div>
                      <div className="pb-7">
                        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-teal-600 dark:text-teal-300/90">
                          {label as string}
                        </p>
                        <p className="mt-1 text-sm leading-6 text-foreground/90">{text as string}</p>
                      </div>
                    </motion.div>
                  );
                })}
              </motion.div>

              <Reveal delay={0.15} className="lg:sticky lg:top-24">
                <div className="atlas-grid-fine rounded-2xl border border-border/70 bg-card/70 p-6 shadow-xl shadow-black/10 dark:shadow-black/30">
                  <Quote className="size-5 text-teal-600/60 dark:text-teal-300/60" />
                  <p className="mt-3 text-lg leading-8 text-foreground">
                    “Revenue recovery shouldn't start after the money is
                    <span className="text-teal-600 dark:text-teal-300"> left behind.</span>”
                  </p>
                  <p className="mt-4 text-sm leading-6 text-muted-foreground">
                    Atlas captures your company's evidence, decisions, and outcomes — then uses
                    that intelligence to identify missed revenue and prevent future revenue
                    leakage. The earlier Atlas enters the workflow, the more it can prevent
                    rather than simply recover later.
                  </p>
                  <div className="mt-6 grid grid-cols-2 gap-3">
                    {[
                      ["9", "pipeline stages, from evidence to recovery"],
                      ["1", "knowledge layer for the whole company"],
                      ["0", "systems you have to replace"],
                      ["100%", "of answers traceable to sources"],
                    ].map(([k, v]) => (
                      <div key={k} className="rounded-xl border border-border/70 bg-background/50 p-3">
                        <p className="text-xl font-semibold tabular-nums tracking-tight text-teal-600 dark:text-teal-300">
                          {k}
                        </p>
                        <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{v}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </Reveal>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Keep your stack */}
        {/* ------------------------------------------------------------------ */}
        <section id="how" className="relative z-10 mx-auto w-full max-w-6xl px-5 py-20">
          <SectionHead
            eyebrow="Keep your software. Start recovering revenue."
            title="You don't have to replace your stack"
            lead="Atlas works with the systems your business already uses. Files upload directly; cloud systems connect through real connectors as they ship. The sooner your evidence enters Atlas, the sooner it can recover revenue you're missing."
          />
          <Reveal className="mt-12">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {[
                [FolderOpen, "Google Drive", "live", "Live connector · OAuth"],
                [FileSpreadsheet, "Excel", "native", ".xlsx · .xls"],
                [Table2, "CSV", "native", "spreadsheets & tables"],
                [FileText, "PDF", "native", "text + scanned detection"],
                [FileType, "Word", "native", ".docx"],
                [Upload, "Uploads", "native", "drag & drop any time"],
                [Building2, "Microsoft 365", "soon", "OneDrive / SharePoint"],
                [Users, "CRM", "soon", "accounts & contacts"],
                [Banknote, "Accounting", "soon", "invoices & ledgers"],
                [ListChecks, "Project Mgmt", "soon", "jobs & tasks"],
                [Mail, "Email", "soon", "communications"],
                [Briefcase, "Industry Software", "soon", "vertical systems"],
              ].map(([Icon, name, tone, note]) => {
                const I = Icon as typeof FolderOpen;
                return (
                  <div
                    key={name as string}
                    className="group rounded-xl border border-border/70 bg-card/60 p-4 transition-colors hover:border-teal-400/30"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex size-9 items-center justify-center rounded-lg bg-teal-400/10 text-teal-600 ring-1 ring-teal-400/20 transition-transform group-hover:scale-105 dark:text-teal-300">
                        <I className="size-4" />
                      </div>
                      <StatusChip tone={tone as "live" | "native" | "soon"}>
                        {tone === "live" ? "Live" : tone === "native" ? "Native" : "Coming soon"}
                      </StatusChip>
                    </div>
                    <p className="mt-3 text-sm font-medium text-foreground">{name as string}</p>
                    <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{note as string}</p>
                  </div>
                );
              })}
            </div>
          </Reveal>
          <p className="mt-8 text-center font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60">
            Connector states reflect reality — “live” means connected, “coming soon” means not yet shipped
          </p>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Intelligence model + company model */}
        {/* ------------------------------------------------------------------ */}
        <section id="model" className="relative z-10 border-y border-border/60 bg-card/30 py-20">
          <div className="mx-auto w-full max-w-6xl px-5">
            <SectionHead
            eyebrow="The Atlas intelligence model"
            title="Atlas doesn't just ingest data. It learns the revenue context."
            lead="Revenue opportunities depend on context — what was documented, what was missed, what the policy requires, and what happened on site. Atlas builds a model of your company that understands all of it, so missed revenue can be identified and future revenue can be protected."
            />
            <Reveal className="mt-12">
              <div className="rounded-2xl border border-border/70 bg-card/60 p-6">
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {[
                    [Building2, "Company"],
                    [Briefcase, "Industry"],
                    [Globe, "Geography"],
                    [Scale, "Regulations"],
                    [FileCheck2, "Company policies"],
                    [History, "Historical behavior"],
                    [Workflow, "Workflows"],
                    [TrendingUp, "KPIs"],
                  ].map(([Icon, label]) => {
                    const I = Icon as typeof Building2;
                    return (
                      <span
                        key={label as string}
                        className="flex items-center gap-2 rounded-lg border border-border/80 bg-background/60 px-3 py-2 text-xs font-medium text-foreground/90"
                      >
                        <I className="size-3.5 text-teal-600 dark:text-teal-300" />
                        {label as string}
                      </span>
                    );
                  })}
                </div>
                <div className="my-4 flex items-center justify-center gap-2">
                  <div className="h-px flex-1 bg-gradient-to-r from-transparent via-teal-400/40 to-teal-400/60" />
                  <motion.span
                    className="size-1.5 rounded-full bg-teal-500 dark:bg-teal-300"
                    animate={{ opacity: [0.3, 1, 0.3] }}
                    transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
                  />
                  <div className="h-px flex-1 bg-gradient-to-l from-transparent via-teal-400/40 to-teal-400/60" />
                </div>
                <div className="mx-auto max-w-md rounded-xl border border-teal-400/25 bg-teal-400/[0.06] p-4 text-center">
                  <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-teal-600 dark:text-teal-300">
                    Company intelligence model
                  </p>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    The reference context Atlas uses to identify and prevent revenue leakage.
                  </p>
                </div>
              </div>
            </Reveal>

            <div className="mt-20 grid items-center gap-12 lg:grid-cols-2">
              <Reveal>
                <p className="atlas-eyebrow mb-3">The company model</p>
                <h3 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                  Atlas builds a living model of your company's revenue landscape.
                </h3>
                <p className="mt-4 text-sm leading-7 text-muted-foreground">
                  Every document, estimate, photo, conversation, workflow, policy, and decision
                  contributes context to the company model. New information updates the model
                  continuously — so revenue opportunities are identified while the work is
                  happening, not only after the money has been left behind.
                </p>
                <ul className="mt-6 space-y-3">
                  {[
                    ["Sources stay sources", "Documents and systems keep their identity — nothing is copied into a walled garden."],
                    ["Entities resolve across sources", "The same customer, project, or vendor is recognized across files and drives."],
                    ["Relationships form a graph", "People, projects, policies and financials connect through the knowledge graph."],
                  ].map(([k, v]) => (
                    <li key={k} className="flex gap-3">
                      <Workflow className="mt-0.5 size-4 shrink-0 text-teal-600 dark:text-teal-300" />
                      <div>
                        <p className="text-sm font-medium text-foreground">{k}</p>
                        <p className="text-xs leading-5 text-muted-foreground">{v}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </Reveal>
              <Reveal delay={0.1}>
                <div className="atlas-grid-fine rounded-2xl border border-border/70 bg-card/70 p-4 shadow-xl shadow-black/10 dark:shadow-black/30">
                  <CompanyGraph />
                </div>
              </Reveal>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Ask Atlas */}
        {/* ------------------------------------------------------------------ */}
        <section id="ask" className="relative z-10 mx-auto w-full max-w-6xl px-5 py-20">
          <SectionHead
            eyebrow="Ask Atlas"
            title="Find missed revenue with a single question."
            lead="No dashboards to build. No database queries. No hunting through folders. Ask Atlas about a claim, a project, or a policy — and get an evidence-backed answer that surfaces what was missed, what needs attention, and what the documentation supports."
          />
          <Reveal className="mt-12">
            <div className="mx-auto max-w-3xl rounded-2xl border border-border/70 bg-card/70 p-6 shadow-xl shadow-black/10 dark:shadow-black/30">
              <div className="flex items-center gap-2 border-b border-border/60 pb-4">
                <div className="flex size-7 items-center justify-center rounded-lg bg-teal-400/15 text-teal-600 ring-1 ring-teal-400/25 dark:text-teal-300">
                  <Radar className="size-4" />
                </div>
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                  Atlas · company intelligence
                </span>
                <span className="ml-auto flex items-center gap-1.5 font-mono text-[10px] text-emerald-600 dark:text-emerald-300">
                  <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />
                  grounded
                </span>
              </div>
              <div className="mt-6 space-y-7">
                <AskExchange
                  question="“What revenue opportunities are we missing on active claims?”"
                  answer="I found 7 claims with scope gaps totaling $184,200 — including 3 where supplemental documentation was never submitted and 4 with scope items missing from the original estimate."
                  sources={["Claims records", "Estimate files", "Supplement history"]}
                  confidence="High · 94%"
                />
                <div className="border-t border-border/60 pt-7">
                  <AskExchange
                    question="“What documentation does our SOP require before submitting this supplement?”"
                    answer="Per your Supplement SOP §4, this supplement requires signed authorization, dated completion photos, and a final drying log — without which the carrier will deny or underpay."
                    badge="FACT"
                    citation="[1] Project Completion SOP §4"
                    sources={["Project Completion SOP"]}
                    confidence="High · 91%"
                  />
                </div>
              </div>
              <div className="mt-6 rounded-xl border border-border/60 bg-background/50 p-3 text-[11px] leading-5 text-muted-foreground">
                <span className="font-semibold text-foreground">Why this matters:</span>                identifying this gap required joining estimates, photos, and policy documents across
                disconnected systems. Atlas surfaced the missing revenue opportunity — without you
                needing to know which system held the answer.
              </div>
            </div>
          </Reveal>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Voice */}
        {/* ------------------------------------------------------------------ */}
        <section id="voice" className="relative z-10 border-y border-border/60 bg-card/30 py-20">
          <div className="mx-auto grid w-full max-w-6xl items-center gap-12 px-5 lg:grid-cols-2">
            <Reveal>
              <p className="atlas-eyebrow mb-3">Voice</p>
              <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
                Ask about revenue by voice.
              </h2>
              <p className="mt-4 max-w-lg text-sm leading-7 text-muted-foreground">
                Atlas isn't limited to a chat window. Ask questions naturally by voice and get
                answers grounded in your company's actual information — whether you're on a job
                site, in the office, or walking through a property. Identify missed revenue
                without opening a single file.
              </p>
              <div className="mt-7 space-y-3">
                {[
                  [Mic2, "“Atlas, what claims need my attention?”"],
                  [Radar, "“Three claims have scope gaps, two supplements are overdue for submission, and one carrier response deadline is approaching…”"],
                ].map(([Icon, text], i) => {
                  const I = Icon as typeof Mic2;
                  return (
                    <div
                      key={i}
                      className="flex items-start gap-3 rounded-xl border border-border/70 bg-background/50 p-3.5"
                    >
                      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-teal-400/10 text-teal-600 ring-1 ring-teal-400/20 dark:text-teal-300">
                        <I className="size-3.5" />
                      </div>
                      <p className="text-sm leading-6 text-muted-foreground">{text as string}</p>
                    </div>
                  );
                })}
              </div>
            </Reveal>
            <Reveal delay={0.1}>
              <div className="atlas-grid-fine rounded-2xl border border-border/70 bg-card/70 p-6 shadow-xl shadow-black/10 dark:shadow-black/30">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                    Voice channel · live
                  </span>
                  <span className="flex items-center gap-1.5 font-mono text-[10px] text-emerald-600 dark:text-emerald-300">
                    <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />
                    listening
                  </span>
                </div>
                <div className="mt-8 flex h-24 items-center justify-center gap-1.5">
                  {[10, 18, 26, 14, 30, 20, 34, 16, 26, 12, 22, 30, 16, 24, 12, 20].map((h, i) => (
                    <motion.span
                      key={i}
                      className="w-1.5 rounded-full bg-teal-500/80 dark:bg-teal-300/80"
                      animate={{ height: [h * 0.4, h, h * 0.45] }}
                      transition={{
                        duration: 1.4,
                        repeat: Infinity,
                        delay: i * 0.09,
                        ease: "easeInOut",
                      }}
                    />
                  ))}
                </div>
                <div className="mt-8 flex items-center justify-center gap-3">
                  <div className="relative">
                    <div className="flex size-14 items-center justify-center rounded-full border border-teal-400/40 bg-teal-400/10 text-teal-600 dark:text-teal-300">
                      <Play className="size-5 fill-current" />
                    </div>
                    <motion.span
                      className="absolute inset-0 rounded-full border border-teal-400/40"
                      animate={{ opacity: [0.7, 0], scale: [1, 1.45] }}
                      transition={{ duration: 2, repeat: Infinity, ease: "easeOut" }}
                    />
                  </div>
                  <div className="text-left">
                    <p className="text-sm font-medium text-foreground">Ask aloud</p>
                    <p className="text-xs text-muted-foreground">
                      “What documentation is missing on this claim?” · “What scope items were not captured in the estimate?”
                    </p>
                  </div>
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Evolution */}
        {/* ------------------------------------------------------------------ */}
        <section id="evolution" className="relative z-10 mx-auto w-full max-w-6xl px-5 py-20">
          <SectionHead
            eyebrow="The roadmap"
            title="From recovering what was missed to preventing what would be."
            lead="The first Atlas experience identifies missed revenue opportunities and builds the evidence to support them. The platform architecture evolves toward proactive prevention — detecting gaps before they become lost revenue."
          />
          <div className="mt-12 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {[
              [Eye, "KNOW", "“What was missed?”"],
              [BrainCircuit, "UNDERSTAND", "“Why was it missed?”"],
              [Scale, "COMPARE", "“What does the documentation support?”"],
              [Lightbulb, "ADVISE", "“What should we do next?”"],
              [Play, "ACT", "“Submit the recovery.”"],
              [RefreshCw, "LEARN", "“Did we prevent it next time?”"],
            ].map(([Icon, label, q], i) => {
              const I = Icon as typeof Eye;
              const live = i <= 2;
              return (
                <Reveal key={label as string} delay={i * 0.06}>
                  <div
                    className={cn(
                      "relative h-full rounded-xl border p-4",
                      live
                        ? "border-teal-400/30 bg-teal-400/[0.05]"
                        : "border-border/70 bg-card/50",
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <div
                        className={cn(
                          "flex size-8 items-center justify-center rounded-lg",
                          live
                            ? "bg-teal-400/15 text-teal-600 dark:text-teal-300"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        <I className="size-4" />
                      </div>
                      <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/60">
                        V{i + 1}
                      </span>
                    </div>
                    <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.16em] text-foreground/80">
                      {label as string}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">{q as string}</p>
                    {i < 5 && (
                      <ArrowRight className="absolute -right-2.5 top-1/2 hidden size-4 -translate-y-1/2 text-teal-400/40 lg:block" />
                    )}
                  </div>
                </Reveal>
              );
            })}
          </div>
          <p className="mt-6 text-center text-xs text-muted-foreground">
            V1 ships revenue identification → evidence building → documentation support. Advisory,
            execution, and prevention build on the same architecture.
          </p>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Context */}
        {/* ------------------------------------------------------------------ */}
        <section id="context" className="relative z-10 border-y border-border/60 bg-card/30 py-20">
          <div className="mx-auto w-full max-w-6xl px-5">
            <SectionHead
            eyebrow="Regulatory + industry intelligence"
            title="Context determines what revenue is recoverable."
            lead="A claim doesn't exist in a vacuum. Atlas combines your company's documentation with its policies, industry standards, and carrier requirements — so you know exactly what's recoverable and what needs to be documented."
            />
            <Reveal className="mt-10">
              <div className="flex flex-wrap items-center justify-center gap-2 text-xs">
                {["Company reality", "Company policies", "Industry standards", "Regulatory requirements", "Geographic requirements"].map(
                  (c, i, arr) => (
                    <span key={c} className="flex items-center gap-2">
                      <span className="rounded-lg border border-border/80 bg-background/60 px-3 py-2 font-medium text-foreground/90">
                        {c}
                      </span>
                      {i < arr.length - 1 && <span className="text-teal-500/70">+</span>}
                    </span>
                  ),
                )}
                <span className="text-teal-500/70">=</span>
                <span className="rounded-lg border border-teal-400/30 bg-teal-400/10 px-3 py-2 font-semibold text-teal-700 dark:text-teal-200">
                  What applies to this company
                </span>
              </div>
            </Reveal>
            <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                [Eye, "What happened on this claim?", "The reality captured from your connected sources — estimates, photos, conversations, and documentation."],
                [Scale, "What should have been documented?", "Industry standards and carrier benchmarks as reference for what's expected."],
                [FileCheck2, "What does our SOP require?", "Your own policies, documentation requirements, and procedures."],
                [Landmark, "What does the carrier require?", "Jurisdictional, regulatory, and carrier-specific obligations."],
              ].map(([Icon, k, v], i) => {
                const I = Icon as typeof Eye;
                return (
                  <Reveal key={k as string} delay={i * 0.06}>
                    <div className="h-full rounded-xl border border-border/70 bg-card/60 p-4 transition-colors hover:border-teal-400/30">
                      <I className="size-4 text-teal-600 dark:text-teal-300" />
                      <p className="mt-3 text-sm font-semibold text-foreground">{k as string}</p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">{v as string}</p>
                    </div>
                  </Reveal>
                );
              })}
            </div>
            <p className="mt-8 text-center text-xs text-muted-foreground">
              The long-term goal: Atlas surfaces gaps between what was documented, what should have
              been documented, and what's required — flagged before they become lost revenue.
            </p>
          </div>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Industries */}
        {/* ------------------------------------------------------------------ */}
        <section id="industries" className="relative z-10 mx-auto w-full max-w-6xl px-5 py-20">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <Reveal>
              <p className="atlas-eyebrow mb-3">Industries</p>
              <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
                Starting where revenue leakage is most expensive.
              </h2>
              <p className="mt-4 text-sm leading-7 text-muted-foreground">
                Atlas is launching first in insurance restoration — an industry where revenue gets
                left behind because critical information is spread across estimates, claims, photos,
                communications, carrier requirements, SOPs, and spreadsheets.
              </p>
              <p className="mt-3 text-sm leading-7 text-muted-foreground">
                The same architecture extends to other operationally complex industries. Industry
                intelligence packs are added incrementally — what you see here is the roadmap, and
                each vertical is activated as its pack ships.
              </p>
              <div className="mt-7 flex flex-wrap gap-2">
                {[
                  [HardHat, "Insurance Restoration", true],
                  [Home, "Construction", false],
                  [HardHat, "Roofing", false],
                  [Stethoscope, "Healthcare", false],
                  [Scale, "Legal", false],
                  [Landmark, "Financial Services", false],
                  [Truck, "Logistics", false],
                  [Briefcase, "Professional Services", false],
                  [Factory, "Other operational businesses", false],
                ].map(([Icon, name, active]) => {
                  const I = Icon as typeof HardHat;
                  return (
                    <span
                      key={name as string}
                      className={cn(
                        "flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium",
                        active
                          ? "border-teal-400/40 bg-teal-400/10 text-teal-700 dark:text-teal-200"
                          : "border-border/70 bg-background/50 text-muted-foreground",
                      )}
                    >
                      <I className="size-3.5" />
                      {name as string}
                      {active && (
                        <span className="font-mono text-[9px] uppercase tracking-wide text-teal-600 dark:text-teal-300">
                          live
                        </span>
                      )}
                    </span>
                  );
                })}
              </div>
            </Reveal>

            {/* ------------------------------------------------------------------ */}
            {/* Universal architecture */}
            {/* ------------------------------------------------------------------ */}
            <Reveal delay={0.1}>
              <div id="architecture" className="rounded-2xl border border-border/70 bg-card/60 p-6">
                <p className="atlas-eyebrow mb-2">The universal architecture</p>
                <h3 className="text-xl font-semibold tracking-tight">One intelligence layer. Any business.</h3>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  The core Atlas architecture is industry-agnostic. Revenue recovery intelligence
                  sits above it — so Atlas expands vertical by vertical without rebuilding the
                  operating layer.
                </p>
                <div className="mt-5 rounded-xl border border-teal-400/30 bg-teal-400/[0.06] p-4">
                  <p className="text-center font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-teal-700 dark:text-teal-200">
                    Atlas · universal AI layer
                  </p>
                  <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                    {[
                      "identity", "connections", "ingestion", "normalization", "knowledge",
                      "relationships", "search", "reasoning", "permissions", "provenance",
                      "audit", "natural language",
                    ].map((c) => (
                      <span
                        key={c}
                        className="rounded-md border border-teal-400/20 bg-background/50 px-2 py-0.5 font-mono text-[9px] text-foreground/80"
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="my-4 flex items-center justify-center gap-2">
                  <motion.span
                    className="size-1.5 rounded-full bg-teal-500 dark:bg-teal-300"
                    animate={{ opacity: [0.3, 1, 0.3] }}
                    transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
                  />
                  <div className="h-px w-24 bg-gradient-to-r from-teal-400/50 to-transparent" />
                  <motion.span
                    className="size-1.5 rounded-full bg-teal-500 dark:bg-teal-300"
                    animate={{ opacity: [0.3, 1, 0.3] }}
                    transition={{ duration: 1.6, repeat: Infinity, delay: 0.4, ease: "easeInOut" }}
                  />
                  <div className="h-px w-24 bg-gradient-to-l from-teal-400/50 to-transparent" />
                  <motion.span
                    className="size-1.5 rounded-full bg-teal-500 dark:bg-teal-300"
                    animate={{ opacity: [0.3, 1, 0.3] }}
                    transition={{ duration: 1.6, repeat: Infinity, delay: 0.8, ease: "easeInOut" }}
                  />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    ["Restoration", "industry intelligence"],
                    ["Healthcare", "industry intelligence"],
                    ["Legal", "industry intelligence"],
                  ].map(([name, sub]) => (
                    <div
                      key={name}
                      className="rounded-lg border border-border/70 bg-background/50 p-3 text-center"
                    >
                      <p className="text-xs font-semibold text-foreground">{name}</p>
                      <p className="mt-0.5 font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
                        {sub}
                      </p>
                      <p className="mt-2 text-[9px] text-muted-foreground/80">
                        terminology · workflows · regulations · benchmarks · KPIs · risks
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Security / trust */}
        {/* ------------------------------------------------------------------ */}
        <section id="security" className="relative z-10 border-y border-border/60 bg-card/30 py-20">
          <div className="mx-auto w-full max-w-6xl px-5">
            <SectionHead
              eyebrow="Security & trust"
              title="Revenue intelligence you can trace."
              lead="Atlas should not be a black box. Every revenue opportunity should be grounded in what Atlas actually knows — with the evidence to prove it, and the confidence to act on it."
            />
            <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                [ScrollText, "Source citations", "Every answer links back to the documents and systems it came from."],
                [GitBranch, "Provenance", "Entities and assertions remember their source, connector, and extraction event."],
                [Gauge, "Confidence", "Answers carry a confidence score — and Atlas says UNKNOWN when evidence is missing."],
                [ClipboardCheck, "Audit trails", "What Atlas and your team did, recorded as a first-class activity log."],
                [Lock, "Permissions", "Viewers see and ask within what their role allows — AI never reveals more."],
                [ShieldCheck, "Tenant isolation", "Every workspace is isolated; no company's knowledge leaks into another."],
                [Fingerprint, "Source-level evidence", "FACT, RULE, OBSERVATION, and INFERENCE are distinguished explicitly."],
                [Database, "No fabrication", "If the evidence doesn't support an answer, Atlas says so instead of inventing it."],
              ].map(([Icon, k, v], i) => {
                const I = Icon as typeof ScrollText;
                return (
                  <Reveal key={k as string} delay={i * 0.05}>
                    <div className="h-full rounded-xl border border-border/70 bg-card/60 p-4 transition-colors hover:border-teal-400/30">
                      <I className="size-4 text-teal-600 dark:text-teal-300" />
                      <p className="mt-3 text-sm font-semibold text-foreground">{k as string}</p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">{v as string}</p>
                    </div>
                  </Reveal>
                );
              })}
            </div>
            <p className="mt-8 text-center text-xs text-muted-foreground">
              Atlas reports its capabilities honestly. Compliance certifications will be listed here
              only when they are actually implemented and verified.
            </p>
          </div>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Closed loop */}
        {/* ------------------------------------------------------------------ */}
        <section id="loop" className="relative z-10 mx-auto w-full max-w-6xl px-5 py-20">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <Reveal>
              <p className="atlas-eyebrow mb-3">The operating loop</p>
              <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
                From missed revenue to a closed loop.
              </h2>
              <p className="mt-4 max-w-lg text-sm leading-7 text-muted-foreground">
                Atlas captures the information surrounding the work, structures and understands
                the evidence, identifies gaps and opportunities, helps determine what needs to
                happen next — and the outcome becomes part of the company's knowledge. Every
                claim makes the company better at capturing revenue on the next one.
              </p>
              <ul className="mt-6 space-y-2.5">
                {[
                  "V1: identify missed revenue and build evidence-backed recovery packages.",
                  "Later: detect gaps in real time and advise on next steps.",
                  "Eventually: closed-loop prevention — each claim improves the next one.",
                ].map((t) => (
                  <li key={t} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                    <Check className="mt-0.5 size-4 shrink-0 text-teal-600 dark:text-teal-300" />
                    {t}
                  </li>
                ))}
              </ul>
            </Reveal>
            <ClosedLoopRing />
            {/* mobile fallback list */}
            <div className="sm:hidden">
              <Reveal>
                <div className="grid grid-cols-2 gap-2">
                  {LOOP_STEPS.map((s) => {
                    const Icon = s.icon;
                    return (
                      <div
                        key={s.label}
                        className="flex items-center gap-2 rounded-lg border border-border/70 bg-card/60 px-3 py-2"
                      >
                        <Icon className="size-3.5 text-teal-600 dark:text-teal-300" />
                        <span className="font-mono text-[9px] tracking-[0.14em] text-muted-foreground">
                          {s.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </Reveal>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Who it's for + value props */}
        {/* ------------------------------------------------------------------ */}
        <section id="for" className="relative z-10 border-y border-border/60 bg-card/30 py-20">
          <div className="mx-auto w-full max-w-6xl px-5">
            <SectionHead
              eyebrow="Who it's for"
              title="Built for businesses where revenue is being left behind."
              lead="Operationally complex companies lose revenue because critical information is scattered across dozens of systems. Atlas is built for them — from small and mid-sized operators to larger organizations."
            />
            <div className="mt-12 grid gap-4 md:grid-cols-2">
              <Reveal>
                <div className="h-full rounded-2xl border border-border/70 bg-card/60 p-6">
                  <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                    <Target className="size-3.5 text-teal-600 dark:text-teal-300" />
                    The companies
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {[
                      "Restoration", "Construction", "Roofing", "Healthcare", "Legal",
                      "Logistics", "Professional services", "Field services",
                      "Financial operations", "Other multi-system businesses",
                    ].map((t) => (
                      <span
                        key={t}
                        className="rounded-lg border border-border/80 bg-background/50 px-3 py-1.5 text-xs text-foreground/85"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              </Reveal>
              <Reveal delay={0.08}>
                <div className="h-full rounded-2xl border border-border/70 bg-card/60 p-6">
                  <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                    <Users className="size-3.5 text-teal-600 dark:text-teal-300" />
                    The people
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {[
                      "Founders", "CEOs", "COOs", "Operations leaders", "Finance leaders",
                      "Managers", "Employees",
                    ].map((t) => (
                      <span
                        key={t}
                        className="rounded-lg border border-border/80 bg-background/50 px-3 py-1.5 text-xs text-foreground/85"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                  <p className="mt-5 text-xs leading-5 text-muted-foreground">
                    Atlas starts accessible for small and mid-sized operations and scales with the
                    architecture — not with a sales team and a contract.
                  </p>
                </div>
              </Reveal>
            </div>

            <div className="mt-12 grid gap-4 md:grid-cols-3">
              {[
                [Search, "Stop missing revenue", "Atlas finds the gaps.", "Cross-reference estimates, photos, policies, and carrier requirements."],
                [EyeOff, "Stop guessing what's recoverable", "Atlas shows the evidence.", "Documentation-backed claims with confidence scores."],
                [Lightbulb, "Start preventing losses", "Atlas connects the context.", "Claims, projects, policies, and financials — joined into one picture."],
              ].map(([Icon, k, tag, v], i) => {
                const I = Icon as typeof Search;
                return (
                  <Reveal key={k as string} delay={i * 0.06}>
                    <div className="group h-full rounded-2xl border border-border/70 bg-card/60 p-6 transition-colors hover:border-teal-400/30">
                      <div className="flex size-10 items-center justify-center rounded-lg bg-teal-400/10 text-teal-600 ring-1 ring-teal-400/20 transition-transform group-hover:scale-105 dark:text-teal-300">
                        <I className="size-5" />
                      </div>
                      <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.18em] text-foreground/70">
                        {k as string}
                      </p>
                      <p className="mt-1.5 text-lg font-semibold tracking-tight text-foreground">
                        {tag as string}
                      </p>
                      <p className="mt-2 text-xs leading-5 text-muted-foreground">{v as string}</p>
                    </div>
                  </Reveal>
                );
              })}
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Final CTA */}
        {/* ------------------------------------------------------------------ */}
        <section id="cta" className="relative z-10 mx-auto w-full max-w-6xl px-5 py-24">
          <Reveal>
            <div className="atlas-glow-teal relative overflow-hidden rounded-2xl border border-teal-400/20 px-6 py-16 text-center">
              <div className="atlas-grid-fine pointer-events-none absolute inset-0 opacity-40" />
              <div className="relative">
                <p className="atlas-eyebrow mb-3">Recover your revenue</p>
                <h2 className="mx-auto max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
                  Revenue recovery starts with understanding what was missed.
                </h2>
                <p className="mx-auto mt-4 max-w-lg text-sm leading-7 text-muted-foreground">
                  Atlas connects your evidence, understands the context, and helps your team
                recover — from the first document through final payment.
                </p>
                <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                  <PrimaryCta onClick={toPricing}>Sign Up for Atlas</PrimaryCta>
                  <SecondaryCta onClick={toAuth}>Sign In</SecondaryCta>
                </div>
                <p className="mt-8 font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground/70">
                  Industry knowledge + company intelligence + live evidence
                </p>
              </div>
            </div>
          </Reveal>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Footer */}
        {/* ------------------------------------------------------------------ */}
        <footer id="company" className="relative z-10 border-t border-border/60">
          <div className="mx-auto w-full max-w-6xl px-5 py-12">
            <div className="grid gap-10 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
              <div>
                <a href="#top" className="flex items-center gap-2.5">
                  <img
                    src={logo}
                    alt="Atlas logo"
                    width={32}
                    height={32}
                    className="size-8 rounded-lg"
                  />
                  <span className="text-base font-semibold tracking-tight">Atlas</span>
                </a>
                <p className="mt-3 max-w-xs text-xs leading-5 text-muted-foreground">
                  An AI Operating System for Companies. Atlas combines industry knowledge,
                  company-specific intelligence, and live evidence to recover revenue and
                  drive operational decisions.
                </p>
                <div className="mt-4 flex items-center gap-2">
                  <ThemeToggle />
                  <a
                    href="/pricing"
                    className="rounded-lg border border-border/70 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Pricing
                  </a>
                  <button
                    type="button"
                    onClick={toAuth}
                    className="rounded-lg border border-border/70 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Sign in →
                  </button>
                </div>
              </div>
              {[
                ["Product", [["Ask Atlas", "#ask"], ["Company model", "#model"], ["Connections", "#how"], ["Security", "#security"]]],
                ["How it works", [["The problem", "#problem"], ["The pipeline", "#product"], ["Industries", "#industries"], ["The roadmap", "#evolution"]]],
                ["Company", [["About", "#product"], ["Industries", "#industries"], ["Trust", "#security"], ["Pricing", "/pricing"]]],
              ].map(([head, links]) => (
                <div key={head as string}>
                  <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                    {head as string}
                  </p>
                  <ul className="mt-3 space-y-2">
                    {(links as [string, string][]).map(([label, href]) => (
                      <li key={label}>
                        <a
                          href={href}
                          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                        >
                          {label}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <div className="mt-10 flex flex-col items-center justify-between gap-3 border-t border-border/60 pt-6 sm:flex-row">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground/60">
                industry knowledge · company intelligence · live evidence · reasoning · action
              </p>
              <p className="text-[11px] text-muted-foreground/60">
                © {new Date().getFullYear()} Atlas. AI Operating System for Companies. Starting with insurance restoration.
              </p>
            </div>
          </div>
        </footer>
      </div>
    </MotionConfig>
  );
}
