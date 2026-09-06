# ATLAS — `knowledge_gaps.map is not a function` Fix

**Date:** 2026-09-06
**Severity:** Production/preview runtime crash
**Result:** FIXED — boundary hardened at the data layer, the two crash sites neutralized, tests added, same-class scan clean.

---

## 1. Root cause

`TypeError: a.knowledge_gaps.map is not a function` occurred in the compiled ClaimDetail chunk because ClaimDetail renders `<AtlasReviewPanel>`, whose `GovernanceHistory` component iterates persisted governance decision rows and calls:

```ts
row.knowledge_gaps.length > 0 && row.knowledge_gaps.map((g) => g.description).join("; ")
```

on a row whose `knowledge_gaps` JSONB value was **not an array** at runtime. A truthy non-array (e.g. `{}`) passes the `length > 0` check and then `.map()` throws.

Two render surfaces hit the identical unsafe pattern:

- `src/components/workforce/atlas-review-panel.tsx` — `GovernanceHistory` rows (the crash site)
- `src/pages/WorkQueue.tsx` — `governanceItems` rows

A third surface, `src/pages/Governance.tsx`, already had an `Array.isArray` guard but still used an unsafe `as Array<{ description: string }>` cast.

The same jailbreak exists conceptually on `UseAtlasWorkforce` return paths, but those carry `GovernanceSummary.knowledgeGaps: GovernanceGapRef[]` which is assembled in-memory by the orchestrator and is always a real array — that path is fine.

---

## 2. Actual runtime shape found

The persistent shape is defined by the governance audit table:

- Migration `supabase/migrations/20260904_atlas_governance.sql`: `knowledge_gaps JSONB NOT NULL DEFAULT '[]'`
- `src/lib/governance/persistence.ts` `GovernanceDecisionRow.knowledge_gaps: Array<Record<string, unknown>>`

The **current write path** is clean: `persistGovernanceDecision` writes `JSON.stringify(record.knowledgeGaps)` where `record.knowledgeGaps` is `summary.knowledgeGaps.map((g) => ({ ...g }))` — always a serialized array. The column default is `'[]'`. So any **correct current write** stores an array.

Therefore the runtime non-array value is a **pre-existing persisted row** — legacy/seed data written before the array invariant was fully enforced, or a direct SQL insert — not an active code path producing bad values. The app previously trusted the DB layer to always return an array; that trust was violated by at least one historical row.

---

## 3. Canonical contract

The authoritative in-memory type already exists: `KnowledgeGap` in `src/lib/governance/types.ts` (id, description, impact, suggestedSource, canContinueSafely, requiresHumanReview, triggeredBy, severity).

For **persisted** governance rows, the stored shape is the compact gap *reference* that the orchestrator serializes: `{ description, severity, impact?, requiresHumanReview? }` — i.e. `GovernanceGapRef`. So I introduced a distinct persisted-row type rather than conflating the two:

- `KnowledgeGapRow` — the shape actually stored/returned in governance decision rows
- `KnowledgeGap` — the richer workflow-facing type (re-exported from the normalizer for consumers that need it)

This keeps the two models honest: nothing is silently invented, and the persisted shape is what the DB actually carries.

---

## 4. Normalization strategy

**Layered, single-responsibility, defensive at every boundary:**

### A. Shared normalizer — `src/lib/governance/normalize-knowledge-gaps.ts`

`normalizeKnowledgeGaps(value: unknown): KnowledgeGapRow[]` handles:

- `null` / `undefined` / missing → `[]`
- a real array of gap objects → normalized array (string fields coerced, non-object entries dropped)
- a JSON string containing an array → parsed + normalized
- malformed JSON string → `[]` (dev diagnostic logged)
- an unexpected object → `[]`
- unexpected primitives (`number`, `"string"`, `boolean`) → `[]`
- a JSON string that parses to a non-array → `[]`

It never throws. A malformed historical row is discoverable (dev warn) but never crashes the UI.

### B. Row-level normalizer — same module

`normalizeGovernanceDecisionRow(row: unknown): NormalizedGovernanceDecisionRow` converts a raw governance decision row (typed `GovernanceDecisionRow` from the persistence module, or any unknown/malformed object) into a row whose **every** JSONB array field is guaranteed to be an array:

- `knowledge_gaps` → `KnowledgeGapRow[]`
- `applicable_rules` → `Array<Record<string, unknown>>`
- `applicable_standards` → `Array<Record<string, unknown>>`
- `evidence_references` → `Array<Record<string, unknown>>`
- `required_approvals` / `citations` (pg `text[]` — already safe, but run through a tolerant normalizer anyway)

Enum-ish scalar fields (`decision`, `execution_status`, `approval_status`) are coerced to their canonical values with safe fallbacks (`UNKNOWN` / `not_executed` / `not_required`).

### C. Hardened render sites

- **`atlas-review-panel.tsx` `GovernanceHistory`**: each raw row is normalized (`const row = normalizeGovernanceDecisionRow(r)`) before any field access; the gap render uses `row.knowledgeGaps.map(...)` on the guaranteed array.
- **`WorkQueue.tsx`**: same pattern — normalized `g` for display, raw `row` only for the callback pass-through (`handleGovernanceDecision(row, ...)`).
- **`Governance.tsx` `DecisionRow`**: replaced the local `Array.isArray(...)` + unsafe cast with `normalizeKnowledgeGaps(row.knowledge_gaps)`.

### D. Persistence module

- `persistence.ts` re-exports `normalizeKnowledgeGaps`, `normalizeGovernanceDecisionRow`, `KnowledgeGapRow`, `NormalizedGovernanceDecisionRow` so render sites import from one place.

### E. ClaimDetail / orchestrator in-memory path

No change required — that path already carries typed arrays (`GovernanceSummary.knowledgeGaps: GovernanceGapRef[]`). Left untouched.

---

## 5. Existing bad records

- The **active write path** produces valid JSON arrays — no ongoing source of new bad rows.
- At least one **historical persisted row** carries a non-array `knowledge_gaps`. The exact live shape was not read or printed (no secrets, no DB dump). The normalizer is designed to survive any shape and preserve usable entries inside bad rows.
- **A DB migration that rewrites/sanitizes existing rows was NOT created and NOT run.** Rationale:
  - It is not required to fix the crash — the app is now safe regardless of stored shape.
  - Rewriting JSONB without inspecting the actual live values risks destroying usable gap information.
  - If a one-time normalization pass is later desired, it should be a reversible, reviewed raw-SQL operation against the live Supabase project that only touches genuinely malformed rows and leaves valid array rows untouched — treated as optional data hygiene, not a release dependency.

---

## 6. Migration / backfill required?

**No.** The fix is application-level normalization; it does not require a schema change, does not require altering the governance tables, and does not depend on migration `20260904` being re-run. The column definition and RLS are unchanged.

---

## 7. Tests added

### `src/lib/governance/normalize-knowledge-gaps.test.ts` (12 tests)

Covers the full normalization matrix:

- `null` / `undefined` / missing → `[]`
- valid array of gap references → normalized array (string coercion, optional fields preserved)
- JSON string containing a valid array → parsed + normalized
- malformed JSON string → `[]` (logged in dev)
- unexpected object → `[]`
- unexpected primitives (number / bare string / boolean) → `[]`
- JSON string that parses to a non-array → `[]`
- `requiresHumanReview` honored only when it is a real boolean

Plus a **regression suite** proving the exact production crash cannot return:

- a governance row whose `knowledge_gaps` is an object, a non-array JSON string, or a mixed array with non-objects → `knowledgeGaps` is always a real array
- iteration / `.map/.join` on the normalized row never throws
- usable entries inside bad rows are preserved (e.g. `{description:"real", severity:"critical", requiresHumanReview:true}` survives inside `[null, "str", 7, {...}]`)

And a test replicating the **exact JSX render pattern** from AtlasReviewPanel / WorkQueue against a zero-gaps row (where `knowledge_gaps` is `null`) to confirm the empty path is also safe.

### Existing suite unchanged

- `src/lib/insurance/claim-package.test.ts` — unchanged; still guards the claim-package boundary.
- No existing tests were weakened or removed.

---

## 8. Same-class scan

Ran a repo-wide scan for the unsafe pattern on the affected field:

```
knowledge_gaps.map / .filter / .reduce / .length / [ indexing
```

Remaining hits after the fix:

- **In-memory typed paths** — orchestrator `gate.compliance.knowledgeGaps`, `governance-gate.ts`, `compliance.ts` — built by the engine as `KnowledgeGap[]`, never raw DB. Safe.
- **Normalized render paths** — WorkQueue `g.knowledgeGaps`, review panel `row.knowledgeGaps` after normalization. Safe.
- **Test assertions** — expected.

No remaining raw-DB `knowledge_gaps` access that calls array methods without normalization.

The adjacent JSONB array fields on the same rows (`applicable_rules`, `applicable_standards`, `evidence_references`) are now normalized in the same row normalizer, so the same bug class cannot recur on them either. The pg `text[]` columns (`required_approvals`, `citations`) are always real arrays from Supabase and were not the crash vector.

---

## 9. Files changed

**New:**

- `src/lib/governance/normalize-knowledge-gaps.ts` — canonical normalizer + row normalizer
- `src/lib/governance/normalize-knowledge-gaps.test.ts` — normalization matrix + regression suite

**Modified:**

- `src/lib/governance/persistence.ts` — re-export the normalizer types/functions
- `src/components/workforce/atlas-review-panel.tsx` — normalize governance history rows before render; remove unsafe cast
- `src/pages/WorkQueue.tsx` — normalize actionable governance rows before render; remove unsafe cast
- `src/pages/Governance.tsx` — use shared normalizer for `knowledge_gaps`; remove unsafe cast

---

## 10. Test / build results

- **Scoped typecheck (`tsc --noEmit -p tsconfig.app.json`):** 0 errors across the new and changed files.
- **Normalization + claim-package test files:** 28 passed.
- **Curated affected surface (governance lib + insurance boundary + workforce data/selectors):** 54 passed, 1 skipped (live-gated).
- **Full suite (`bunx vitest run`):** 1484 passed / **8 failed** / 5 skipped.
  - The 8 failures are the **identical pre-existing legacy set**: `milestone7.test.ts` (3), `milestone7b.test.ts` (3), `milestone9.test.ts` (2) — all `require('./jobs/...)` / `require('./agents/...)` module-resolution failures unrelated to this fix.
  - **0 new failures.**
- **`bun run build`:** green — pre-existing chunk-size warnings only, no new ones.

---

## 11. Git diff summary

- New module + test: `src/lib/governance/normalize-knowledge-gaps.ts`, `src/lib/governance/normalize-knowledge-gaps.test.ts`
- Re-export added in `src/lib/governance/persistence.ts`
- Three render surfaces hardened: `atlas-review-panel.tsx`, `WorkQueue.tsx`, `Governance.tsx`

---

## 12. What was NOT done (and why)

- Did **not** modify the governance migration or table definitions.
- Did **not** run a DB backfill / data rewrite (not required; risky without inspecting live values; documented as optional hygiene instead).
- Did **not** weaken governance semantics to make the UI smoother — BLOCK/UNKNOWN handling is unchanged.
- Did **not** touch the orchestrator in-memory path (already typed and safe).
- Did **not** suppress the error by catching/log-and-continuing at the render site — the fix is at the data boundary, which is the correct layer.

---

## 13. Recommended next step (optional)

If the team wants to eliminate the historical bad rows rather than merely tolerate them:

1. Connect to the live Supabase project.
2. Inspect actual `knowledge_gaps` values on `governance_decisions` where `jsonb_typeof(knowledge_gaps) != 'array'`.
3. If the values are recoverable, write a reversible raw-SQL pass (e.g. via `scripts/run-db-sql.mjs`) that sets `knowledge_gaps = '[]'` only for genuinely malformed rows, logging each changed row id before and after.
4. Commit the script as diagnostic/history tooling only if it proves useful — not as part of this fix.

No action is required for the crash to be resolved.
