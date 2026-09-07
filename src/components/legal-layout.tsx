import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router";
import logo from "@/assets/logo.svg";
import { ThemeToggle } from "@/components/atlas-ui";
import { cn } from "@/lib/utils";

/**
 * Public legal/policy page shell (Terms, Privacy, Refunds).
 *
 * These pages are deliberately public: no auth, no app shell, no billing
 * gating — Paddle verification requires them to be reachable without signing
 * in. They share the Atlas visual language (teal accents, muted prose, sticky
 * header) and a footer that cross-links all three policy pages.
 */

const LEGAL_LINKS = [
  { label: "Terms of Service", href: "/terms" },
  { label: "Privacy Policy", href: "/privacy" },
  { label: "Refund Policy", href: "/refunds" },
];

function usePageMeta(title: string, description: string) {
  useEffect(() => {
    const prevTitle = document.title;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const prevDescription = meta?.content ?? null;

    document.title = title;
    if (meta) meta.content = description;

    return () => {
      document.title = prevTitle;
      if (meta && prevDescription !== null) meta.content = prevDescription;
    };
  }, [title, description]);
}

function LegalFooter() {
  return (
    <footer className="relative z-10 border-t border-border/60">
      <div className="mx-auto w-full max-w-6xl px-5 py-10">
        <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
          <a href="/" className="flex items-center gap-2.5 transition-opacity hover:opacity-85">
            <img
              src={logo}
              alt="Atlas logo"
              width={28}
              height={28}
              className="size-7 rounded-lg"
            />
            <span className="text-sm font-semibold tracking-tight text-foreground">Atlas</span>
          </a>
          <nav aria-label="Legal" className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
            {LEGAL_LINKS.map((link, i) => (
              <span key={link.href} className="flex items-center gap-5">
                {i > 0 && (
                  <span aria-hidden className="text-xs text-muted-foreground/40">·</span>
                )}
                <a
                  href={link.href}
                  className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  {link.label}
                </a>
              </span>
            ))}
          </nav>
        </div>
        <p className="mt-6 text-center text-[11px] text-muted-foreground/60">
          © {new Date().getFullYear()} Atlas. AI Operating System for Companies.
        </p>
      </div>
    </footer>
  );
}

export default function LegalLayout({
  title,
  metaTitle,
  metaDescription,
  eyebrow,
  updatedLabel,
  children,
}: {
  /** Heading shown at the top of the content column. */
  title: string;
  /** Browser tab / SEO title (e.g. "Terms of Service | Atlas"). */
  metaTitle: string;
  /** Meta description for the page. */
  metaDescription: string;
  /** Small mono eyebrow above the heading. */
  eyebrow: string;
  /** e.g. "Last updated: September 2026" */
  updatedLabel?: string;
  children: ReactNode;
}) {
  usePageMeta(metaTitle, metaDescription);

  const navigate = useNavigate();

  return (
    <div className="relative min-h-screen bg-background text-foreground">
      <div className="atlas-glow-teal pointer-events-none absolute inset-x-0 top-0 h-[420px]" />

      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-3.5">
          <a href="/" className="flex items-center gap-2.5 transition-opacity hover:opacity-85">
            <img
              src={logo}
              alt="Atlas logo"
              width={32}
              height={32}
              className="size-8 rounded-lg"
            />
            <span className="text-base font-semibold tracking-tight text-foreground">Atlas</span>
          </a>
          <nav className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
            <a href="/pricing" className="transition-colors hover:text-foreground">
              Pricing
            </a>
            <a href="/" className="transition-colors hover:text-foreground">
              Product
            </a>
          </nav>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <button
              type="button"
              onClick={() => navigate("/auth")}
              className="rounded-lg border border-border/70 px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:border-teal-400/40 hover:text-teal-700 dark:hover:text-teal-200"
            >
              Sign in
            </button>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="relative z-10 mx-auto w-full max-w-3xl px-5 py-14 sm:py-16">
        <p className={cn("atlas-eyebrow mb-3")}>{eyebrow}</p>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          {title}
        </h1>
        {updatedLabel && (
          <p className="mt-3 text-xs text-muted-foreground">{updatedLabel}</p>
        )}
        <div className="mt-10 space-y-10">{children}</div>
      </main>

      <LegalFooter />
    </div>
  );
}