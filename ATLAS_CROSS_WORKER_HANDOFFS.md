# ATLAS — CROSS-WORKER HANDOFFS

> **Purpose.** Map how the six workers interact as **one workforce**. Every handoff
> below is defined by: trigger, input, output, owner, evidence, governance, state,
> failure condition.
>
> **Current-state truth (from the capability audit):** no handoff records exist.
> Worker pages share one dataset; work items are recomputed per page load
> (`buildWorkQueue` in `src/lib/work-queue/service.ts` is deterministic and
> ephemeral); the only persistent cross-worker artifact is `governance_decisions`
> (claim_id + action_type + entity + approval state). Therefore every handoff row
> marks its status: **HAVE** (persisted today), **PARTIAL** (derivable but not
> persisted/linked), **MISSING** (no mechanism).

## Handoff map

```text
Claims Manager ──H1──▶ Supplement Specialist
Supplement Specialist ──H2──▶ Revenue Recovery Coordinator
Revenue Recovery Coordinator ──H3──▶ Project Manager
Project Manager ──H4──▶ Customer Success Manager
Customer Success ──H5──▶ Claims Manager (customer signals back to claim)
Estimator ◀──H6──▶ (called by CM/SS/PM wherever estimates are required)
Governance ──H0──▶ every worker (decisions + approvals)
```

## H0 — Governance decision → worker action

| Field | Definition |
|---|---|
| Trigger | Any material Atlas action (claim review, supplement prep, communication, financial calculation) |
| Input | ComplianceContext (action, claim, jurisdiction, temporal, financial amount) |
| Output | Persisted `governance_decisions` row + `governance_events` transition |
| Owner | Governance engine (`src/lib/governance/*`) |
| Evidence | Applicable rules/standards refs, evidence chain, evaluation trace |
| Governance | The handoff itself IS governance |
| State | ALLOW→not_executed; REVIEW_REQUIRED→awaiting_approval; BLOCK/UNKNOWN→blocked (override-only) |
| Failure | Gate exception → recorded UNKNOWN + `persisted:false` on the summary |
| Status | **HAVE** — the only fully-persisted handoff mechanism |

## H1 — Claims Manager → Supplement Specialist

| Field | Definition | Status |
|---|---|---|
| Trigger | A claim finding of type supplement_opportunity / missing_scope / potential_underpayment / overlooked_line_item / estimate_inconsistency / scope_inconsistency reaches confidence ≥ threshold | PARTIAL — findings persist; the "handoff" is a recomputed attention queue |
| Input | Claim snapshot + findings (with evidence arrays + estimatedAmount) | HAVE |
| Output | Supplement work package: draft narrative, structured supplement doc, line-item schedule (missing), evidence matrix (missing) | PARTIAL |
| Owner | Supplement Specialist (orchestrator `prepareSupplement`) | HAVE (capability), PARTIAL (wiring — prepareSupplement is reachable from UI flows, not from the queue) |
| Evidence | Finding evidence strings → source docs; per-line-item chain MISSING | PARTIAL |
| Governance | `supplement_preparation` REVIEW_REQUIRED — persisted decision on entity_type=supplement | HAVE |
| State | finding open → supplement draft → ready_for_submission | PARTIAL (states exist; transitions manual) |
| Failure | No evidence for a finding → must not draft amounts; currently flagged only | PARTIAL |

## H2 — Supplement Specialist → Revenue Recovery Coordinator

| Field | Definition | Status |
|---|---|---|
| Trigger | Supplement moves to submitted / response_received / approved / denied / partial | PARTIAL — status changes persist; no handoff record |
| Input | Supplement row (amount, approved/denied/outstanding, carrierResponse, submissionDate) | HAVE |
| Output | Recovery tracking item: expected payment, aging entry, follow-up, escalation trigger | PARTIAL (expected/payment/aging MISSING) |
| Owner | Revenue Recovery Coordinator | — |
| Evidence | Carrier response document + approved/denied amounts | PARTIAL (amounts; response doc not attached) |
| Governance | Supplement outcome recording should be REVIEW_REQUIRED (financial assertion) | MISSING — status writes are ungated |
| State | submitted → carrier_review → approved/denied/partial → payment_received → closed | HAVE (supplement statuses) |
| Failure | Outstanding amount > 0 with no follow-up scheduled; response overdue | PARTIAL — overdue detection; follow-ups in-memory |

## H3 — Revenue Recovery Coordinator → Project Manager

| Field | Definition | Status |
|---|---|---|
| Trigger | Supplement approved (funding confirmed) → work can proceed; or claim at billing/reconciling → closeout work | PARTIAL — approval is a status; no project linkage |
| Input | Approved supplement amounts + claim | PARTIAL |
| Output | Funded project with schedule + milestones; closeout checklist | MISSING (no project entity) |
| Owner | Project Manager | — |
| Evidence | Approval decision + supplement record | PARTIAL (decision persisted; not linked to a project) |
| Governance | project_scheduling ALLOW; contract_execution BLOCK | Matrix only — nothing wired |
| State | claim status → work_completed → billing → reconciling → closed | PARTIAL (statuses exist, ungoverned) |
| Failure | Funded scope with no scheduled work; claim stuck in billing with no reconciliation | PARTIAL — staleness flags only |

## H4 — Project Manager → Customer Success Manager

| Field | Definition | Status |
|---|---|---|
| Trigger | Milestone reached / schedule change / inspection pending / completion / complaint | MISSING (no milestones) |
| Input | Project progress events, schedule deltas | MISSING |
| Output | Approved customer communication (status update, appointment, completion notice) | PARTIAL — draft types exist; no trigger linkage |
| Owner | Customer Success Manager | — |
| Evidence | Work logs/photos, milestone records | MISSING |
| Governance | communication_sending REVIEW_REQUIRED | HAVE (gate); no send path |
| State | communicated / awaiting approval / sent | PARTIAL — "drafted" only |
| Failure | Customer-impacting change with no approved communication; complaint with no escalation | MISSING |

## H5 — Customer Success Manager → Claims Manager

| Field | Definition | Status |
|---|---|---|
| Trigger | Customer provides new information (documents, loss details), reports a new issue, or disputes something | MISSING — no customer communication intake |
| Input | Customer contact content | MISSING |
| Output | Claim update request (new evidence, new finding, claim correction) | PARTIAL — attach-evidence + update-claim exist as manual actions |
| Owner | Claims Manager | — |
| Evidence | The customer's original message (retained) | MISSING |
| Governance | Evidence attachment is editor-gated + audited (`claim_evidence_attached` audit event) | PARTIAL |
| State | contact logged → claim updated → verified | MISSING |
| Failure | Customer-reported fact enters the claim without source retention | MISSING — must be prevented |

## H6 — Estimator ⇄ all workers

| Field | Definition | Status |
|---|---|---|
| Trigger | CM needs scope validation; SS needs line-item support; PM needs work scope for scheduling | PARTIAL — estimator page exists; no calls from other workers |
| Input | Claim + scope + evidence (+ future photos/measurements) | PARTIAL |
| Output | Review-ready line items with statuses/confidence/evidence | PARTIAL — in-memory only, not persisted |
| Owner | Estimator | — |
| Evidence | Per-line evidence arrays (string); source-doc chain MISSING | PARTIAL |
| Governance | estimate_calculation ALLOW; engineering BLOCK; estimate_review REVIEW_REQUIRED (not wired) | PARTIAL |
| State | identified → supported → reviewed → finalized | PARTIAL — statuses exist; no persistence/finalization |
| Failure | Line item without evidence/pricing must never be treated as final | PARTIAL — humanNote flags; no hard gate |

## Cross-worker requirements (what "one workforce" needs that doesn't exist)

1. **A persisted handoff record** — table `workerHandoffs` (from_worker, to_worker,
   trigger, input_refs, output_refs, owner, evidence_refs, governance_decision_id,
   state, created/updated/due, failure_code). Without it, the six pages remain six
   views of one database. (Data-model gap — see `ATLAS_DATA_MODEL_GAP_ANALYSIS.md`.)
2. **A persisted work item** — the work queue must survive page loads so
   "Claims Manager identified X → Supplement Specialist owns X" is a fact, not a
   recomputation. (`buildWorkQueue` output is currently ephemeral.)
3. **Handoff-aware governance** — decisions should reference the handoff that
   produced them (entity_type + entity_id already exist; add handoff_id).
4. **Failure propagation** — a blocked/UNKNOWN decision must appear as a work item
   owned by the handoff's target worker (currently only visible on the Governance
   page and per-worker governance lists).
5. **Round-trip closure** — every handoff must close: H1 closes when the supplement
   is created; H2 when payment reconciles; H3 when the project closes; H4 when the
   communication is sent+logged; H5 when the claim record is updated; H6 when the
   estimate is finalized. None of these closures exist.

## What already behaves as one workforce (credit where due)

- **One dataset**: all six workers read the same claims/findings/supplements/
  governance RPCs (`useWorkerData` — one data load, six contexts).
- **One governance trail**: every orchestrator action on a claim is persisted with
  the same claim_id, so a claim's governance history is worker-agnostic and
  reconstructable.
- **One attention model**: `buildWorkQueue` categories map cleanly onto worker
  attention lists (`attentionCategories` in `worker-defs.ts`), so the queue already
  knows *which* worker a work item belongs to — it just doesn't persist it.