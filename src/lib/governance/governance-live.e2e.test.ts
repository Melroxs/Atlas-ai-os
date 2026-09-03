// ---------------------------------------------------------------------------
// LIVE end-to-end test — governance persistence (disabled by default).
//
//   RUN_LIVE_E2E=1 bun vitest run src/lib/governance/governance-live.e2e.test.ts
//
// Requires migration 20260904_atlas_governance.sql to be applied to the
// project. Covers, against the real database:
//   A. ALLOW / REVIEW_REQUIRED / BLOCK / UNKNOWN decisions are persisted
//   B. actionable list contains only REVIEW_REQUIRED / BLOCK / UNKNOWN rows
//   C. approve transitions REVIEW_REQUIRED → approved (persisted)
//   D. BLOCK cannot be plain-approved; override requires an authorized role
//   E. tenant isolation: organization A cannot see organization B's decisions
//   J. duplicate evaluation supersedes prior actionable work instead of
//      creating a duplicate
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { getSupabaseClient } from "@/lib/supabase";
import { rpcCall } from "@/lib/actions/rpc";

const RUN = process.env.RUN_LIVE_E2E === "1";

async function createUser(name: string) {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase is not configured.");
  const email = `gov-e2e-${name}-${Date.now()}@example.com`;
  const password = "GovE2e!42";
  const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
    email,
    password,
  });
  expect(signUpError).toBeNull();
  const session =
    signUpData?.session ??
    (await supabase.auth.signInWithPassword({ email, password })).data.session;
  expect(session, "expected an active session after signup").toBeTruthy();
  if (session) await supabase.auth.setSession(session);

  const created = (await rpcCall(supabase, "tenants_create_tenant", {
    name: `${name} Governance Co`,
  })) as { tenantId: string; existing?: boolean };
  expect(created.tenantId).toBeTruthy();

  return { supabase, email, tenantId: created.tenantId as string };
}

async function recordDecision(
  supabase: NonNullable<ReturnType<typeof getSupabaseClient>>,
  overrides: Record<string, unknown>,
): Promise<string> {
  const id = (await rpcCall(supabase, "governance_record_decision", {
    claimId: "GOV-E2E-CLAIM",
    entityType: "claim",
    entityId: "GOV-E2E-CLAIM",
    actionType: "claim_analysis",
    decision: "ALLOW",
    riskLevel: "none",
    jurisdiction: "United States > Florida",
    actorRole: "atlas",
    knowledgeReferenceDate: new Date().toISOString(),
    lossDate: new Date(Date.now() - 90 * 86_400_000).toISOString(),
    applicableRules: JSON.stringify([
      { id: "rule-x", title: "Test rule", authorityLevel: "binding_regulation" },
    ]),
    applicableStandards: JSON.stringify([]),
    requiredApprovals: [],
    knowledgeGaps: JSON.stringify([]),
    citations: ["TEST-1"],
    evidenceReferences: JSON.stringify([]),
    decisionRationale: "E2E test decision",
    governanceEngine: "atlas-governance-engine-1",
    knowledgeCorpusVersion: "1.0.0",
    orchestrationId: "req-e2e",
    actionId: "action-e2e",
    dedupKey: `e2e-${overrides.actionType ?? "claim_analysis"}|GOV-E2E-CLAIM`,
    ...overrides,
  })) as string;
  expect(id).toBeTruthy();
  return id;
}

describe.skipIf(!RUN)("governance persistence (real project)", () => {
  it(
    "records ALLOW / REVIEW_REQUIRED / BLOCK / UNKNOWN, lists, approves, dedups, and isolates tenants",
    async () => {
      const orgA = await createUser("GovAlpha");
      const orgB = await createUser("GovBeta");

      // --- A: every decision is persisted --------------------------------
      const allowId = await recordDecision(orgA.supabase, {
        actionType: "claim_analysis",
        decision: "ALLOW",
        riskLevel: "none",
      });
      const reviewId = await recordDecision(orgA.supabase, {
        actionType: "supplement_preparation",
        decision: "REVIEW_REQUIRED",
        riskLevel: "medium",
        requiredApprovals: ["human_review"],
      });
      const blockId = await recordDecision(orgA.supabase, {
        actionType: "legal_conclusion",
        decision: "BLOCK",
        riskLevel: "critical",
        requiredApprovals: ["attorney"],
      });
      const unknownId = await recordDecision(orgA.supabase, {
        actionType: "coverage_determination",
        decision: "UNKNOWN",
        riskLevel: "high",
        knowledgeGaps: JSON.stringify([
          { description: "No authoritative knowledge available.", severity: "critical" },
        ]),
      });

      expect([allowId, reviewId, blockId, unknownId].every(Boolean)).toBe(true);

      // --- history is queryable by claim --------------------------------
      const history = (await rpcCall(orgA.supabase, "governance_list_decisions", {
        claimId: "GOV-E2E-CLAIM",
      })) as Array<{ decision: string; execution_status: string; approval_status: string }>;
      const decisions = history.map((h) => h.decision);
      expect(decisions).toContain("ALLOW");
      expect(decisions).toContain("REVIEW_REQUIRED");
      expect(decisions).toContain("BLOCK");
      expect(decisions).toContain("UNKNOWN");

      // --- B: actionable list = REVIEW_REQUIRED / BLOCK / UNKNOWN only ---
      const actionable = (await rpcCall(orgA.supabase, "governance_list_actionable", {})) as Array<{
        decision: string;
        execution_status: string;
        approval_status: string;
      }>;
      const actionableDecisions = actionable.map((a) => a.decision);
      expect(actionableDecisions).not.toContain("ALLOW");
      expect(actionableDecisions).toContain("REVIEW_REQUIRED");
      expect(actionableDecisions).toContain("BLOCK");
      expect(actionableDecisions).toContain("UNKNOWN");

      // --- C: approve the REVIEW_REQUIRED decision -----------------------
      const approved = (await rpcCall(orgA.supabase, "governance_decide", {
        decisionId: reviewId,
        decision: "approved",
        notes: "E2E operator approval",
      })) as { execution_status: string; approval_status: string };
      expect(approved.execution_status).toBe("approved");
      expect(approved.approval_status).toBe("approved");

      // --- D: BLOCK cannot be plain-approved ------------------------------
      let plainApproveError = "";
      try {
        await rpcCall(orgA.supabase, "governance_decide", {
          decisionId: blockId,
          decision: "approved",
        });
      } catch (err) {
        plainApproveError = err instanceof Error ? err.message : String(err);
      }
      expect(plainApproveError).toContain("override_decision");

      // Override requires an authorized role. The fresh-tenant creator's role
      // depends on bootstrap policy — assert the gate behaves correctly either
      // way (success, or an authorization error — never a generic failure).
      let overrideOutcome: string | null = null;
      try {
        const overridden = (await rpcCall(orgA.supabase, "governance_decide", {
          decisionId: blockId,
          decision: "approved",
          notes: "E2E authorized override",
          overrideDecision: "ALLOW",
        })) as { override_decision: string | null; execution_status: string };
        overrideOutcome = `ok:${overridden.override_decision ?? "?"}:${overridden.execution_status}`;
      } catch (err) {
        overrideOutcome = `error:${err instanceof Error ? err.message : String(err)}`;
      }
      expect(
        overrideOutcome === "ok:ALLOW:approved" ||
          overrideOutcome.startsWith("error:only super_admin or atlas_admin"),
      ).toBe(true);

      // --- J: duplicate evaluation supersedes prior actionable work -------
      await recordDecision(orgA.supabase, {
        actionType: "communication_sending",
        decision: "REVIEW_REQUIRED",
        riskLevel: "medium",
        requiredApprovals: ["human_review"],
      });
      await recordDecision(orgA.supabase, {
        actionType: "communication_sending",
        decision: "REVIEW_REQUIRED",
        riskLevel: "medium",
        requiredApprovals: ["human_review"],
      });

      const afterDedup = (await rpcCall(orgA.supabase, "governance_list_decisions", {
        claimId: "GOV-E2E-CLAIM",
        actionType: "communication_sending",
      })) as Array<{ execution_status: string }>;
      const active = afterDedup.filter(
        (d) => d.execution_status === "awaiting_approval" || d.execution_status === "blocked",
      );
      expect(active.length).toBe(1); // exactly ONE actionable row for the same action

      // --- E: tenant isolation -------------------------------------------
      const foreignHistory = (await rpcCall(orgB.supabase, "governance_list_decisions", {
        claimId: "GOV-E2E-CLAIM",
      })) as unknown[];
      expect(foreignHistory).toEqual([]);

      const foreignActionable = (await rpcCall(orgB.supabase, "governance_list_actionable", {})) as unknown[];
      expect(foreignActionable).toEqual([]);

      // Org B cannot approve org A's decision.
      let foreignApproveError = "";
      try {
        await rpcCall(orgB.supabase, "governance_decide", {
          decisionId: unknownId,
          decision: "approved",
          overrideDecision: "ALLOW",
        });
      } catch (err) {
        foreignApproveError = err instanceof Error ? err.message : String(err);
      }
      expect(foreignApproveError).toContain("decision not found");
    },
    60_000,
  );
});