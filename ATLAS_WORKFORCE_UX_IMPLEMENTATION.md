# ATLAS WORKFORCE UX IMPLEMENTATION

> Baseline: `main` @ `7fad459` · Build green · 17 new tests, zero new failures.

## 1. Before / after navigation

| Before | After |
|---|---|
| Operations: Atlas Home, Revenue Recovery, Work Queue, Workflows | **Command**: Command Center |
| Intelligence: Atlas Intelligence, Business Brain, Knowledge, Events | **Workforce**: Workers hub + Claims Manager + Supplement Specialist + Revenue Recovery + Project Manager + Estimator + Customer Success |
| Atlas: Ask Atlas, Actions, Recommendations, Activity/Audit | **Work**: Work Queue, Governance |
| Workspace: Connections, Team, Settings | **Intelligence**: Ask Atlas, Knowledge & Ingestion, Intelligence Packs, Business Brain, Recommendations |
| Admin / Mail / Pilot / Pilot Intelligence (role-gated) | **System**: Workflows, Events, Actions & Tools, Activity/Audit, Connections, Team, Settings |
| — | Admin / Mail / Pilot / Pilot Intelligence (unchanged, role-gated) |

## 2. Page mapping

| Route | Page | Status |
|---|---|---|
| `/dashboard` | **Command Center** (rebuilt) | ✅ new |
| `/dashboard/workers` | Workers hub | ✅ new |
| `/dashboard/workers/claims` | Claims Manager | ✅ new |
| `/dashboard/workers/supplements` | Supplement Specialist | ✅ new |
| `/dashboard/workers/recovery` | Revenue Recovery Coordinator | ✅ new |
| `/dashboard/workers/projects` | Project Manager | ✅ new |
| `/dashboard/workers/estimator` | Estimator | ✅ new |
| `/dashboard/workers/customers` | Customer Success Manager | ✅ new |
| `/dashboard/governance` | Governance (pending + history + gaps) | ✅ new |
| `/dashboard/revenue-recovery(/:id)` | Existing detailed view — retained, linked from workers | ✅ kept |
| All other `/dashboard/*` | Retained under Intelligence/System/Work | ✅ kept |

## 3. Six-worker mapping (one workforce, one data set)

Each worker is a **job function over the same claims/evidence/governance data** —
no duplicated claim logic. `src/lib/workforce/worker-defs.ts` is the single
catalog (routes, roles, responsibilities, attention categories, capability
domain); `src/lib/workforce/use-worker-data.ts` loads the shared backend data
once per page; `src/lib/workforce/selectors.ts` derives each worker's view.

| Worker | Attention categories | Backend services reused |
|---|---|---|
| Claims Manager | missing_evidence, claim_review, stale_claim | insurance_list_claims, candidates, work-queue service |
| Supplement Specialist | supplement_opportunity, financial_discrepancy | findings, work-queue, governance (supplement_preparation) |
| Revenue Recovery | financial_discrepancy, follow_up_needed, carrier_response_overdue, stale_claim | insurance_claim_counts, recovery analytics, work-queue |
| Project Manager | deadline_approaching, stale_claim, follow_up_needed | deadline tracker (trackDeadlines) |
| Estimator | financial_discrepancy, missing_evidence | estimator engine (generateEstimateLineItems) |
| Customer Success | follow_up_needed, deadline_approaching, document_request | orchestrator draftCommunication (governance-gated), follow-up scheduler |

## 4. Command Center

`/dashboard` answers: workforce status (six worker cards with live attention +
governance counts), attention queue (priority-sorted work items + governance
pending banner), financial intelligence (potential/outstanding/paid/requested —
real `insurance_claim_counts` fields), deadlines & at-risk (real
`trackDeadlines`), and the retained Daily Briefing panel. All empty states are
honest. The knowledge-graph visual was removed from the home page (still
available in Business Brain) — deliberate IA change, not data loss.

## 5. Data scalability

- **Ingestion (ArchiveDetail):** flat max-height table replaced with the
  **Collection → Group → Item** browser — files grouped by top-level folder,
  collapsible collections with counts, search across path/classification/doc
  title, status filters (failed/ingested/duplicates/blocked/unsupported),
  per-group pagination, Expand/Collapse all.
- **Knowledge docs list:** search + pagination + counts.
- **Work Queue:** search + item count + pagination over claim groups.
- **New Governance page:** search + decision filter + pagination from day one.
- **New worker lists:** every list (attention, claims, deadlines, estimators)
  ships with search/filter/pagination via shared components
  (`AttentionList`, `ClaimsTable`, `CollectionBrowser`).

## 6. Ingestion hierarchy

`CollectionBrowser` (shared) implements the Collection→Group→Item model and is
reused by ArchiveDetail. Individual items stay independently addressable
(per-file retry, document links, claim-hint chips).

## 7. Knowledge UI

Docs list + archives retained on `/dashboard/knowledge` with search/pagination.
Intelligence packs remain under Intelligence. The corpus-backed Knowledge Base
is unchanged (separate phase concern).

## 8. Governance integration

New standalone **Governance** page (`/dashboard/governance`): pending decisions
with Approve/Reject/Escalate, decision history with full provenance (decision,
risk, jurisdiction, rationale, gaps, approvals, override), search/filter/
pagination. Every worker page surfaces its own governance decisions in context,
and the Command Center banners pending governance. All decisions come from the
persisted Supabase RPCs — no client-side fabrication. BLOCK/UNKNOWN remain
override-only and are labeled as such.

## 9. Reused backend capabilities

All worker pages read through the **existing** RPCs and services:
`insurance_list_claims`, `insurance_claim_counts`, `insurance_recovery_analytics`,
`insurance_list_claim_candidates`, work-queue `buildWorkQueue`, deadline
`trackDeadlines`, governance `listActionableGovernance` /
`pendingGovernanceForWorker`, orchestrator `draftCommunication` (governance-gated),
estimator `generateEstimateLineItems`. No new backend, no new Supabase schema.

## 10. New frontend capabilities

`src/lib/workforce/` (worker catalog, pure selectors, data hook),
`src/components/workforce/` (worker-page scaffold, attention-list, claims-table,
collection-browser), 8 new pages (workers hub, 6 workers, governance),
Command Center, restructured nav + routes + page titles.

## 11. Remaining capability gaps (honest)

- No communication **send** integration — drafting is real, sending stays human
  (stated in UI).
- No Xactimate integration — estimator output is review-ready data for a human
  (stated in UI).
- No insurer **submission** integration — supplements stay
  PREPARED/AWAITING_EXTERNAL_EXECUTION.
- Workflows/Jobs pages still use internal status language (System section) —
  business-language translation is a follow-up.
- Claim candidates require a review action on the existing Revenue Recovery
  page; worker cards link there (no duplicate approve logic added).

## 12–15. Test / build / type / pre-existing

- 17 new selector tests, all passing.
- Full suite: **1373 passed** (was 1356) / 8 failed / 5 skipped — the 8 are the
  identical pre-existing legacy `milestone7/7b/9` failures. Zero new.
- `bun run build`: ✅ green (chunk-size warnings only, pre-existing).
- Scoped `tsc`: ✅ 0 errors on all changed files. Repo-wide `tsc -b` retains the
  pre-existing 20 `src/lib/ai-runtime/*` errors (untouched).
- Known pre-existing failures unchanged; live E2E tests still gated by
  `RUN_LIVE_E2E=1` (skipped in the default run).

## 16. Manual browser verification

**Not performed** — no browser is available in this environment. The pages were
verified by scoped typecheck, the production build, unit tests on the selector
logic, and static wiring review against live RPCs. Recommended click-through
(Phase 29 checklist): login → Command Center → each of the six workers →
Governance → Knowledge/Ingestion expand/collapse → search/filter large
collections → ClaimDetail Atlas Review → governance history → no broken
routes / console errors.