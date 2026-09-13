# ATLAS — REMAINING ENGINEERING ROADMAP

> **Purpose.** After the audit (Phase 1) and blueprint (Phases 2–18), this document
> scores the current state, names the biggest gaps, and prioritizes the build
> (Phase 20) — ending with ONE recommended next phase (Phase 21 says: do not start
> it yet).
>
> **Scoring rule:** 0 = missing · 1 = conceptual · 2 = implemented but disconnected
> · 3 = connected · 4 = governed/tested · 5 = production-ready. Every score is
> justified in `ATLAS_DIGITAL_EMPLOYEE_CAPABILITY_AUDIT.md`. No score is inflated.

---

## 1. Current Atlas maturity (honest, per worker)

| Worker | Maturity | One-line justification |
|---|---:|---|
| Claims Manager | **45%** | Analysis spine is real, governed, persisted, and tested; no enforced lifecycle, no coverage/policy context, no autonomous intake |
| Supplement Specialist | **25%** | Opportunity detection + draft/package + governance exist; no line-item reasoning, no estimate ingestion, no submission |
| Revenue Recovery Coordinator | **25%** | Aggregates + discrepancy detection + reconciliation math are real; no payment history, no matching, no aging, no collections |
| Project Manager | **10%** | A deadlines/staleness dashboard over claims; no project entity, schedule, milestones, or dependencies |
| Estimator | **20%** | Deterministic line-item candidates with honest disclaimers; no pricing, no photo/measurement input, no persistence, no Xactimate |
| Customer Success Manager | **15%** | Overdue detection + governed drafting; no customer records, no send path, no communication history |
| **Cross-worker workforce** | **15%** | One dataset + one governance trail, but zero persisted handoffs/work items — six views, not one workforce |

## 2. Six-worker scorecard (0–5)

| Worker | Knowledge | Reasoning | Evidence | Calculations | Outputs | Actions | Governance | Integrations | Completion |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Claims Manager | 2 | 3 | 3 | 3 | 3 | 2 | 4 | 1 | 2 |
| Supplement Specialist | 2 | 2 | 2 | 2 | 3 | 1 | 4 | 0 | 1 |
| Revenue Recovery | 2 | 2 | 2 | 3 | 3 | 2 | 3 | 1 | 1 |
| Project Manager | 1 | 2 | 1 | 1 | 2 | 1 | 1 | 0 | 1 |
| Estimator | 2 | 2 | 2 | 2 | 3 | 1 | 3 | 0 | 1 |
| Customer Success | 1 | 2 | 1 | 1 | 2 | 1 | 3 | 1 | 1 |

Supporting evidence per score:
- **Knowledge** — corpus is seed-grade (112 records, 51 placeholder jurisdiction
  profiles, 8 federal regs); nothing verified → max 2 everywhere; PM/CS at 1
  (no project/customer knowledge at all).
- **Reasoning** — deterministic analyzers are excellent (3); no line-item, project,
  or communication reasoning → 2 elsewhere.
- **Evidence** — claim-level evidence linking is real (3); per-line-item chains
  missing everywhere else → 1–2.
- **Calculations** — reconciliation/completeness/deadline math real (3); aging,
  matching, pricing, scheduling math missing → 1–2.
- **Outputs** — all workers produce real documents/views (2–3); none produce
  completion-grade work products.
- **Actions** — claims CRUD + analysis + payment recording (2); drafts only
  elsewhere; no send/submit/schedule → 1.
- **Governance** — orchestrator paths fully gated + persisted (4) for CM/SS;
  estimator output, claim-stage writes, supplement-outcome writes ungated (3);
  PM has no wired gates (1).
- **Integrations** — Drive/manual upload only (1); estimator/CS have no
  worker-relevant integrations (0–1).
- **Completion** — no worker can reach its JOB COMPLETE definition (1–2).

## 3. The 10 most important gaps preventing job completion

1. **No estimate/line-item data structure.** The Estimator and Supplement
   Specialist cannot do their jobs because the original estimate is a number +
   scope arrays, not lines with quantities/prices/evidence. (P0/P1)
2. **No payment history / recovery event ledger.** `paymentAmount` is a running
   total; expected-vs-received reconciliation, aging, and auditability are
   impossible. (P0 — incorrect financial calculations are a safety issue)
3. **The agents/jobs/AI-runtime layer is dormant.** The most capable automation in
   the repo (4 agents, job engine, model router) has zero production callers.
   Either wire it through governance or remove the risk of it being enabled
   ungoverned. (P0)
4. **No persisted work items or handoffs.** The workforce has no memory between
   page loads; "who owns the next action" is recomputed, not a fact. (P1)
5. **No worker communication send path — and no unified approval-to-send
   enforcement.** Drafts are real; nothing can be sent; when send is built it must
   be gated on persisted decisions. (P1, governed)
6. **No project entity/state machine.** Project Manager is a dashboard; there is
   nothing to manage. (P1)
7. **Claim lifecycle is an ungoverned free string.** Stage moves, closure, and
   supplement outcome writes bypass the governance gate. (P0)
8. **Estimator output bypasses governance.** `estimate_calculation` is ALLOW in the
   matrix, but the estimator engine output never passes the gate, and
   `estimate_review`/engineering boundaries are not content-aware. (P0)
9. **Jurisdiction knowledge is placeholder.** Deadline rules exist for 4 states as
   unverified constants; 51 profiles are explicitly non-authoritative; no verified
   Tier 1 knowledge exists anywhere. (P0 — deadlines/actions driven by it must not
   fire on placeholders)
10. **OCR is unavailable.** Scanned evidence cannot become text, capping claim
    reconstruction and supplement evidence for a large share of real restoration
    files. (P2, but an enabler for everything upstream)

## 4. Knowledge gaps (most important missing knowledge)

1. Verified state insurance codes / unfair-claims-practices statutes (all 50 + DC).
2. Verified statutes of limitations per state and claim type (4 heuristic rules
   today — none statute-cited).
3. Adjuster/producer licensing rules per state (drives coverage_determination
   REVIEW_REQUIRED + licensed-review boundaries).
4. IICRC-style restoration standards content (licensed, citation-integrated) —
   water/fire/mold scope is currently heuristics.
5. Estimating methodology + pricing data (Xactimate-class, licensed) — nothing
   exists and nothing may be copied.
6. Adopted building codes per jurisdiction (permits, code-upgrade scope).
7. Consumer-protection/collections constraints (TCPA-type contact rules,
   FDCPA-type collection limits) for CS and RR.
8. Company SOPs (Tier 5, tenant-scoped) — the operational ground truth for every
   worker's allowed actions.
9. Consent/privacy framework for customer contact.
10. Carrier-specific procedures (Tier 3) — per-carrier, accumulated per tenant.

## 5. Regulatory gaps (jurisdictions/topics where authoritative knowledge is missing)

- **Every state** except 4 PARTIAL deadline heuristics is PLACEHOLDER or UNKNOWN;
  territories (PR/GU/VI/AS/MP) are UNKNOWN with no profile.
- Topics with **zero** coverage at any authority level: state claim-handling
  obligations, adjuster licensing, appraisal/mediation, complaint handling,
  communication requirements, document retention, contractor/trade licensing,
  consumer protection, consent/contact rules, adopted codes and permits.
- Federal: 8 seed regulation records exist but are unverified (no human review
  status, no dates verified) — they must not drive actions until verified.
- **Consequence:** any jurisdiction-dependent action today resolves to
  non-authoritative knowledge or UNKNOWN → BLOCK, which is correct but means Atlas
  cannot yet act on jurisdiction-specific rules at all.

## 6. Professional-boundary gaps (must remain human-reviewed or blocked)

Already enforced (ALLOW/REVIEW_REQUIRED/BLOCK matrix + persistence): legal
conclusions, engineering/medical determinations, contract execution, financial
commitments, coverage determinations, supplement preparation, communication
sending, carrier submission.
Must be added: (a) licensed-estimator review gate on estimator output;
(b) content-aware structural-work BLOCK in supplements/estimates;
(c) governance on claim-stage and supplement-outcome writes; (d) consent-before-
contact enforcement; (e) approval-to-send enforcement once a send path exists.
**The boundary engine is sound; the boundary surface is incomplete.**

## 7. Integration gaps (external systems preventing end-to-end completion)

1. **Xactimate** — no integration; estimator job ends at "review-ready data".
2. **Carrier portals** — no submission path; supplements end at
   AWAITING_EXTERNAL_EXECUTION.
3. **Email for workers** — no send path (Resend + IMAP/SMTP exist for pilot/mail
   only); worker communications stop at "drafted".
4. **Accounting/QuickBooks** — no ledger matching; Revenue Recovery cannot
   reconcile expected vs received.
5. **Calendars/PM tools** — no scheduling; Project Manager cannot book anything.
6. **SMS** — no customer contact channel.
7. **Weather/mapping/pricing data** — no corroboration or pricing inputs.
(Full analysis in `ATLAS_INTEGRATION_GAP_ANALYSIS.md`.)

## 8. Data-model gaps (structures that must eventually be added)

`workItems`, `workerHandoffs`, `estimateLineItems`, `supplementLineItems`,
`paymentRecords`, `recoveryEvents`, `policyDocuments`, `projects`+`milestones`,
`customerRecords`+`communicationLog`+`consent`, evidence-chain joins, unified
approval linkage, claim-stage transition table. Existing structures that need
upgrading: `insuranceClaims` (state machine), `claimSupplements` (line items +
response events), `governance_decisions` (handoff linkage). (Full analysis in
`ATLAS_DATA_MODEL_GAP_ANALYSIS.md`.)

## 9. Cross-worker gaps (broken handoffs)

All six handoffs (H1–H6) are PARTIAL or MISSING: no handoff record, no persisted
work item, no failure propagation, no round-trip closure. The single asset that
keeps the workforce coherent today is the shared governance trail. (Full analysis
in `ATLAS_CROSS_WORKER_HANDOFFS.md`.)

---

## 10. Implementation roadmap (P0 → P4, with dependencies)

### P0 — Safety / correctness (do first; prevents false claims, unsupported
conclusions, regulatory violations, unauthorized actions, evidence loss, incorrect
financial calculations)

| # | Work | Rationale | Depends on |
|---|---|---|---|
| P0.1 | Wire every new write path through the governance gate: claim-stage transitions, supplement outcome recording, estimator output | Unauthorized/ungoverned writes are the top safety gap | — |
| P0.2 | Add a claim state machine: persisted transition table (from/to, role, evidence, governance requirement); enforce in RPCs, not UI | Status is a free string today | P0.1 |
| P0.3 | Payment/recovery event ledger (append-only `paymentRecords` + `recoveryEvents`); migrate `paymentAmount` to a derived total | Financial correctness + auditability; foundation for reconciliation | — |
| P0.4 | Decision-gate the dormant automation: either connect agents/jobs through the governance gate or keep them unreachable and document the hazard | Dormant capable code is a governance risk | — |
| P0.5 | Replace the 4 heuristic deadline rules with verified knowledge records (or demote to non-actionable until verified) | Deadlines must never fire on unverified law | P0.4 (knowledge schema), knowledge acquisition phase |
| P0.6 | Content-aware boundaries: structural/engineering terms in supplements/estimates → BLOCK; consent-missing → no contact | Professional-boundary gaps | P0.1 |
| P0.7 | Evidence-chain enforcement: material outputs require evidence before they can be finalized | "Generated text ≠ evidence" | P0.3, data model |

### P1 — Core job completion (a worker finishes meaningful work)

| # | Work | Depends on |
|---|---|---|
| P1.1 | Persisted work items + worker handoffs (`workItems`, `workerHandoffs` tables + RPCs); replace ephemeral `buildWorkQueue` consumption | P0.2 |
| P1.2 | Estimate + line-item model (ingest original estimate as lines; per-line evidence/provenance/confidence/governance state); Estimator writes draft estimates | P0.7 |
| P1.3 | Supplement line-item construction on top of estimates (quantity/unit/pricing basis/evidence per item) | P1.2 |
| P1.4 | Revenue Recovery on the ledger: expected-vs-received matching, aging buckets, follow-up persistence | P0.3 |
| P1.5 | Communication send path (worker outbound email) gated on persisted approved decisions + delivery logging | P0.1, P0.7 |
| P1.6 | Project entity + milestone model (create from claim, schedule, track, detect overdue/at-risk/blocked) | P1.1 |
| P1.7 | Customer records + consent + communication log; CSM drafts link to them | P1.5 |

### P2 — Automation (reduce human involvement)

| # | Work | Depends on |
|---|---|---|
| P2.1 | Connect the job engine: enqueue claim analysis, evidence pipeline, agent runs through the jobs system with governance gates | P0.4 |
| P2.2 | Agent runtime (evidence/gap/supplement/QA) over persisted work items, human-review records persisted (use `atlas_human_reviews` or governance) | P2.1 |
| P2.3 | OCR engine wiring (Tesseract-class) for scanned PDFs/images with honest confidence | — |
| P2.4 | Daily scan / briefing automation on a schedule (cron sync pattern from `connections-run-due-syncs`) | P2.1 |
| P2.5 | Auto-drafted document requests + follow-ups from work items (draft only) | P1.1, P1.5 |

### P3 — Integrations (end-to-end execution)

| # | Work | Depends on |
|---|---|---|
| P3.1 | Email send for workers (Resend or mailbox), governance-gated | P1.5 |
| P3.2 | Xactimate-class estimating integration (licensed), human-review gated | P1.2 |
| P3.3 | QuickBooks/accounting sync (invoices, payments) | P0.3 |
| P3.4 | Carrier portal integrations (per carrier) | P1.3, P3.1 |
| P3.5 | Calendar integration (appointments, milestones) | P1.6 |
| P3.6 | SMS channel (with consent enforcement) | P1.7 |
| P3.7 | Weather/mapping data for claim corroboration and estimating inputs | P1.2 |

### P4 — Optimization

| # | Work | Depends on |
|---|---|---|
| P4.1 | AI runtime + model routing active in the reasoning path (with usage tracking and eval) | P2.2 |
| P4.2 | Knowledge acquisition pipeline (curated ingest UI, review workflow, refresh cadence) | P0.5 |
| P4.3 | Workflow engine consolidation (orchestrator inline pipeline → `workflowInstances`, retire uncalled definitions) | P2.1 |
| P4.4 | Unified approval view (consolidate workflow/governance/tool approvals) | P1.1 |
| P4.5 | Voice actions end-to-end (voice → governed action execution) | P2.1 |
| P4.6 | Load/capacity verification for jobs + workers | P2.1 |

## 11. Recommended next engineering phase (do not start yet)

**"The Governed Work Layer": P0.1–P0.2 + P1.1 — one phase, in this order:**

1. **P0.1/P0.2 — close the governance surface**: claim-stage state machine enforced
   in RPCs, governance on supplement-outcome writes, estimator output through the
   gate. This is the phase that makes every later automation safe — it converts the
   current "analysis is governed, writes are not" asymmetry into a system where
   **every material mutation leaves a persisted, auditable decision**.
2. **P1.1 — persist work items and handoffs**: `workItems` + `workerHandoffs`
   tables/RPCs (tenant-scoped, RLS, audit-logged), replacing the ephemeral queue,
   and surface them in the six worker pages. This is the phase that makes Atlas a
   **workforce** instead of six dashboards: for the first time, a claim will carry
   a durable "who owns the next action" fact with evidence and governance linkage.

Rationale: P0.1/P0.2 is the only correct prerequisite for everything else (P1
depends on governed state; P2 automation must be governed before it runs; P3
integrations must check persisted decisions before executing; P4 optimization is
meaningless on an ungoverned spine). P1.1 delivers the structural fact that every
worker, handoff, and future automation reads. Together they take the system from
"governed analysis + ungoverned writes + ephemeral work" to "governed writes +
durable work" — the smallest change set that makes the six-worker model real.

**Phase 21 rule respected: nothing in this roadmap has been implemented in this
phase.** The only repository changes produced by this phase are these audit and
blueprint documents.