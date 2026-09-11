# ATLAS — Legacy Evidence & Page Reliability Fix (Findings + Supplement Document)

**Date:** 2026-09-09
**Scope:** Legacy-data resilience for evidence-bearing rows (findings, supplements,
candidates, supplement documents). Continuation of the master fix documented in
`ATLAS_KNOWLEDGE_GAPS_CRASH_FIX_REPORT.md`.
**Result:** Both production crash classes neutralized at the data boundary,
legacy values preserved (never dropped, never fabricated), 0 new failures in the
full suite (1663 passed / 5 skipped / 0 failed), typecheck clean.

---

## 1. Audit findings (Phases 1–3)

The requested "evidence graph / evidence sources" tables do not exist in this
repository. The evidence model is spread across tenant-scoped tables:

| Concept | Table(s) | Evidence-bearing columns |
|---|---|---|
| Claims | `insuranceClaims` | `evidenceSummary jsonb`, `evidenceDocumentIds jsonb`, `timeline jsonb` |
| Findings (AI-generated analysis) | `claimFindings` | `evidence TEXT` (⚠ legacy), `source text` |
| Supplements | `claimSupplements` | `evidence jsonb`, `affectedLineItems jsonb`, `requestedItems jsonb` |
| Claim candidates (reconstruction) | `claimCandidates` | `evidence jsonb`, `filePaths jsonb` |
| Knowledge graph | `entities`, `entityRelationships`, `knowledgeAssertions` | `evidence text` (relationship/assertion excerpts) |
| Ask Atlas citations | `askEvidence` | aggregated as arrays by `history_list_ask_sessions` |
| Recommendations evidence | `recommendationEvidence` | aggregated as arrays by `recommendations_list` |
| Governance evidence refs | `governance_decisions` | `evidence_references jsonb` (already hardened) |

### Legacy vs current write paths

- **Current 6-worker pipeline** always writes JSON arrays: `insurance_upsert_findings`
  inserts `v_finding -> 'evidence'` (jsonb), `insurance_create_supplement` and
  `insurance_upsert_candidates` receive jsonb arrays, demo/discovery engines build
  arrays in-memory.
- **Legacy rows** (pre-jsonb or pre-6-worker clients) can carry:
  - `claimFindings.evidence` as the *text rendering of an array* (`["estimate"]`),
    plain text (`estimate, invoice`), or malformed JSON — because the column was
    `TEXT` while the write path inserted a jsonb value (assignment-cast to text),
    and reads re-serialized it with `to_jsonb()` → a JSON **string**, not an array.
  - `claimSupplements.evidence` / `affectedLineItems` / `requestedItems` and
    `claimCandidates.evidence` as JSON strings, plain text, or objects.
  - `insuranceClaims.evidenceDocumentIds` as nested `{"value": …}` wrappers
    (old attach path) instead of plain UUID strings.

### Crash sites identified

1. **ClaimDetail open-findings list** — `f.evidence.map(...)` threw
   `TypeError: f.evidence.map is not a function` on the text-rendered array shape
   (fixed in the prior findings turn: `normalizeEvidence` decoder + TEXT→JSONB
   migration + hardened readers + package/ClaimDetail normalizers).
2. **ClaimDetail supplement document dialog** (new this turn) — the deployed
   `insurance_get_supplement_document` returns raw `{ claim, supplement }` rows,
   but the dialog rendered `doc.sections.map(...)`, `doc.disclaimer`,
   `doc.status`. None exist on the raw payload → every "View document" click
   crashed with `Cannot read properties of undefined (reading 'map')`. Legacy
   string evidence on the same rows could also crash `.join()`.
3. **Claim-candidate rows** — the `insurance_list_claim_candidates` boundary
   silently dropped non-array `evidence`/`documentTitles`/`archivePaths` to `[]`,
   losing legacy values from display.

---

## 2. Fixes

### A. Findings evidence canonicalization (prior turn — summarized)
- `src/lib/insurance/evidence.ts` (+ tests) — canonical `normalizeEvidence`
  decoder: real arrays pass through; JSON-array strings parse back; plain text /
  malformed JSON / objects are preserved as single discoverable entries; never
  throws, never fabricates, never drops.
- `supabase/migrations/20260909_atlas_findings_evidence_jsonb.sql` —
  `decode_evidence_text()` decoder, `claimFindings.evidence` TEXT→JSONB via the
  decoder (data-preserving cast), and every findings-serializing RPC re-created
  with a defensive decode so readers work before and after the column change.
- `logic.ts` / `package-types.ts` / `ClaimDetail.tsx` wired through the decoder.

### B. Supplement document boundary (this turn)
- **`buildSupplementDocument` (logic.ts)** — every list-valued field
  (`evidence`, `requestedItems`, `affectedLineItems`, `expectedScope`,
  `actualScope`) now passes through `normalizeEvidence` before joining. A legacy
  string/object/malformed value is coerced and preserved — `.join()` can never
  throw.
- **`normalizeSupplementDocumentResponse` (logic.ts, new)** — builds the derived
  document the dialog renders from the raw `{ claim, supplement }` RPC payload
  (or an already-flat row) via the same deterministic builder the workflows use.
  Missing/empty payload → `null` (dialog shows its loading state); sections and
  disclaimer are always present otherwise.
- **`api.ts`** — `insurance.getSupplementDocument` is now a boundary transform
  (`defT`) through that normalizer, matching the established pattern for
  `getClaimPackage` / `listClaims` / `recoveryAnalytics`.
- **`supabase/migrations/20260909b_atlas_supplement_evidence_decode.sql`** —
  re-creates `insurance_get_supplement_document` so the supplement's
  `evidence` / `requestedItems` / `affectedLineItems` are decoded server-side
  through `decode_evidence_text` (array stays array, legacy text becomes a single
  entry). Frontend transform makes the page safe even before this migration
  lands.

### C. Claim-candidate rows (this turn)
- **`api.ts` candidates transform** — `evidence` / `documentTitles` /
  `archivePaths` now use `normalizeEvidence` instead of `Array.isArray ? : []`,
  so legacy string values are preserved instead of silently dropped.
- **`matchCandidateEvidenceDocs` (logic.ts)** — same decoder for
  `filePaths` / `evidence` / `documentTitles`.

---

## 3. Files changed (this turn)

**New:**
- `supabase/migrations/20260909b_atlas_supplement_evidence_decode.sql`
- `src/lib/insurance/supplement-document.test.ts` (10 tests)

**Modified:**
- `src/lib/insurance/logic.ts` — hardened `buildSupplementDocument`; added
  `normalizeSupplementDocumentResponse`; hardened `matchCandidateEvidenceDocs`
- `src/lib/api.ts` — `getSupplementDocument` boundary transform; hardened
  candidate-row normalization
- `src/lib/insurance/evidence.test.ts` — candidate legacy-shape tests (+3)

**Carried over from the prior findings turn (still uncommitted):**
- `supabase/migrations/20260909_atlas_findings_evidence_jsonb.sql`
- `src/lib/insurance/evidence.ts` + `evidence.test.ts`
- `src/lib/insurance/logic.ts` / `package-types.ts` / `src/pages/ClaimDetail.tsx`

---

## 4. Verification

- `bun tsc -b --noEmit` — clean.
- Scoped surface (insurance + archive + governance + workforce + claim-discovery):
  **253 passed / 1 skipped**.
- Full suite (`bunx vitest run`): **1663 passed / 5 skipped / 0 failed**
  (live-gated e2e tests skipped by design; no pre-existing milestone failures
  reproduced this run).

---

## 5. What was NOT done (and why)

- **No destructive DB rewrite.** The migrations only add a decoder + a
  data-preserving column cast + hardened readers. Malformed rows are tolerated
  at every boundary, not rewritten; nothing is deleted, truncated, or
  re-generated.
- **No `evidence_graph` / `evidence_sources` tables invented.** The audit proved
  they do not exist; the evidence model is the tables listed in §1, all of which
  are now handled.
- **No error suppression.** The fixes live at the data boundary (decoders +
  boundary transforms), never as catch-and-continue at render sites.
- **`atlas-assistant` supplementDocument** left untouched: no producer currently
  exists in the converse edge, so the guarded render cannot receive a malformed
  payload.

---

## 6. Remaining recommendations (optional)

1. **Optional one-time hygiene** (not required for correctness): a reversible
   SQL pass that rewrites only genuinely malformed rows — e.g. `claimFindings`
   rows where `jsonb_typeof(evidence) != 'array'` after the migration — logging
   before/after per row. Same pattern as §13 of the knowledge-gaps report.
2. **Run `supabase db push`** to apply `20260909_atlas_findings_evidence_jsonb.sql`
   and `20260909b_atlas_supplement_evidence_decode.sql` to the linked project.
3. If a future converse response ever carries `supplementDocument`, route it
   through `normalizeSupplementDocumentResponse` before rendering.