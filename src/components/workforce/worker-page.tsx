// ---------------------------------------------------------------------------
// WorkerPage — shared scaffold for the six Atlas worker experiences.
//
// Every worker page is: identity (who this worker is) + responsibilities
// (what Atlas does) + attention (what needs the human) + workload metrics +
// custom body. The scaffold never fetches data itself — pages pass their own
// data slices.
// ---------------------------------------------------------------------------

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowRight, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { WorkerDefinition } from "@/lib/workforce/worker-defs";

export interface WorkerMetric {
  label: string;
  value: string | number;
  tone?: "default" | "positive" | "warning" | "danger" | "accent";
}

const TONE_CLS: Record<NonNullable<WorkerMetric["tone"]>, string> = {
  default: "text-foreground",
  positive: "text-emerald-600 dark:text-emerald-300",
  warning: "text-amber-600 dark:text-amber-300",
  danger: "text-rose-600 dark:text-rose-300",
  accent: "text-teal-600 dark:text-teal-300",
};

export function WorkerHeader({
  worker,
  metrics,
}: {
  worker: WorkerDefinition;
  metrics?: WorkerMetric[];
}) {
  const Icon = worker.icon;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-4">
        <div
          className={cn(
            "flex size-12 shrink-0 items-center justify-center rounded-xl ring-1",
            worker.accent,
          )}
        >
          <Icon className="size-6" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Atlas worker · {worker.role}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
            {worker.name}
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            {worker.tagline} {worker.description}
          </p>
        </div>
      </div>

      {/* What this worker actively does */}
      <div className="flex flex-wrap gap-1.5">
        {worker.responsibilities.map((r) => (
          <span
            key={r}
            className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card/60 px-2.5 py-1 text-[11px] text-muted-foreground"
          >
            <Sparkles className="size-3 text-teal-600 dark:text-teal-300" />
            {r}
          </span>
        ))}
      </div>

      {/* Workload metrics */}
      {metrics && metrics.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {metrics.map((m) => (
            <div
              key={m.label}
              className="rounded-xl border border-border/70 bg-card/50 px-3 py-2.5"
            >
              <p className={cn("font-mono text-xl font-semibold tabular-nums", TONE_CLS[m.tone ?? "default"])}>
                {m.value}
              </p>
              <p className="mt-0.5 text-[11px] leading-tight text-muted-foreground">{m.label}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Section shell with an optional count badge and trailing action. */
export function WorkerSection({
  title,
  icon,
  count,
  action,
  children,
  className,
}: {
  title: string;
  icon?: LucideIcon;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const Icon = icon;
  return (
    <section className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-center gap-2">
        {Icon && <Icon className="size-4 text-muted-foreground" />}
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {typeof count === "number" && (
          <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
            {count}
          </Badge>
        )}
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/** View-all link used by worker sections. */
export function ViewAllLink({ to, label }: { to: string; label: string }) {
  return (
    <Button asChild variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground">
      <a href={to}>
        {label}
        <ArrowRight className="size-3" />
      </a>
    </Button>
  );
}

/** Honest empty state for worker sections. */
export function WorkerEmpty({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border/70 bg-card/30 px-6 py-8 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-md text-xs leading-5 text-muted-foreground">{description}</p>
    </div>
  );
}

/** Loading state used by worker pages and the Command Center. */
export function WorkerLoading({ label = "Loading workforce data…" }: { label?: string }) {
  return (
    <div className="flex min-h-[40vh] items-center justify-center gap-2 text-muted-foreground">
      <span className="size-4 animate-spin rounded-full border-2 border-teal-500 border-t-transparent" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

/** Page wrapper used by all worker pages. */
export function WorkerPage({
  worker,
  metrics,
  children,
}: {
  worker: WorkerDefinition;
  metrics?: WorkerMetric[];
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-8">
      <WorkerHeader worker={worker} metrics={metrics} />
      {children}
    </div>
  );
}