# ATLAS — JOB COMPLETION BLUEPRINT

> **Purpose.** Define, for each of the six digital employees, the operational
> contract: what information the worker requires, what it must know, reason about,
> calculate, decide, produce, and execute — and exactly what "job complete" means.
> This blueprint is the target. The current-state truth is in
> `ATLAS_DIGITAL_EMPLOYEE_CAPABILITY_AUDIT.md`; every requirement below is tagged
> with the repository evidence of where Atlas stands today.

**Current-state shorthand used throughout:**
- **HAVE** — capability exists, connected, and (where relevant) persisted.
- **PARTIAL** — exists but incomplete/disconnected (details in the audit).
- **MISSING** — no implementation in the repository.
- **BLOCK** / **REVIEW_REQUIRED** — governance boundary already enforced by
  `src/lib/governance/role-boundary.ts`.

---

# PHASE 2 — THE SIX DIGITAL EMPLOYEES (OPERATIONAL CONTRACTS)

## 2.1 Claims Manager

| Contract item | Requirement | Current state |
|---|---|---|
| **Inputs** | Claim number, customer/insured, property, carrier, policy, adjuster, date of loss, cause of loss, loss description, estimate, invoices, photos, inspection reports, correspondence, contracts, payment records, deadlines, jurisdiction (from property), historical activity | **PARTIAL** — claim fields + evidence docs exist (`insuranceClaims`, `documents`); no policy documents table, no inspection reports table, no correspondence table |
| **Knowledge** | Claim lifecycle stages, what makes a claim "complete", evidence expectations per stage, deadline law (SOL/policy period), carrier practices, documentation standards | **PARTIAL** — 16-status lifecycle (`CLAIM_STATUSES`), 31-stage corpus workflow, evidence-requirements engine; SOL rules only TX/FL/CA/NY + Default (`deadline-tracker.ts`); jurisdiction corpus is placeholder |
| **Reasoning** | Is the claim reconstructable? What is missing/conflicting/stale? Is the evidence sufficient to support the recorded facts? Which deadlines are at risk? What is the next required action? | **HAVE (deterministic)** — `analyzeClaimCompleteness`, `buildClaimFindings`, `reconcileClaim`, `trackDeadlines`, `buildWorkQueue` |
| **Calculations** | Completeness score, outstanding balance, days-until-deadline, recovery potential | **HAVE** — all derived deterministically |
| **Decisions** | Which claims need attention; what evidence to request; what to escalate; whether a claim is ready to move stages | **PARTIAL** — attention/work-queue derivation exists; claim stage transitions are **not** decision-gated (status is a free string via `insurance_update_claim`) |
| **Outputs** | Claim record, completeness report, findings, timeline, package, work items, document requests, deadline alerts, claim review summary | **HAVE** — all generated; review outputs not persisted except findings |
| **Actions** | Create/update claim, attach evidence, run analysis, request documents (draft), create follow-ups, advance claim stage, close claim | **PARTIAL** — create/update/attach/analyze/follow-up exist; document requests are drafts; stage advancement is ungoverned manual update |
| **Approvals** | Coverage determinations → licensed professional (REVIEW_REQUIRED); stage moves that change financial exposure → human; claim closure → human sign-off | **PARTIAL** — coverage_determination already gated; claim-stage and closure approvals **not wired** |
| **External systems** | Policy system (carrier portal), claim portal, email, document storage, calendar | **MISSING** |
| **Evidence** | Every recorded claim fact must trace to a source document or verified entry; conflicts surfaced, never silently resolved | **PARTIAL** — provenance field + `evidenceDocumentIds` + conflict statuses; per-fact citation chain not stored |
| **Governance** | claim_analysis ALLOW; coverage_determination REVIEW_REQUIRED (licensed adjuster); legal_conclusion BLOCK | **HAVE** — enforced + persisted |
| **Failure conditions** | Missing claim number/customer/property with no source; unresolvable conflicts; unknown jurisdiction for deadline-critical actions; evidence insufficient to establish date of loss | **PARTIAL** — flagged as gaps/attention; no hard stop except governance |

## 2.2 Supplement Specialist

| Contract item | Requirement | Current state |
|---|---|---|
| **Inputs** | Original estimate (+ line items), observed/documented scope, photos, invoices, signed work orders, carrier correspondence, policy language, depreciation/deductible context, jurisdiction rules | **MISSING** — estimate is a total amount + scope name arrays; no estimate line-item ingestion; photos are evidence docs without extraction |
| **Knowledge** | What is supplementable; estimating conventions; documentation standards; carrier-specific procedures; code requirements | **PARTIAL** — recovery-concept corpus + findings logic; no pricing/estimating standard corpus |
| **Reasoning** | Is there a defensible supplement opportunity? Which line items are missing/omitted/unsupported? What evidence supports each? What is the dollar value per item? Is the package complete? | **PARTIAL** — opportunity detection exists (9 finding categories); **no line-item reasoning** |
| **Calculations** | Per-line-item quantity × price, waste/access factors, total requested, expected recovery | **MISSING** (line-item level); totals derived only where evidence supports |
| **Decisions** | Which opportunities proceed to draft; which are dropped; package completeness sign-off | **PARTIAL** — opportunities become human tasks; no decision criteria for dropping |
| **Outputs** | Supplement narrative, itemized schedule of values, evidence matrix, package HTML/PDF, carrier cover letter | **PARTIAL** — narrative + structured document + package HTML exist; no itemized schedule of values |
| **Actions** | Create supplement draft, attach evidence, move draft→ready→submitted, record carrier response, revise, resubmit | **PARTIAL** — create + status transitions exist; submission is human-only; response recording is manual free-text + amounts |
| **Approvals** | Every supplement before submission (REVIEW_REQUIRED); licensed review when state law requires (e.g., where work requires licensed contractor sign-off); escalation on denial | **HAVE** (preparation gate); submission-path approval **not executable** (no submission exists) |
| **External systems** | Xactimate/estimating platform, carrier portal, email, document storage | **MISSING** |
| **Evidence** | Every proposed addition: photo/document → extracted fact → source doc → reasoning → applicable rule/standard → confidence → governance decision | **PARTIAL** — evidence is a string array; no structured chain per line item |
| **Governance** | supplement_preparation REVIEW_REQUIRED; carrier_submission REVIEW_REQUIRED; coverage/legal BLOCK | **HAVE** (preparation); submission gate exists but no submission path |
| **Failure conditions** | No supporting evidence for a line item; scope documented but unpriced with no source; carrier response ambiguous; estimate missing → stop before drafting amounts | **PARTIAL** — flagged; no hard stop before drafting |

## 2.3 Revenue Recovery Coordinator

| Contract item | Requirement | Current state |
|---|---|---|
| **Inputs** | Supplements, carrier responses, payment advices, EOBs, invoices, ledger, claim statuses, aging dates | **PARTIAL** — supplements + statuses + payment total; no payment advices/EOBs, no payment history |
| **Knowledge** | Payment reconciliation practice, carrier payment timing, collections, documentation for disputes | **PARTIAL** — revenue concepts corpus (16); no collections corpus |
| **Reasoning** | Expected vs received; what is outstanding per claim; what is aging; what needs follow-up; what needs escalation | **PARTIAL** — outstanding/potential/follow-up detection exists; no aging, no expected-vs-received matching |
| **Calculations** | Requested/approved/denied/paid/outstanding aggregates; aging buckets; recovery potential | **PARTIAL** — aggregates exist; aging missing |
| **Decisions** | When to follow up, when to escalate, when to mark a claim reconciled | **PARTIAL** — follow-up scheduling derived; escalation is a draft type, not a decision flow |
| **Outputs** | Recovery dashboard, aging report, follow-up list, escalation memo, reconciliation report, carrier breakdown | **PARTIAL** — dashboard + analytics + carrier breakdown exist; aging/escalation/reconciliation reports missing |
| **Actions** | Record payment, update supplement outcome, schedule follow-up, escalate, reconcile | **PARTIAL** — record payment/update status exist; follow-ups in-memory; escalation not executable |
| **Approvals** | Escalation to carrier dispute; write-offs; settlement acceptance | **MISSING** |
| **External systems** | Accounting/QuickBooks, bank feeds, carrier payment portal, CRM | **MISSING** |
| **Evidence** | Payment → payment advice → ledger → reconciliation note; aging must be timestamp-backed | **MISSING** (no payment event table) |
| **Governance** | financial_calculation ALLOW (gated); financial_commitment PROHIBITED | **HAVE** |
| **Failure conditions** | Cannot match a payment to any claim; supplement outstanding with no follow-up date; carrier response overdue with no action | **PARTIAL** — overdue detection exists; unmatched payments impossible to detect (no payment records) |

## 2.4 Project Manager

| Contract item | Requirement | Current state |
|---|---|---|
| **Inputs** | Projects (claims), milestones, scheduled work, crews/subcontractors, permits, inspections, materials, customer appointments, carrier inspection dates, dependencies | **MISSING** — claims only; no projects/milestones/schedules/crews/permit data |
| **Knowledge** | Restoration project sequencing, permit/inspection requirements, scheduling practice | **PARTIAL** — 31-stage workflow corpus; no scheduling knowledge |
| **Reasoning** | Is the project on schedule? What is at risk/blocked/waiting? What dependency is missing? Which communication is stalled? | **PARTIAL** — deadline + staleness + work-queue detection exist; no dependency/blocker model |
| **Calculations** | Days-until-due, overdue days, milestone progress | **PARTIAL** — days-until-due exists |
| **Decisions** | Reassign/repush schedules, flag at-risk projects, request permits/inspections | **MISSING** |
| **Outputs** | Project list, milestone plan, risk register, next-action list, daily briefing | **PARTIAL** — next-action list + daily briefing exist; project/milestone plans missing |
| **Actions** | Create project, assign work, schedule milestones, update progress, coordinate inspections | **MISSING** |
| **Approvals** | Change orders; schedule changes with customer impact; vendor commitments | **MISSING** |
| **External systems** | Calendar, PM tool, field apps, permits portals, weather data | **MISSING** |
| **Evidence** | Milestone progress → work logs/photos; delays → communication records | **MISSING** |
| **Governance** | project_scheduling ALLOW; contract_execution BLOCK | **HAVE** (matrix); no PM actions wired through it |
| **Failure conditions** | No next action determinable; project overdue with no communication; blocked by missing permit/inspection | **PARTIAL** — staleness/deadline flags exist; no hard stop |

## 2.5 Estimator / Estimating Specialist

| Contract item | Requirement | Current state |
|---|---|---|
| **Inputs** | Scope notes, photos, measurements, inspection findings, original estimate, damage evidence, property characteristics (age, construction, roof type), building code context | **MISSING** — claim damage type + description + scope arrays only; no photos/measurements input |
| **Knowledge** | Estimating methodology, pricing, line-item conventions, measurement standards, code requirements | **PARTIAL** — estimating concepts in corpus; **no pricing source** |
| **Reasoning** | Which components are damaged? What quantities? What work applies? What is missing/inconsistent vs the existing estimate? | **PARTIAL** — deterministic damage-type inference (`extractKnownScope`/`extractMissingScope` in `estimator.ts`); no component recognition from photos/measurements |
| **Calculations** | Quantities, labor/material/equipment, waste/access factors, totals | **PARTIAL** — quantity × unitPrice scaffolding; prices default 0 → human verification (`humanNote`) |
| **Decisions** | Which line items are supported/identified/unsupported/disputed; when human review is mandatory | **PARTIAL** — statuses exist; unsupported items flagged; no enforcement that reviewed items proceed |
| **Outputs** | Itemized estimate review package with per-line evidence, assumptions, confidence, gaps, governance state | **PARTIAL** — line items with evidence arrays + summary exist; per-line governance/assumption/provenance fields missing |
| **Actions** | Build estimate draft, compare against existing estimate, flag discrepancies | **PARTIAL** — generates line items in memory; nothing persisted; no estimate comparison against a stored original (no estimate table) |
| **Approvals** | Licensed/certified estimator review of quantities/pricing; engineering review for structural items (BLOCK for Atlas) | **PARTIAL** — disclaimer + humanNote exist; `estimate_review` gate not wired to estimator output |
| **External systems** | Xactimate (or compatible estimating platform), pricing databases, blueprint/measurement tools | **MISSING** — explicitly not integrated; UI disclaims Xactimate input |
| **Evidence** | Every line item: photo/document → extracted fact → source doc → reasoning → rule/standard → confidence → governance decision | **PARTIAL** — evidence string arrays; no structured chain |
| **Governance** | estimate_calculation ALLOW; engineering_determination BLOCK; professional estimate review REVIEW_REQUIRED | **HAVE** (matrix) — **estimator output is not run through the gate today** |
| **Failure conditions** | No evidence for a quantity; measurements missing; pricing unknown; structural determination needed → escalate to licensed engineer | **PARTIAL** — flagged as human actions; no hard stop |

## 2.6 Customer Success Manager

| Contract item | Requirement | Current state |
|---|---|---|
| **Inputs** | Customer profile, claim progress events, communication history, appointments, complaints, expectations, satisfaction signals | **MISSING** — customer is a claim text field; no profile/history/appointments |
| **Knowledge** | Communication standards, privacy/consent, escalation practice, claim progress reporting norms | **PARTIAL** — drafting templates; no privacy/consent corpus |
| **Reasoning** | Who needs an update? What is overdue? What should be communicated (and what must not)? | **PARTIAL** — overdue/follow-up detection; no per-customer reasoning |
| **Calculations** | Days since last contact, appointment countdowns | **PARTIAL** — days-since-update derived from claim freshness |
| **Decisions** | Which customers get which update; when to escalate a complaint | **PARTIAL** — draft selection; escalation not a flow |
| **Outputs** | Status updates, document requests, appointment confirmations, complaint responses, completion comms | **PARTIAL** — customer_status_update + document_request drafts exist; rest missing |
| **Actions** | Draft, get approval, send, schedule appointment, log contact | **PARTIAL** — draft only; no send/appointment/contact-log |
| **Approvals** | Every external customer communication (REVIEW_REQUIRED); complaint/escalation messages reviewed by manager | **HAVE** (gate) — communication_sending REVIEW_REQUIRED |
| **External systems** | Email, SMS, CRM, calendar, phone | **MISSING** (for workers; pilot CRM + mail exist separately) |
| **Evidence** | Every sent message → approved draft → governance decision → delivery receipt | **MISSING** (no send path, no delivery records) |
| **Governance** | communication_drafting ALLOW; communication_sending REVIEW_REQUIRED; customer_notification tracked | **HAVE** (drafting gate + persistence) |
| **Failure conditions** | No approved message for an overdue update; complaint without escalation path; missing consent → do not contact | **PARTIAL** — overdue surfaced; consent not modeled |

---

# PHASE 3 — THE COMPLETE JOB (END-TO-END WORKFLOWS)

The canonical lifecycle below is applied per worker with only the stages that worker
owns. **Atlas must be able to say, at every stage, which stage it is in, why, and
what evidence supports it.**

## Claims Manager workflow

```text
INPUT (claim fields, evidence docs, candidates, prior records)
 ↓
INGEST (archive → documents → chunks → entities → candidates)        [HAVE]
 ↓
UNDERSTAND (classification, extraction, enrichment)                  [HAVE]
 ↓
CLASSIFY (claim vs non-claim, candidate creation)                    [HAVE — human approve required]
 ↓
RECONSTRUCT (claim record + timeline from heterogeneous evidence)    [PARTIAL — no autonomous merge]
 ↓
REASON (completeness, findings, conflicts, staleness)                [HAVE]
 ↓
CHECK EVIDENCE (per-fact source chain)                               [PARTIAL — category-level only]
 ↓
CHECK KNOWLEDGE (jurisdiction, lifecycle stage expectations)         [PARTIAL — placeholder corpus]
 ↓
CHECK GOVERNANCE (claim_analysis ALLOW; coverage → licensed)         [HAVE]
 ↓
DECIDE (attention ranking, next actions, stage proposal)             [PARTIAL — ranking only]
 ↓
GENERATE OUTPUT (review, package, timeline, work items)              [HAVE]
 ↓
HUMAN REVIEW IF REQUIRED (stage moves, coverage, closure)            [PARTIAL — not wired to stage moves]
 ↓
EXECUTE ACTION (attach evidence, create task, request docs)          [PARTIAL]
 ↓
VERIFY OUTCOME (record updated, conflicts resolved?)                 [MISSING — no verification loop]
 ↓
UPDATE RECORD (persist analysis results)                             [PARTIAL — findings only]
 ↓
NEXT ACTION (work item or handoff)                                   [HAVE — queue]
```

## Supplement Specialist workflow

```text
INPUT (claim, estimate data, evidence docs, findings)                [PARTIAL]
 ↓
INGEST original estimate + line items                                [MISSING — no line-item ingestion]
 ↓
UNDERSTAND (scope documented vs performed vs estimated)              [PARTIAL]
 ↓
CLASSIFY (supplement opportunity vs not; per line item)              [PARTIAL — finding level, not line-item]
 ↓
RECONSTRUCT (observed scope from photos/docs)                        [MISSING]
 ↓
REASON (per-line-item: quantity, unit, labor, material, waste, access, complexity, code) [MISSING]
 ↓
CHECK EVIDENCE (photo/doc per proposed item)                         [PARTIAL]
 ↓
CHECK KNOWLEDGE (estimating rules, carrier procedures, jurisdiction) [PARTIAL]
 ↓
CHECK GOVERNANCE (supplement_preparation → REVIEW_REQUIRED)          [HAVE]
 ↓
DECIDE (include/exclude items, amounts)                              [MISSING — human decides]
 ↓
GENERATE OUTPUT (narrative + schedule of values + evidence matrix)   [PARTIAL]
 ↓
HUMAN REVIEW (approve package)                                       [HAVE — approval state machine]
 ↓
EXECUTE ACTION (submit to carrier)                                   [MISSING — human only]
 ↓
VERIFY OUTCOME (submission acknowledged, response tracked)           [PARTIAL — manual status]
 ↓
UPDATE RECORD (supplement + response persisted)                      [HAVE]
 ↓
NEXT ACTION (recovery tracking or revision)                          [PARTIAL]
```

## Revenue Recovery workflow

```text
SUPPLEMENT (approved/denied/partial)          [HAVE]
 ↓
AMOUNT REQUESTED (persisted)                  [HAVE]
 ↓
CARRIER RESPONSE (recorded)                   [PARTIAL — free-text + amounts]
 ↓
APPROVED / DENIED / PARTIAL                   [HAVE — statuses]
 ↓
FOLLOW-UP (scheduled)                         [PARTIAL — in-memory]
 ↓
ESCALATION (dispute)                          [MISSING]
 ↓
PAYMENT (received)                            [PARTIAL — running total only]
 ↓
RECONCILIATION (expected vs received)         [MISSING — no expected/received ledger]
 ↓
OUTSTANDING BALANCE (per claim, aging)        [PARTIAL — aggregate only, no aging]
 ↓
REPORT (aging, carrier, status)               [PARTIAL]
 ↓
COMPLETED (zero balance, evidence-closed)     [MISSING — no completion definition enforced]
```

## Project Manager workflow

```text
ASSIGNMENT (project created from claim)       [MISSING]
 ↓
SCHEDULING (milestones, dates, crews)         [MISSING]
 ↓
DEPENDENCIES (permits, inspections, materials)[MISSING]
 ↓
DEADLINES (tracked)                           [HAVE]
 ↓
EXECUTION MONITORING (progress vs plan)       [PARTIAL — status/staleness only]
 ↓
DETECT (overdue / at-risk / blocked / waiting / missing dependency / stalled comms) [PARTIAL — overdue/stale/queue]
 ↓
COORDINATE (customer, contractor, carrier)    [MISSING]
 ↓
INSPECTION (scheduled + documented)           [MISSING]
 ↓
WORK COMPLETION (documented)                  [PARTIAL — claim status only]
 ↓
DOCUMENTATION (closeout package)              [MISSING]
 ↓
INVOICING                                    [PARTIAL — invoice amounts on claim]
 ↓
CLAIM CLOSEOUT                               [MISSING — no closeout flow]
```

## Estimator workflow

```text
INPUT (scope, photos, measurements, findings) [MISSING — claim fields only]
 ↓
ANALYZE (components, quantities, applicable work)  [PARTIAL — damage-type rules]
 ↓
IDENTIFY (missing scope, inconsistencies)     [PARTIAL]
 ↓
CONSTRUCT ESTIMATE (line items, units, labor, material, waste, access) [PARTIAL — scaffolding]
 ↓
VALIDATE (evidence, assumptions, provenance, confidence, gaps, governance) [PARTIAL]
 ↓
HUMAN REVIEW (licensed/certified)             [PARTIAL — flags, not gates]
 ↓
EXECUTE (enter into Xactimate / submit)       [MISSING — human only, disclaimed]
 ↓
VERIFY (pricing confirmed, quantities verified) [MISSING]
```

## Customer Success workflow

```text
ONBOARD (customer profile, consent)           [MISSING]
 ↓
TRACK (claim progress events)                 [PARTIAL — claim status]
 ↓
DETECT (update needed, overdue, milestone)    [PARTIAL]
 ↓
DRAFT (status update / doc request / appointment) [PARTIAL — 2 of 8 draft types used]
 ↓
GOVERNANCE (approval)                         [HAVE]
 ↓
SEND                                        [MISSING]
 ↓
LOG (contact history)                         [MISSING]
 ↓
FOLLOW-UP (reply tracking)                    [MISSING]
 ↓
COMPLAINT/ESCALATION                          [MISSING]
 ↓
COMPLETION COMMUNICATION + FEEDBACK           [MISSING]
```

---

# PHASE 4 — CLAIMS MANAGER REQUIREMENTS (detail)

### Claim intake
- **Create claim:** HAVE — `insurance_create_claim` (requires ≥1 of customer/property/claim number; editor+ role; audit-logged).
- **Identify customer / property / carrier / policy / claim number / adjuster:** PARTIAL — candidate extraction (`reconstruct.ts`) covers claim number/customer/property; carrier/policy/adjuster are not extracted from evidence automatically.
- **Establish dates / loss type / coverage context:** PARTIAL — dateOfLoss is a field + completeness rule; causeOfLoss exists; **coverage context (policy terms, limits, deductible applicability) is not modeled** — `policyLimits`/`deductible` are raw numbers with no policy document link.

### Claim reconstruction
Atlas must rebuild the claim from heterogeneous evidence. Requirements vs current state:

| Element | Requirement | Current |
|---|---|---|
| Chronology | Timeline from all dated records, atlas-vs-source labeled | ✅ `buildClaimTimeline` |
| Parties | Insured, property, carrier, adjuster, contractors, witnesses resolved to entities | 🟡 entities graph exists; no party resolution on claims |
| Events | Loss, notices, inspections, submissions, responses, payments | 🟡 derived from claim/supplement/finding records |
| Communications | Sent/received correspondence per claim | ❌ not stored |
| Documents | Evidence docs linked to claim with classification | ✅ `evidenceDocumentIds` + categories |
| Estimates | Original estimate retained with line items | ❌ total + scope names only |
| Payments | Payment history, not just running total | ❌ running total only |
| Decisions | Governance decisions linked to the claim | ✅ `governance_decisions.claim_id` |
| Outstanding issues | Open findings + open governance + work items | 🟡 findings + governance; work items ephemeral |

### Claim completeness
- Missing documents/facts: ✅ `analyzeClaimCompleteness` (11 categories) + `evidenceDocumentIds`.
- Conflicting information: ✅ `conflicted` status + `buildClaimPackage` conflicting state + contradictions module.
- Stale information: ✅ 30-day freshness rule.
- Missing approvals: 🟡 via governance `requiredApprovals` per decision; not per claim.
- Missing estimates: ✅ completeness `estimate` category.
- Missing correspondence: ❌ no correspondence model.

### Claim strategy (what the Claims Manager must reason about)
- Claim status: 🟡 derived pipeline position (`pipelineIndexFor`).
- Coverage issues: ❌ no policy comparison — only a REVIEW_REQUIRED boundary.
- Evidence strength: 🟡 confidence + provenance + completeness score.
- Carrier position: ❌ not modeled (response is free text on supplements).
- Outstanding requests: 🟡 work items + document-request drafts.
- Deadlines: ✅ `trackDeadlines`.
- Escalation: 🟡 draft type + governance ALLOW for escalation; no flow.

### Claim lifecycle (state machine requirements)
The current 16-status enum (`CLAIM_STATUSES`) is a good spine but is **not enforced**:

```text
lead → opened → documenting → estimating → carrier_review →
supplement_identified → supplement_prepared → ready_for_submission → submitted →
response_received → negotiating → approved → work_completed → billing →
reconciling → closed
```

Required additions: a persisted transition table with allowed-from/to pairs, role
requirements per transition, evidence requirements per transition, and automatic
derivation (e.g., "response_received" should be derivable from supplement status;
"reconciling" should require a reconciliation report). None of this exists — status
is a free string updated via `insurance_update_claim`.

### Outputs (finished Claims Manager work product)
1. Reconstructed claim record (identifiers + parties + dates + coverage context).
2. Completeness report (11 categories, states, score).
3. Findings set (persisted, evidence-linked).
4. Claim package (verified/derived/inferred/missing/conflicting fields).
5. Timeline (atlas vs source labeled).
6. Deadline register.
7. Work queue with next actions.
8. Governance record for the review decision.
9. **Document request drafts** (approved before sending).

---

# PHASE 5 — SUPPLEMENT SPECIALIST REQUIREMENTS (detail)

### Trigger detection
- **HAVE:** findings of type `supplement_opportunity`, `missing_scope`,
  `potential_underpayment`, `overlooked_line_item`, `scope_inconsistency`,
  `estimate_inconsistency`, `billing_reconciliation`, `unresolved_carrier_response`,
  `workflow_delay`, `documentation_gap` → Supplement Specialist attention queue.
- **MISSING:** original-estimate line-item comparison (the estimate is a number, not
  lines), policy-based triggers (e.g., code-upgrade provisions), and
  carrier-specific triggers.

### Evidence discovery
- **HAVE:** claim evidence categories, evidence doc linking, contradiction detection.
- **MISSING:** per-line-item evidence matching (which photo proves which line item),
  photo/measurement analysis, weather/date corroboration.

### Scope comparison
```text
original estimate   🟡 (total + scope names)
vs observed conditions 🟡 (actualScope, loss description)
vs documentation   🟡 (evidence categories + extracted scope)
vs estimating rules  ❌ (no pricing/estimating corpus)
vs carrier position  🟡 (free-text response)
```

### Line-item reasoning (per item: quantity, unit, labor, material, waste, access,
complexity, code, missing scope, omitted scope, unsupported scope)
**MISSING in whole.** The closest is `extractFromFindings` + `extractMissingScope`
in the estimator engine, which are damage-type heuristics, not line-item reasoning.
This is the single largest Supplement Specialist gap.

### Documentation
- **HAVE:** supplement document builder lists "supporting evidence" and flags when
  empty; evidence strings.
- **MISSING:** a required-evidence checklist per line item and a completeness gate
  that blocks drafting an amount without its evidence.

### Supplement package (required outputs)
1. Cover letter / narrative — 🟡 `supplement_narrative` draft.
2. Itemized schedule of values — ❌.
3. Evidence matrix (item → document → page → extracted fact) — ❌.
4. Original vs revised scope comparison — 🟡 sections in `buildSupplementDocument`.
5. Photos/measurements attachment manifest — ❌.
6. Governance/approval record — ✅ (persisted decision).
7. Submission-ready package (PDF) — 🟡 HTML exists; no PDF; no submission.

### Governance
- Preparation: REVIEW_REQUIRED — ✅ enforced + persisted.
- Licensed review: required when the supplement asserts quantities/pricing/scope
  that state law requires a licensed contractor/estimator to certify — **not yet
  modeled** as a gate condition.
- Engineering/structural items: BLOCK for Atlas — ✅ matrix exists; ❌ not enforced
  on supplement content.

### External execution (what Atlas may prepare vs execute)
| Step | Atlas today |
|---|---|
| Prepare narrative + package | ✅ |
| Compute amounts | 🟡 where evidence supports |
| Approve | Human (governance) |
| Submit to Xactimate | ❌ human, disclaimed |
| Submit to carrier portal | ❌ human |
| Email package | ❌ human |
| Track response | 🟡 manual status entry |

---

# PHASE 6 — REVENUE RECOVERY COORDINATOR (detail)

Lifecycle (already in Phase 3). Requirements:

- **Financial reconciliation:** 🟡 `reconcileClaim` — estimate/approved baseline
  minus paid; invoice-vs-paid notes. Cannot match individual payments.
- **Expected vs received:** ❌ requires a payment ledger (`payment events` table)
  plus per-supplement expected amounts.
- **Carrier responses:** 🟡 status + `carrierResponse` + approved/denied/outstanding
  amounts; no response documents, no timeline of responses.
- **Payment matching:** ❌.
- **Outstanding amounts:** ✅ aggregates (`insurance_claim_counts`), carrier
  breakdown (`buildCarrierBreakdown`).
- **Aging:** ❌ — no buckets (0–30/31–60/61–90/90+) because no event dates beyond
  supplement status.
- **Follow-ups:** 🟡 `scheduleFollowUps` (in-memory); not persisted, no cadence
  config.
- **Escalation:** ❌ flow (draft type only).
- **Documentation:** 🟡 claim package + supplement docs; no dispute packets.
- **Reporting:** 🟡 dashboard + trend + carrier + status distribution.

**"Completed" for Revenue Recovery:** claim has zero outstanding balance **as
matched against payment evidence** (not estimate math), all supplements in a
terminal state, reconciliation report generated, and a persisted governance note
closing the recovery cycle. Current state cannot reach this — the model cannot
prove zero (no payment history) and has no closure record.

---

# PHASE 7 — PROJECT MANAGER (detail)

Project lifecycle + state machine (target):

```text
created → scheduled → ready → in_progress → inspection_pending → work_complete →
documented → invoiced → reconciled → closed
```

Atlas must detect:
| Signal | Requirement | Current |
|---|---|---|
| Overdue | milestone due date passed | 🟡 deadline tracker (claims only) |
| At-risk | approaching deadlines, no progress | 🟡 staleness |
| Blocked | waiting on permit/inspection/materials | ❌ |
| Waiting | external dependency open | ❌ |
| Missing dependency | milestone without prerequisite | ❌ |
| Stalled communication | no customer/carrier contact | 🟡 freshness |

**Current state:** the "Project Manager" worker is a claims-deadline dashboard.
There is no project entity, no schedule, no dependency graph, no assignment, no
inspection, no closeout. This worker requires a data-model addition before any
job-completion logic can exist.

---

# PHASE 8 — ESTIMATOR (capability boundary — high risk)

**What Atlas can legally/operationally do today:**
- Analyze documented scope and identify candidate line items from claim data
  (`generateEstimateLineItems`) — deterministic, evidence-labeled, disclaimed.
- Flag quantities/pricing that require verification (`humanNote`,
  `requiredHumanAction`).
- Prepare a review package for a human estimator.

**What Atlas must NOT do (and currently doesn't):**
- Produce binding quantities or pricing without licensed estimator review.
- Imply Xactimate capability — **explicitly disclaimed**; no Xactimate integration
  exists and none may be claimed.
- Make structural/engineering determinations — BLOCK in the role matrix.
- Compute recoverable amounts from unverified photos/measurements (no such input
  exists today, and none may be fabricated).

**Per-line-item validation requirements** (target schema for `EstimateLineItem`):
evidence, assumptions, provenance, confidence, unresolved gaps, governance state.
Current: evidence (string[]), confidence, status, humanNote. Missing: assumptions,
provenance, unresolved gaps, governance state, per-item source document link.

**Required human review:** quantities (measurements), pricing (rates), code
applicability, structural scope, final estimate signature. Atlas may prepare all of
these but must not finalize any.

---

# PHASE 9 — CUSTOMER SUCCESS MANAGER (detail)

Communication lifecycle requirements vs current state:

| Stage | Requirement | Current |
|---|---|---|
| Onboarding | customer profile + consent + preferences | ❌ |
| Status updates | scheduled, approved, sent, logged | 🟡 draft only |
| Requests for info | doc request drafts | 🟡 draft only |
| Appointment coordination | schedule + confirm | ❌ |
| Expectation management | milestones + timing comms | ❌ |
| Follow-ups | reply tracking + reminders | 🟡 in-memory |
| Complaints | intake + severity + escalation | ❌ |
| Escalations | manager approval path | ❌ |
| Claim progress | milestone-based updates | 🟡 status-based |
| Completion communication | closeout message | ❌ |
| Satisfaction feedback | survey/feedback capture | ❌ |

**What Atlas may draft:** all 8 draft types (governance ALLOW for drafting).
**What Atlas may send:** nothing today — no send path; when built, only with
REVIEW_REQUIRED approval and only for non-blocked decisions.
**What requires approval:** every external message.
**Special handling:** complaint/escalation messages (manager approval), anything
touching coverage or liability (BLOCK), anything needing consent (not modeled).

---

# PHASE 10 — CROSS-WORKER HANDOFFS

Full handoff map with trigger/input/output/owner/evidence/governance/state/failure
is in `ATLAS_CROSS_WORKER_HANDOFFS.md`. The canonical chain:

```text
Claims Manager ──identifies supplement opportunity──▶ Supplement Specialist
Supplement Specialist ──defensible supplement package──▶ Revenue Recovery Coordinator
Revenue Recovery Coordinator ──approved scope + funding──▶ Project Manager
Project Manager ──progress + completion events──▶ Customer Success Manager
Estimator ◀───estimates required anywhere───▶ (all workers)
Governance ──decisions/approvals──▶ every handoff
```

**Current reality:** the six pages share one dataset but **no handoff state exists**
— there is no "handed off from X to Y on date D with input Z" record anywhere. Work
items are recomputed per load; governance decisions are the only cross-worker
persistent artifact. Atlas behaves as six views of one database, not one workforce.

---

# PHASE 14 — PROFESSIONAL BOUNDARIES (summary)

Full matrix in `ATLAS_PROFESSIONAL_BOUNDARIES.md`. Enforced today in
`role-boundary.ts`:

| Action | Atlas decision | Status |
|---|---|---|
| claim_analysis, evidence_analysis, financial_calculation, deadline_management, project_scheduling, quality_assurance, escalation, regulatory_lookup, jurisdiction_analysis, compliance_check | ALLOW | ✅ wired + persisted for orchestrator paths |
| policy_interpretation, supplement_preparation, communication_sending, carrier_submission, coverage_determination | REVIEW_REQUIRED (coverage additionally requires licensed adjuster) | ✅ wired for supplement_preparation/communication; carrier_submission has no execution path |
| legal_conclusion, medical_determination, engineering_determination, contract_execution, financial_commitment | PROHIBITED | ✅ matrix + persisted BLOCK when evaluated |

Gaps: (1) estimator output never passes the gate; (2) claim stage moves and
supplement status changes are **not** governed (a human can advance a claim without
a recorded approval); (3) no UI enforces `PROHIBITED` actions (they simply don't
exist as features — good, but unverifiable); (4) licensed-review conditions are not
content-aware (a supplement asserting structural work isn't auto-flagged).

---

# PHASE 15 — EVIDENCE REQUIREMENTS

**Target chain (per material output):**

```text
Supplement line item
 ↓ supporting photo/document
 ↓ extracted fact
 ↓ source document
 ↓ reasoning
 ↓ applicable rule/standard
 ↓ confidence
 ↓ governance decision
```

| Link | Current state |
|---|---|
| Supporting photo/document | 🟡 documents linked to claim; not per item |
| Extracted fact | 🟡 `enrichClaimFromEvidence` extracts amounts/scope from text |
| Source document | 🟡 `evidenceDocumentIds`; findings store `evidence` strings only |
| Reasoning | 🟡 `rationale`/`justification` fields |
| Applicable rule/standard | 🟡 governance `applicableRules`/`applicableStandards` (structured refs) — for decisions, not for findings/line items |
| Confidence | ✅ fields everywhere |
| Governance decision | ✅ persisted for orchestrator actions; ❌ for findings/estimator items |

**Where the chain is complete today:** governance decisions
(`governance_decisions.applicable_rules/standards` + evidence references).
**Where it is not:** findings, supplement line items, estimate line items, deadline
assertions, communication drafts — all carry evidence as strings or not at all.

---

# PHASE 18 — "JOB COMPLETE" DEFINITIONS

> A worker is NOT complete because it generated a document. Completion is an
> objective, evidence-checked state. None of these are reachable in the current
> system except partially for Claims Manager; they are the acceptance criteria for
> future phases.

**Claims Manager — JOB COMPLETE**
= claim reconstructed (identifiers, parties, dates, coverage context, evidence linked)
+ completeness report generated with every category verified or a documented gap
+ findings persisted with evidence
+ conflicts surfaced and either resolved with provenance or escalated
+ deadlines tracked with next actions
+ work items generated and assigned (owner + due date)
+ governance satisfied (review decision persisted, approvals recorded)
+ next responsible action assigned
**Current:** every item except "governance satisfied + approvals recorded" is partial;
nothing enforces the AND.

**Supplement Specialist — JOB COMPLETE**
= trigger validated against evidence
+ every proposed line item has: evidence chain, quantity, unit, pricing source, confidence
+ scope comparison documented (original vs observed vs documentation vs rules vs carrier)
+ package assembled (narrative + schedule of values + evidence matrix)
+ governance approval recorded
+ submission executed (external) OR explicitly awaiting external with a date
+ response tracked to terminal state (approved/denied/partial with amounts)
**Current:** trigger ✅, package partial, everything else ❌/🟡.

**Revenue Recovery Coordinator — JOB COMPLETE**
= every supplement in terminal state
+ expected vs received reconciled from payment evidence
+ outstanding balance = 0 or an approved exception
+ aging report generated for all open items
+ follow-ups executed or scheduled with dates
+ escalation closed (decision recorded)
+ reconciliation report persisted
**Current:** 🟡 aggregates only; no completion reachable.

**Project Manager — JOB COMPLETE**
= project created from claim
+ schedule + milestones with owners and dates
+ dependencies resolved (permits, inspections, materials)
+ work documented complete
+ closeout package assembled
+ invoiced and reconciled
+ customer informed (approved comms)
+ claim closed with governance record
**Current:** ❌ — no project entity exists.

**Estimator — JOB COMPLETE**
= scope reconstructed from evidence
+ every line item validated (evidence, quantity, pricing, confidence, governance state)
+ licensed review recorded where required
+ estimate delivered into the estimating platform (Xactimate or compatible)
+ discrepancies vs original estimate documented
**Current:** 🟡 line items generated; nothing validated/delivered.

**Customer Success Manager — JOB COMPLETE**
= customer profile + consent on file
+ every required communication drafted, approved, sent, and logged
+ appointments coordinated
+ complaints resolved or escalated with records
+ completion communication sent
+ satisfaction feedback captured
**Current:** 🟡 drafts only.

---

## Blueprint conclusion

The repository contains the **analysis spine** (claims, evidence, governance) that
every one of the six workers needs, plus **read-only worker dashboards** over it.
To convert the dashboards into job-completing workers, the next engineering phases
must add, in order: (1) a persisted job/work-item + handoff layer, (2) line-item and
estimate structures, (3) a payment ledger, (4) a project entity, (5) the
communication send path with governance enforcement, and (6) the external
integrations (Xactimate, carrier, email) — with the knowledge and jurisdiction
base upgraded from placeholders to verified sources before any of it becomes
authoritative. The prioritized plan is `ATLAS_REMAINING_ENGINEERING_ROADMAP.md`.