# ATLAS CONNECTION AUDIT

> **Scope:** Governed Digital Employee + Knowledge Acquisition phase.
> A capability is NOT implemented merely because a file exists. It is implemented
> only when it is: **PERSISTENCE → TRIGGER → WORKFLOW → AGENT/ENGINE → VALIDATION →
> ACTION → EVIDENCE → UI/USER VISIBILITY → COMPLETION STATE**.
>
> This audit was performed against working tree HEAD `927a3cf` (main). Every
> "Connected" claim below was verified by tracing callers, not by file presence.

---

## 1. CONNECTED — verified end-to-end (or nearly so)

| Capability | Persistence | Trigger | Engine | UI | Notes |
|---|---|---|---|---|---|
| **Atlas Workforce orchestrator** (`src/lib/orchestrator/atlas-workforce.ts`) | Claim data from Supabase via `insurance_get_claim_package` RPC | UI buttons, voice commands, jobs worker | Deterministic analyzers in `src/lib/insurance/logic.ts` | `AtlasReviewPanel`, `WorkQueue`, `ClaimDetail`, `Dashboard`, `DailyBriefingPanel` | Fully invoked from `useAtlasWorkforce` (UI), `claim-review-handler` (jobs), and voice runtime. |
| **Claim review workflow** (`src/lib/workflows/claim-review.ts`) | No direct persistence (in-memory result) | Manual | 8-stage deterministic pipeline | ClaimDetail via panel | Runs end-to-end but its result is not persisted to a `workflows` table; downstream of orchestrator. |
| **Supplement preparation** (`src/lib/workflows/supplement-preparation.ts` + orchestrator `prepareSupplement`) | Reads claim; draft outputs returned to caller | UI / jobs (`supplement_preparation`) | 8-stage workflow | Review panel + work queue | Outputs require human review; nothing submitted externally. |
| **Work queue** (`src/lib/work-queue/service.ts`) | Derived from claim data at read time | Daily scan / review | Deterministic | `WorkQueue.tsx` page | Not stored in DB — recomputed. Acceptable for MVP but flagged below. |
| **Communications drafting** (`src/lib/comms/drafting.ts`) | Drafts returned in result | UI / jobs | Template engine | Review panel communications section | Sending requires approval; no auto-send path exists. |
| **Daily briefing** (`src/lib/comms/daily-briefing.ts`) | Reads claims | UI / jobs (`daily_scan`) | Deterministic | `DailyBriefingPanel`, Dashboard | |
| **Deadline tracker** (`src/lib/comms/deadline-tracker.ts`) | Reads claim dates | Review / daily scan | Deterministic | Panel deadlines section | |
| **Follow-up scheduler** (`src/lib/comms/follow-up-scheduler.ts`) | Reads claim state | Review / daily scan | Deterministic | Panel / queue | |
| **Jobs system** (`src/lib/jobs/*`) | `atlas_jobs` + RPCs (migration 0020) | RPC enqueue | `AtlasWorker`, handler registry | Admin runtime status | `registerClaimReviewHandlers` wires orchestrator handlers. |
| **Agent runtime** (`src/lib/agents/*`) | Job steps | `enqueueAgentTask` | Agent registry + runtime | Pipeline/Jobs UI | Registered handlers execute deterministic evidence/gap/supplement/QA steps. |
| **Knowledge corpus** (`src/lib/knowledge/corpus/*`) | Static seed data (112+ records) | Retrieval / Ask Atlas | `retrieveKnowledge` + corpus importer | Knowledge page | Machine-queryable via `normalizeCorpusToKnowledgeItems`. |
| **Evidence/contradiction infra** (`src/lib/evidence/*`, `src/lib/insurance/*`) | Persisted via actions layer | Document ingestion / review | Deterministic | ClaimDetail, Reviews | |
| **Voice runtime** (`src/lib/voice-runtime/*`) | Session events | Wake word / mic | Intent router → orchestrator | `voice-session.tsx` | Voice commands reach the orchestrator. |

---

## 2. DISCONNECTED / LIBRARY-ONLY — exists but has NO caller

This is the critical finding of this audit. A file existing does not mean the
capability exists.

### 2a. Governance engine — ZERO callers ❌

`src/lib/governance/` is a complete, well-formed engine with **no references
from any other module** (verified via code search: `evaluateCompliance`,
`executeGovernanceGate`, `gateCommunication`, `gateSupplement`, `gateFinancial`
appear only inside `src/lib/governance/`).

| File | Status |
|---|---|
| `src/lib/governance/types.ts` | Library-only — full knowledge model, authority hierarchy, evidence chain, pipeline types |
| `src/lib/governance/authority.ts` | Library-only — authority sorting, temporal filtering, SOL check |
| `src/lib/governance/jurisdiction.ts` | Library-only — 51-state resolution, regulators, building authority |
| `src/lib/governance/compliance.ts` | Library-only — compliance evaluator, `KnowledgeSource` interface |
| `src/lib/governance/governance-gate.ts` | Library-only — gate + communication/supplement/financial wrappers |
| `src/lib/governance/role-boundary.ts` | Library-only — action/role authorization matrix |
| `src/lib/governance/*.test.ts` | **Missing** — the entire governance engine has zero tests |

**Consequence:** Atlas currently executes material actions (supplement
preparation, communication drafting, financial calculations) with **no
governance evaluation, no authority hierarchy applied, no jurisdiction
resolution, no evidence chain, no audit trail of the compliance decision.** This
violates the core phase requirement: *"Atlas must never be allowed to execute a
material action without the applicable governance evaluation."*

### 2b. Knowledge-object bridge — MISSING ❌

The governance engine defines `KnowledgeObject` (normalized, machine-queryable),
but nothing converts the existing corpus (`CorpusKnowledgeRecord`, seed
knowledge in `src/lib/atlas-data/authority.ts`) into `KnowledgeObject[]`. The
governance gate therefore has no production knowledge source; only
`createInMemoryKnowledgeSource` (test helper) exists.

### 2c. Authority duplication — TWO incompatible systems ⚠️

- `src/lib/governance/authority.ts` — 11-level `AuthorityLevel` + `AUTHORITY_RANK`.
- `src/lib/atlas-data/authority.ts` — 5-tier `AuthorityTier` (tier1–tier5) with
  source registry + seeds.

Both encode "law > standard > practice" but are unconnected and use different
rankings. The governance engine must be the single authority resolution layer;
the atlas-data tiers feed it as source metadata, not as a parallel resolver.

### 2d. Other library-only / not-yet-connected

| Item | Status | Gap |
|---|---|---|
| `src/lib/orchestrator/estimator.ts` | Exists | Not invoked by orchestrator `reviewClaim`/`prepareSupplement` paths (exported from index only) |
| `src/lib/atlas-data/*` (authority, everest-insurance, workflows-registry, connectors-registry) | Exists | No callers found from orchestrator/governance/UI |
| `src/lib/knowledge/embeddings.ts` | Exists | Deterministic fallback only; no external provider configured |
| `src/lib/recommendations/decide.ts` | Exists | Separate from work queue; not merged into orchestrator output |
| `src/lib/workflows/index.ts` barrel | Exists | `executeClaimReviewWorkflow`/`executeSupplementPreparationWorkflow` have no callers — the orchestrator reimplements similar logic inline instead of invoking these workflows (duplication) |
| `PipelineRecord` / acquisition pipeline types (`governance/types.ts`) | Type-only | No ingestion pipeline implementation consumes them |

---

## 3. WHAT HAS TESTS vs WHAT DOESN'T

| Area | Test coverage |
|---|---|
| Insurance logic (completeness, findings, reconcile) | ✅ `insurance/*.test.ts` |
| Jobs engine / worker / pipeline orchestrator | ✅ `jobs/engine.test.ts`, `worker.test.ts`, `pipeline-orchestrator.test.ts` |
| Agents (evidence/gap/supplement/QA) | ✅ `agents/agent-runtime.test.ts` |
| Knowledge corpus validation | ✅ `knowledge/corpus/corpus.test.ts`, `knowledge/integration.test.ts` |
| Comms engines (drafting, briefing, deadlines, follow-ups) | ❌ No tests |
| Work queue service | ❌ No tests |
| Orchestrator (`atlas-workforce.ts`) | ❌ No tests |
| **Governance engine (all six files)** | ❌ **No tests** |

---

## 4. DUPLICATION

1. **Claim review logic is implemented twice**: `src/lib/workflows/claim-review.ts`
   (8-stage workflow, no callers) vs the inline pipeline inside
   `orchestrator/atlas-workforce.ts` `reviewClaim()` (live path). One should call
   the other.
2. **Supplement logic implemented twice**: `src/lib/workflows/supplement-preparation.ts`
   (no callers) vs orchestrator `prepareSupplement()` (live path).
3. **Authority hierarchy duplicated**: governance `AuthorityLevel` vs atlas-data
   `AuthorityTier` (see 2c).

---

## 5. IMMEDIATE CONNECTION PLAN (this phase)

1. **Bridge knowledge → governance**: convert corpus + authority seeds to
   `KnowledgeObject[]` behind the `KnowledgeSource` interface
   (`src/lib/governance/knowledge-source.ts`).
2. **Run the gate in the orchestrator**: `reviewClaim` (claim_analysis),
   `prepareSupplement` (supplement_preparation), `draftCommunication`
   (communication_drafting), `calculateRecovery` (financial_calculation) must
   each pass through the governance gate before producing output; results
   recorded in `OrchestrationResult.governance` and evidence records.
3. **Surface governance in UI**: Atlas Review Panel gains a governance card
   (decision, risk, applicable rules, required approvals, knowledge gaps).
4. **Test the wiring**: knowledge-source mapping tests + orchestrator governance
   tests (ALLOW / REVIEW_REQUIRED / PROHIBITED paths).
5. **Next phase**: persist governance decisions + knowledge objects to Supabase,
   and route orchestrator claim/supplement work through the existing workflow
   modules instead of the inline duplicates.

---

## 6. VERDICT

The execution engine (orchestrator → jobs → agents → UI) is genuinely connected.
The **governance engine is not**: it is the largest single block of
production-intent code in the repository with zero callers, zero tests, and no
knowledge source. Completing the governed digital employee requires wiring that
engine into the orchestrator's material action paths and giving it a real
knowledge source — which is exactly what this phase implements.