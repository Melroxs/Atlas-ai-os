// ---------------------------------------------------------------------------
// Workers Hub — the Atlas workforce at a glance. Six job functions, one
// workforce, all composed over the same backend data.
// ---------------------------------------------------------------------------

import { ArrowRight } from "lucide-react";
import { WorkerLoading } from "@/components/workforce/worker-page";
import { WORKERS } from "@/lib/workforce/worker-defs";
import { useWorkerData } from "@/lib/workforce/use-worker-data";
import { cn } from "@/lib/utils";

export default function WorkersHub() {
  const data = useWorkerData();

  if (data.loading) return <WorkerLoading label="Loading the workforce…" />;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Atlas workforce
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
          One workforce, six job functions
        </h1>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
          Atlas performs the work of six roles across your claims book — one shared
          set of data, one governance system, and a human in control of every
          consequential action.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {WORKERS.map((worker) => {
          const Icon = worker.icon;
          const attention = data.forWorker(worker);
          const gov = data.pendingGovernanceFor(worker);
          return (
            <a
              key={worker.slug}
              href={worker.route}
              className="group flex flex-col rounded-xl border border-border/70 bg-card/50 p-5 transition-colors hover:border-teal-400/30"
            >
              <div className="flex items-start justify-between">
                <div className={cn("flex size-10 items-center justify-center rounded-lg ring-1", worker.accent)}>
                  <Icon className="size-5" />
                </div>
                {(attention.length > 0 || gov.length > 0) && (
                  <span className="flex items-center gap-1.5">
                    {attention.length > 0 && (
                      <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-amber-600 dark:text-amber-300">
                        {attention.length}
                      </span>
                    )}
                    {gov.length > 0 && (
                      <span className="rounded-full border border-rose-400/30 bg-rose-400/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-rose-600 dark:text-rose-300">
                        {gov.length}
                      </span>
                    )}
                  </span>
                )}
              </div>
              <h2 className="mt-3 text-sm font-semibold text-foreground">{worker.name}</h2>
              <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                {worker.role}
              </p>
              <p className="mt-2 flex-1 text-xs leading-5 text-muted-foreground">{worker.tagline}</p>
              <div className="mt-3 flex items-center gap-1 text-xs font-medium text-teal-600 opacity-0 transition-opacity group-hover:opacity-100 dark:text-teal-300">
                Open worker
                <ArrowRight className="size-3" />
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}