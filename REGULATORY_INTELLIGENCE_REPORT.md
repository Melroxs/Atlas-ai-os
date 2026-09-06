# ATLAS — 51-JURISDICTION REGULATORY INTELLIGENCE ACQUISITION & VERIFICATION

> Status: **IMPLEMENTED (acquisition pipeline operational; state-level verification pending)**
>
> The full regulatory intelligence layer is built and tested: 51 first-class
> jurisdictions, authority-tiered source registry, structured proposition
> layer with temporal versioning, deterministic extraction, verification
> state machine, contradiction engine, freshness monitoring, coverage
> scoring, an observable acquisition pipeline, and an admin dashboard.
>
> **Honest boundary:** no state statute/regulation has been fetched and
> verified against an official source in this phase — every state starts at
> zero verified propositions, represented as `RESEARCH_INCOMPLETE`, never as
> "no law exists". Only the 8 federal propositions already verified in the
> Atlas knowledge corpus (OSHA / EPA / FEMA) are `VERIFIED`.

---

## 1. Git

```text
Branch:        main @ a0a55b7 (clean baseline before this phase)
Working tree:  3 new paths + 2 modified files (uncommitted)
  src/lib/regulatory/                                (new — the domain)
  src/pages/RegulatoryIntelligence.tsx               (new — admin dashboard)
  supabase/migrations/20260906_atlas_regulatory_intelligence.sql (new — PENDING)
  src/components/app-shell.tsx                       (modified — nav entry)
  src/main.tsx                                       (modified — route)
```

## 2. Architecture

### Files created — `src/lib/regulatory/`

| File | Responsibility |
|---|---|
| `types.ts` | Entities: Jurisdiction, RegulatorySource, RegulatoryProposition, RegulatoryContradiction, AcquisitionJob, answer contract, coverage |
| `jurisdictions.ts` | **51-jurisdiction registry** (50 states + DC) with official insurance-department / legislature / admin-code URLs |
| `tiers.ts` | Authority-tier model (Tier 1–4) + ranking rules |
| `taxonomy.ts` | Atlas-specific regulatory taxonomy: 6 groups, ~60 topics, 10 actors, 21 claim phases, perils, supplement topics |
| `extraction.ts` | Deterministic extraction: citations, deadlines (incl. business days), dates, actors, claim phases, requirement/prohibition classification — **no model calls** |
| `propositions.ts` | Proposition construction, dedup keys, **temporal versioning** (never overwrite; claim-date resolution) |
| `verification.ts` | Verification state machine + tier caps (secondary can never be verified primary) |
| `freshness.ts` | Source-class + jurisdiction-aware freshness scoring |
| `contradictions.ts` | Contradiction engine: deadline conflicts, superseded sources, secondary-as-primary, effective-window overlap, model-law divergence, extraction-vs-source support |
| `completeness.ts` | `regulatory_intelligence_coverage_score` (10 weighted dimensions — explicitly NOT legal completeness) |
| `retrieval.ts` | Jurisdiction / temporal / actor / topic / phase / tier / confidence / verification filtering + the regulatory answer contract |
| `pipeline.ts` | Observable acquisition pipeline (13 stages), SSRF-safe fetch guard (domain allowlist, size/time/redirect limits, content-type validation), content hashing/diffing, freshness monitor, in-memory store |
| `seed.ts` | Initial registry: 51 jurisdictions, 51 dept sources, 10×2 priority-state code sources, 3 federal sources, 8 verified federal propositions |

### Files modified
- `src/components/app-shell.tsx` — "Regulatory" under the Intelligence nav group + page title.
- `src/main.tsx` — `/dashboard/regulatory` route (inside the existing `RequireAuth`/`AppShell` tree).

### Migrations
- `supabase/migrations/20260906_atlas_regulatory_intelligence.sql` — **PENDING, not applied** (consistent with the repo's known migration-history divergence; applies via the repo's `scripts/run-db-sql.mjs` convention after review, like 20260904 was). Additive only: 5 tables, RLS mirroring the `20260826_atlas_knowledge_layer` shared-industry pattern (authenticated read; `super_admin`/`atlas_admin` write), indexes, 51-jurisdiction seed + 54 source-registry seed rows.

### Services / jobs
- Acquisition pipeline is host-agnostic (works in CLI/CI/edge with real network; in the browser it records honest `fetch skipped` states). Freshness monitor returns deterministic review tasks for scheduling.

## 3. Database (migration — pending)

```text
regulatory_jurisdictions      — 51 rows seeded (50 states + DC)
regulatory_sources            — source registry (FK → jurisdiction, tier, status, hash, supersession)
regulatory_propositions       — versioned (lineage_key, version, previous_version_id, effective windows)
regulatory_contradictions     — explicit OPEN/RESOLVED records with both sources preserved
regulatory_acquisition_jobs   — observable stage log (13 stages, change_detected, model_used)
RLS: authenticated read; super_admin/atlas_admin write; service_role full — matches 20260826 industry pattern
Indexes: jurisdiction, topic, lineage+version, temporal window, verification status, job status
```

## 4. Knowledge (current state)

```text
Jurisdictions:                 51 / 51 (100%) — all first-class, all with official dept URLs
Sources registered:            54 (51 dept + 10 insurance-code + 10 admin-code for priority states, deduped to 3 per priority state; 3 federal)
Sources verified:              3 (federal — OSHA, EPA, FEMA, from existing corpus provenance)
Sources fetched:               0 (no live fetch run this phase)
Propositions extracted:        8 (federal, from the verified corpus)
Propositions verified:         8 (federal only — the ONLY verified propositions)
Propositions requiring review: 0
State-level propositions:      0 (by design — never fabricated)
Contradictions:                0 open (engine tested; nothing to detect at zero state coverage)
Stale sources:                 51 dept entries are UNKNOWN-freshness (never verified) — flagged by the freshness monitor honestly
```

## 5. Coverage — all 51 jurisdictions

Every jurisdiction is `RESEARCH_INCOMPLETE` at this phase: registry present,
zero verified state propositions. Priority states (FL TX CA NY CO LA MD WA AZ
GA) additionally carry insurance-code + admin-code registry sources.

```text
AL — RESEARCH_INCOMPLETE      AK — RESEARCH_INCOMPLETE    AZ — RESEARCH_INCOMPLETE*
AR — RESEARCH_INCOMPLETE      CA — RESEARCH_INCOMPLETE*   CO — RESEARCH_INCOMPLETE*
CT — RESEARCH_INCOMPLETE      DE — RESEARCH_INCOMPLETE    FL — RESEARCH_INCOMPLETE*
GA — RESEARCH_INCOMPLETE*     HI — RESEARCH_INCOMPLETE    ID — RESEARCH_INCOMPLETE
IL — RESEARCH_INCOMPLETE      IN — RESEARCH_INCOMPLETE    IA — RESEARCH_INCOMPLETE
KS — RESEARCH_INCOMPLETE      KY — RESEARCH_INCOMPLETE    LA — RESEARCH_INCOMPLETE*
ME — RESEARCH_INCOMPLETE      MD — RESEARCH_INCOMPLETE*   MA — RESEARCH_INCOMPLETE
MI — RESEARCH_INCOMPLETE      MN — RESEARCH_INCOMPLETE    MS — RESEARCH_INCOMPLETE
MO — RESEARCH_INCOMPLETE      MT — RESEARCH_INCOMPLETE    NE — RESEARCH_INCOMPLETE
NV — RESEARCH_INCOMPLETE      NH — RESEARCH_INCOMPLETE    NJ — RESEARCH_INCOMPLETE
NM — RESEARCH_INCOMPLETE      NY — RESEARCH_INCOMPLETE*   NC — RESEARCH_INCOMPLETE
ND — RESEARCH_INCOMPLETE      OH — RESEARCH_INCOMPLETE    OK — RESEARCH_INCOMPLETE
OR — RESEARCH_INCOMPLETE      PA — RESEARCH_INCOMPLETE    RI — RESEARCH_INCOMPLETE
SC — RESEARCH_INCOMPLETE      SD — RESEARCH_INCOMPLETE    TN — RESEARCH_INCOMPLETE
TX — RESEARCH_INCOMPLETE*     UT — RESEARCH_INCOMPLETE    VT — RESEARCH_INCOMPLETE
VA — RESEARCH_INCOMPLETE      WA — RESEARCH_INCOMPLETE*   WV — RESEARCH_INCOMPLETE
WI — RESEARCH_INCOMPLETE      WY — RESEARCH_INCOMPLETE    DC — RESEARCH_INCOMPLETE

(* = priority state with department + insurance-code + admin-code registry sources)
Federal (us): READY — 3 verified sources, 8 verified propositions (OSHA/EPA/FEMA)
```

## 6. Testing

```text
Regulatory domain:            99 passed / 0 failed
  jurisdictions (51 incl. DC, URLs, priority states)
  extraction (citations, deadlines, dates, actors, phases, requirement/prohibition)
  propositions (construction, dedup, version chains, claim-date temporal resolution)
  verification (tier caps, absence semantics, checklist state machine)
  contradictions (deadline conflict, superseded source, secondary-as-primary, model-law divergence, extraction support)
  freshness (class intervals, jurisdiction multipliers, rollup)
  retrieval (jurisdiction/actor/topic/tier/confidence filters, temporal correctness, answer contract)
  completeness (score, gaps, honest ceilings)
  pipeline (SSRF guard, content hashing, offline extraction, versioning, tier-3 capping, seed integrity)
  states-regression (10 materially different states: FL TX CA NY CO LA MD WA AZ GA)
Typecheck (scoped, all new/changed files): 0 errors
Full suite:                   1472 passed (was 1373; +99 new) · 8 failed — the IDENTICAL pre-existing
                               legacy milestone7/7b/9 failures · 5 skipped · ZERO new failures
Build:                        `bun run build` green (pre-existing chunk-size warnings only)
Repo-wide tsc -b:             unchanged 20 pre-existing ai-runtime errors (untouched)
```

## 7. Critical success criteria

| # | Criterion | Status |
|---|---|---|
| 1 | Dedicated regulatory intelligence layer | ✅ `src/lib/regulatory/` |
| 2 | 50 states + DC as first-class jurisdictions | ✅ 51/51, tested |
| 3 | Sources have provenance | ✅ source registry (publisher, URL, citation, tier, status) |
| 4 | Primary vs secondary authority distinguished | ✅ Tier 1–4 + `canCiteAsPrimary` |
| 5 | Secondary drives discovery, never auto-authoritative | ✅ `capVerificationForSource` invariant, tested |
| 6 | Structured regulatory propositions | ✅ `RegulatoryProposition` |
| 7 | Effective dates represented | ✅ `effectiveFrom/effectiveTo` |
| 8 | Historical versions preserved | ✅ version chains, `previousVersionId`, never overwrite |
| 9 | Contradictions explicit | ✅ `RegulatoryContradiction`, OPEN until human resolution |
| 10 | Freshness tracked | ✅ class+jurisdiction aware, freshness monitor |
| 11 | Claim-context retrieval | ✅ jurisdiction/date/actor/topic/phase/tier/confidence filters |
| 12 | Connects to Atlas evidence architecture | ✅ shares the verified corpus provenance; answer contract emits source trace |
| 13 | Identifies gaps without hallucination | ✅ `INSUFFICIENT_EVIDENCE` / `RESEARCH_INCOMPLETE`, never "does not exist" |
| 14 | Continuous updates supported | ✅ re-runnable pipeline, hashing/diffing, versioning, freshness monitor |
| 15 | Reuses existing infrastructure | ✅ knowledge corpus provenance, taxonomy vocabulary, workforce selectors/UI primitives, shadcn/ui, platform RLS pattern |
| 16 | No paid external service introduced | ✅ deterministic-only; the existing AI runtime is optional and unused here |
| 17 | Tests across materially different states | ✅ 10-state regression |

## 8. Known limitations (real ones only)

1. **State-level verification is pending by design.** No official state source
   was fetched this phase. Next milestone: run the pipeline where network
   access exists (CLI/CI/edge) against the seeded registry, starting with the
   10 priority states, and mark only fetch+checklist-verified content
   `VERIFIED`.
2. **Migration not applied** (`20260906`) — pending, consistent with the
   migration-divergence rule. The layer runs fully from the code registry
   (same model as the knowledge corpus).
3. **Browser fetch blocked** by the SSRF guard / CORS — recorded honestly as
   `fetch skipped`; real acquisition belongs outside the browser.
4. **Extraction is single-proposition per pipeline run** (per curated source
   snippet). Whole-chapter parsing into many propositions is the EMBED-stage
   scaling follow-up.
5. No embeddings were generated — the pipeline records the hook point and
   reuses the existing knowledge-layer embedding stack when wired.

## 9. Next recommended step

Run the **initial acquisition pass (STEP 12)** from a network-capable
environment: iterate the 10 priority states' insurance-code/admin-code
registry sources through `runAcquisitionPipeline` with the real fetch
policy, verify citations and text support, and promote only checklist-passing
propositions. Then apply migration `20260906` via the repo's raw-SQL
convention and wire a Supabase adapter for `RegulatoryStore` so the dashboard
reads persisted rows. That completes the loop from database → acquisition →
verification → retrieval → UI.