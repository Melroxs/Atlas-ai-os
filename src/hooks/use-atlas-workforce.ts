// ---------------------------------------------------------------------------
// useAtlasWorkforce — Client-side orchestrator hook
//
// Bridges the Atlas Workforce Orchestrator (pure TypeScript) to live
// Supabase claim data. Components call the returned action functions,
// which:
//   1. Fetch the claim data from Supabase via existing RPCs
//   2. Pass it through the orchestrator
//   3. Return structured results for UI display
//
// This makes the orchestrator TRIGGERABLE from the UI — the critical
// missing link that turns library code into a real digital employee.
// ---------------------------------------------------------------------------

import { useCallback, useState } from "react";
import { getSupabaseClient } from "@/lib/supabase";
import {
  getAtlasWorkforce,
  createReviewClaimRequest,
  createPrepareSupplementRequest,
  createDraftCommunicationRequest,
  type OrchestrationResult,
  type CommandType,
} from "@/lib/orchestrator";
import type { ClaimSnapshot } from "@/lib/insurance/logic";
import {
  analyzeClaimCompleteness,
  buildClaimFindings,
  reconcileClaim,
} from "@/lib/insurance/logic";
import {
  buildWorkQueue,
  buildWorkQueueSummary,
  type WorkItem,
  type WorkQueueSummary,
} from "@/lib/work-queue/service";
import {
  trackDeadlines,
  buildDeadlineSummary,
} from "@/lib/comms/deadline-tracker";
import { generateDailyBriefing } from "@/lib/comms/daily-briefing";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AtlasWorkforceState {
  running: boolean;
  lastResult: OrchestrationResult | null;
  error: string | null;
  commandType: CommandType | null;
}

export interface AtlasClaimReviewResult {
  result: OrchestrationResult;
  claimSnapshot: ClaimSnapshot;
  workItems: WorkItem[];
  workSummary: WorkQueueSummary;
}

export interface AtlasDailyBriefingResult {
  briefing: ReturnType<typeof generateDailyBriefing>;
  workSummary: WorkQueueSummary;
  deadlineSummary: ReturnType<typeof buildDeadlineSummary>;
}

// ---------------------------------------------------------------------------
// RPC arg normalizer (matches use-supabase.ts convention)
// ---------------------------------------------------------------------------

function toRpcArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    const key = k.startsWith("p_") ? k : `p_${k}`;
    out[key.toLowerCase()] = v;
  }
  return out;
}

async function rpcQuery<T>(name: string, args: Record<string, unknown> = {}): Promise<T | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc(name, toRpcArgs(args));
  if (error) throw error;
  return (data ?? null) as T;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAtlasWorkforce() {
  const [state, setState] = useState<AtlasWorkforceState>({
    running: false,
    lastResult: null,
    error: null,
    commandType: null,
  });

  // ---- Run a full claim review through the orchestrator ----
  const reviewClaim = useCallback(async (claimId: string): Promise<AtlasClaimReviewResult | null> => {
    setState({ running: true, lastResult: null, error: null, commandType: "review_claim" });
    try {
      // 1. Load claim data from Supabase via the existing getClaimPackage RPC
      const pkg = await rpcQuery<Record<string, unknown>>("insurance_get_claim_package", { claimId });
      if (!pkg || !pkg.claim) throw new Error("Claim not found");

      const claim = pkg.claim as ClaimSnapshot;
      const documents = (pkg.evidenceDocs ?? []) as Array<Record<string, unknown>>;
      const supplements = (pkg.supplements ?? []) as Array<Record<string, unknown>>;
      const findings = (pkg.findings ?? []) as Array<Record<string, unknown>>;

      // 2. Run through the orchestrator
      const workforce = getAtlasWorkforce();
      const request = createReviewClaimRequest(claimId, "current", claim, {
        documents,
        supplements,
        findings,
        source: "ui",
      });
      const result = await workforce.processRequest(request);

      // 3. Also compute work items for display
      const workItems = buildWorkQueue([claim], supplements, findings);
      const workSummary = buildWorkQueueSummary(workItems);

      setState({ running: false, lastResult: result, error: null, commandType: "review_claim" });
      return { result, claimSnapshot: claim, workItems, workSummary };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Review failed";
      setState({ running: false, lastResult: null, error: msg, commandType: null });
      return null;
    }
  }, []);

  // ---- Prepare a supplement through the orchestrator ----
  const prepareSupplement = useCallback(async (claimId: string): Promise<OrchestrationResult | null> => {
    setState({ running: true, lastResult: null, error: null, commandType: "prepare_supplement" });
    try {
      const pkg = await rpcQuery<Record<string, unknown>>("insurance_get_claim_package", { claimId });
      if (!pkg || !pkg.claim) throw new Error("Claim not found");
      const claim = pkg.claim as ClaimSnapshot;

      const workforce = getAtlasWorkforce();
      const request = createPrepareSupplementRequest(claimId, "current", claim, { source: "ui" });
      const result = await workforce.processRequest(request);

      setState({ running: false, lastResult: result, error: null, commandType: "prepare_supplement" });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Supplement prep failed";
      setState({ running: false, lastResult: null, error: msg, commandType: null });
      return null;
    }
  }, []);

  // ---- Draft a communication ----
  const draftCommunication = useCallback(
    async (
      claimId: string,
      draftType: "supplement_narrative" | "carrier_correspondence" | "customer_status_update" | "adjuster_followup" | "internal_note" | "escalation_message" | "payment_followup" | "document_request",
    ): Promise<OrchestrationResult | null> => {
      setState({ running: true, lastResult: null, error: null, commandType: "draft_communication" });
      try {
        const pkg = await rpcQuery<Record<string, unknown>>("insurance_get_claim_package", { claimId });
        if (!pkg || !pkg.claim) throw new Error("Claim not found");
        const claim = pkg.claim as ClaimSnapshot;
        const findings = (pkg.findings ?? []) as Array<Record<string, unknown>>;
        const completeness = pkg.completeness as { score: number; summary: string } | undefined;
        const reconciliation = pkg.reconciliation as { estimate?: number; invoiced?: number; paid: number; outstanding: number; notes: string[]; hasDiscrepancy: boolean } | undefined;

        const workforce = getAtlasWorkforce();
        const request = createDraftCommunicationRequest(claimId, "current", claim, draftType, {
          findings,
          reconciliation,
          completeness,
          source: "ui",
        });
        const result = await workforce.processRequest(request);

        setState({ running: false, lastResult: result, error: null, commandType: "draft_communication" });
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Draft failed";
        setState({ running: false, lastResult: null, error: msg, commandType: null });
        return null;
      }
    },
    [],
  );

  // ---- Generate a daily briefing across all claims ----
  const generateBriefing = useCallback(async (): Promise<AtlasDailyBriefingResult | null> => {
    setState({ running: true, lastResult: null, error: null, commandType: "generate_briefing" });
    try {
      // Load all claims
      const claimsList = await rpcQuery<Array<Record<string, unknown>>>("insurance_list_claims", {});
      const claims = (claimsList ?? []) as unknown as ClaimSnapshot[];

      // Run daily scan through orchestrator
      const workforce = getAtlasWorkforce();
      const request = {
        id: `req:${Date.now()}:briefing`,
        type: "generate_briefing" as const,
        tenantId: "current",
        input: { claims },
        source: "ui" as const,
        timestamp: Date.now(),
      };
      const result = await workforce.processRequest(request);

      // Also compute supplementary data
      const briefing = generateDailyBriefing(claims, [], []);
      const workItems = buildWorkQueue(claims);
      const workSummary = buildWorkQueueSummary(workItems);
      const allDeadlines = trackDeadlines(claims);
      const deadlineSummary = buildDeadlineSummary(allDeadlines);

      setState({ running: false, lastResult: result, error: null, commandType: "generate_briefing" });
      return { briefing, workSummary, deadlineSummary };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Briefing failed";
      setState({ running: false, lastResult: null, error: msg, commandType: null });
      return null;
    }
  }, []);

  // ---- Scan all claims for work items ----
  const scanAllClaims = useCallback(async (): Promise<{ workItems: WorkItem[]; summary: WorkQueueSummary } | null> => {
    setState({ running: true, lastResult: null, error: null, commandType: "run_daily_scan" });
    try {
      const claimsList = await rpcQuery<Array<Record<string, unknown>>>("insurance_list_claims", {});
      const claims = (claimsList ?? []) as unknown as ClaimSnapshot[];
      const workItems = buildWorkQueue(claims);
      const summary = buildWorkQueueSummary(workItems);

      setState({ running: false, lastResult: null, error: null, commandType: "run_daily_scan" });
      return { workItems, summary };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Scan failed";
      setState({ running: false, lastResult: null, error: msg, commandType: null });
      return null;
    }
  }, []);

  return {
    ...state,
    reviewClaim,
    prepareSupplement,
    draftCommunication,
    generateBriefing,
    scanAllClaims,
  };
}
