// ---------------------------------------------------------------------------
// useWorkerData — shared data layer for the workforce surfaces
//
// Loads the backend data the worker pages and Command Center need — through
// the SAME RPCs the existing pages use — and derives per-worker slices with
// the pure selectors. One data load, six worker contexts (no duplicated
// query logic per page).
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useQuery } from "@/hooks/use-supabase";
import type { ClaimSnapshot } from "@/lib/insurance/logic";
import { buildWorkQueue } from "@/lib/work-queue/service";
import { trackDeadlines } from "@/lib/comms/deadline-tracker";
import {
  listActionableGovernance,
  type GovernanceDecisionRow,
} from "@/lib/governance/persistence";
import type { WorkerDefinition } from "./worker-defs";
import {
  buildRecoveryMetrics,
  buildDeadlineView,
  buildEstimateReview,
  buildClaimView,
  filterWorkItemsByWorker,
  governanceForWorker,
  pendingGovernanceForWorker,
} from "./selectors";

export interface WorkerData {
  /** Raw claim rows from insurance_list_claims. */
  claims: ClaimSnapshot[];
  /** Raw claim-candidate rows from insurance_list_claim_candidates. */
  candidates: Array<Record<string, unknown>>;
  /** All generated work items (work-queue service). */
  workItems: ReturnType<typeof buildWorkQueue>;
  /** All actionable governance decisions. */
  governance: GovernanceDecisionRow[];
  /** insurance_claim_counts → worker metrics. */
  recovery: ReturnType<typeof buildRecoveryMetrics>;
  /** Tracked deadlines across all claims. */
  deadlines: ReturnType<typeof trackDeadlines>;
  /** Deadlines bucketed for display. */
  deadlineView: ReturnType<typeof buildDeadlineView>;
  /** Claims tagged by attention. */
  claimView: ReturnType<typeof buildClaimView>;
  /** Estimator review rows (real estimator engine). */
  estimateReview: ReturnType<typeof buildEstimateReview>;
  /** Work items owned by a worker. */
  forWorker: (worker: WorkerDefinition) => ReturnType<typeof filterWorkItemsByWorker>;
  /** Governance decisions owned by a worker. */
  governanceFor: (worker: WorkerDefinition) => GovernanceDecisionRow[];
  /** Pending governance decisions owned by a worker. */
  pendingGovernanceFor: (worker: WorkerDefinition) => GovernanceDecisionRow[];
  /** True until the primary queries have resolved once. */
  loading: boolean;
}

export function useWorkerData(): WorkerData {
  const claimsRaw = useQuery(api.insurance.claims.listClaims, {});
  const counts = useQuery(api.insurance.claims.claimCounts);
  const candidates = useQuery(api.insurance.candidates.listClaimCandidates);

  const claims = useMemo(
    () => (Array.isArray(claimsRaw) ? (claimsRaw as unknown as ClaimSnapshot[]) : []),
    [claimsRaw],
  );

  const [governance, setGovernance] = useState<GovernanceDecisionRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    void listActionableGovernance().then((rows) => {
      if (!cancelled) setGovernance(rows ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const workItems = useMemo(() => buildWorkQueue(claims), [claims]);
  const recovery = useMemo(
    () => buildRecoveryMetrics((counts ?? {}) as Record<string, unknown>),
    [counts],
  );
  const deadlines = useMemo(() => trackDeadlines(claims), [claims]);
  const deadlineView = useMemo(() => buildDeadlineView(deadlines), [deadlines]);
  const claimView = useMemo(() => buildClaimView(claims), [claims]);
  const estimateReview = useMemo(() => buildEstimateReview(claims), [claims]);

  const forWorker = useMemo(
    () => (worker: WorkerDefinition) => filterWorkItemsByWorker(workItems, worker),
    [workItems],
  );
  const governanceFor = useMemo(
    () => (worker: WorkerDefinition) => governanceForWorker(governance, worker),
    [governance],
  );
  const pendingGovernanceFor = useMemo(
    () => (worker: WorkerDefinition) => pendingGovernanceForWorker(governance, worker),
    [governance],
  );

  const loading = claimsRaw === undefined;

  return {
    claims,
    candidates: Array.isArray(candidates) ? candidates : [],
    workItems,
    governance,
    recovery,
    deadlines,
    deadlineView,
    claimView,
    estimateReview,
    forWorker,
    governanceFor,
    pendingGovernanceFor,
    loading,
  };
}