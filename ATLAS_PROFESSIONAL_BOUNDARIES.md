# ATLAS — PROFESSIONAL BOUNDARIES

> **Purpose.** Explicitly identify work Atlas must **not** perform autonomously,
> and the ALLOW / REVIEW_REQUIRED / BLOCK classification enforced (or to be
> enforced) for each. The enforcement engine is the role-boundary matrix in
> `src/lib/governance/role-boundary.ts` (26 action types × Atlas role), the
> compliance gate in `src/lib/governance/compliance.ts`, and the persisted
> decision store (`governance_decisions`, migration `20260904_atlas_governance.sql`).
>
> **Hard rules (from the governance engine, already implemented):**
> - `UNKNOWN` must never become `ALLOW` — unknown action/role combinations return
>   `UNKNOWN` and require human determination.
> - `BLOCK` cannot be bypassed by UI logic — only a `super_admin`/`atlas_admin`
>   override with an explicit `override_decision` + reason is recorded alongside the
>   original decision; history is never mutated.
> - Human approvals are auditable — every Approve/Reject/Escalate/Override is a
>   `governance_events` row.
> - Governance stays independent of the AI model — the gate runs deterministic
>   rules over verified knowledge; model output cannot change a decision.

## ALLOW (Atlas may perform autonomously — with evidence + audit)

| Action | Why allowed | Current wiring |
|---|---|---|
| `claim_analysis` | Analysis of claim data to identify patterns and gaps is not a regulated act | ✅ Orchestrator `reviewClaim` gate, persisted |
| `evidence_analysis` / `gap_identification` | Identifying facts/gaps/contradictions | ✅ Matrix; not separately gated in orchestrator |
| `financial_calculation` / `revenue_recovery_calculation` | Arithmetic over documented inputs | ✅ `calculateRecovery` gate, persisted |
| `estimate_calculation` | Preparing estimate candidates for human review | ✅ Matrix (estimator output not yet passed through the gate — gap) |
| `deadline_management` | Tracking and alerting on deadlines | ✅ Matrix; deadline output not gated (acceptable — informational) |
| `project_scheduling` | Managing schedules/task assignments | ✅ Matrix (no PM features exist yet) |
| `quality_assurance` | Checking against standards | ✅ Matrix |
| `escalation` | Raising issues that need human judgment | ✅ Matrix (no escalation flow exists yet) |
| `regulatory_lookup` / `jurisdiction_analysis` / `compliance_check` | Retrieving and resolving applicable knowledge | ✅ Matrix |
| `communication_drafting` | Drafting for human review and approval | ✅ Orchestrator `draftCommunication` gate, persisted |

## REVIEW_REQUIRED (Atlas prepares; a human authorizes before execution)

| Action | Why review is required | Current wiring |
|---|---|---|
| `policy_interpretation` | Identifying potentially relevant provisions is analysis; concluding their meaning is close to legal advice | ✅ Matrix (not separately gated) |
| `supplement_preparation` | Claim-affecting document; must be reviewed before submission | ✅ Orchestrator `prepareSupplement` gate + persistence + approval state machine |
| `communication_sending` | External communications must be human-approved | ✅ Gate exists (`draftCommunication` evaluates `communication_sending`); **no send path exists to enforce it on** |
| `carrier_submission` | Submitting to a carrier commits the company | ✅ Matrix; no submission path exists |
| `coverage_determination` | **Licensed-professional required** (`insurance_adjuster_or_public_adjuster`) — binding coverage determinations are a licensed act | ✅ Matrix; persisted BLOCK/REVIEW when evaluated |
| `customer_notification` | Customer-facing, expectation-setting | ✅ Matrix (tracked with communication gates) |
| `adjuster_coordination` | Third-party professional coordination | ✅ Matrix |

## BLOCK (Atlas must stop; these require licensed humans and are PROHIBITED for Atlas)

| Action | Why blocked | Enforcement |
|---|---|---|
| `legal_conclusion` | Practice of law requires a licensed attorney | ✅ Matrix → `PROHIBITED`; if evaluated, persisted as BLOCK; **no code path produces legal conclusions** |
| `medical_determination` | Medical determinations require licensed professionals | ✅ Matrix |
| `engineering_determination` | Structural/engineering determinations require a licensed engineer | ✅ Matrix; estimator must hand structural items to a human engineer |
| `contract_execution` | Binding contracts require an authorized officer | ✅ Matrix |
| `financial_commitment` | Binding financial commitments require an authorized officer | ✅ Matrix |

## Additional boundaries that governance must control (requirements)

These are not yet modeled as gate conditions but must be added:

| Boundary | Classification | Why | Needed change |
|---|---|---|---|
| Licensed-estimator certification of quantities/pricing | REVIEW_REQUIRED | Estimates become contractual/submission documents | Wire `estimate_review` gate onto estimator output; require licensed role sign-off before any estimate is finalized |
| Structural/engineered scope in supplements/estimates | BLOCK for Atlas | Engineering determination | Content-aware gate: any line item referencing structural/engineered work must route to a licensed engineer and be BLOCKed for Atlas |
| State-licensed restoration work sign-off | REVIEW_REQUIRED | Many states require licensed contractors to certify work performed | Jurisdiction-aware gate (needs verified Tier 1 licensing knowledge — currently placeholder) |
| Claim stage advancement | REVIEW_REQUIRED | Stage moves change obligations and exposure; currently a free-string update | Add governed transitions to the claim state machine |
| Supplement outcome recording | REVIEW_REQUIRED | Recording carrier responses/amounts is a financial assertion | Gate `insurance_update_supplement_status` writes with a recorded approver |
| Customer consent to contact | REVIEW_REQUIRED (or BLOCK until consent exists) | Privacy/consent law | Add consent state to customer records; BLOCK sending without it |
| Collections actions | REVIEW_REQUIRED (company policy) / BLOCK where legally prohibited | Debt-collection rules | Escalation/collections flow must respect state rules |
| External submission of any kind | REVIEW_REQUIRED at minimum | "Preparation ≠ submission" | Only an approved governance decision may precede an external send; the future send integration must check persisted decision state before executing (bypass tests already documented in the governance live E2E) |

## Boundary integrity checks (current system behavior)

1. **UNKNOWN never becomes ALLOW** — verified: `evaluateRoleBoundary` returns
   `UNKNOWN` for un-matrixed actions; compliance maps UNKNOWN → BLOCK at the gate;
   `governance_decisions` maps UNKNOWN → `execution_status='blocked'`, approval
   required, override-only.
2. **BLOCK not bypassable by UI** — the Governance page only offers
   Approve/Reject/Escalate; BLOCK/UNKNOWN rows require super_admin/atlas_admin
   override with reason; the page labels them as such.
3. **Approvals auditable** — `governance_events` append-only; approved_by/at/notes
   recorded on the decision row.
4. **Gate failures are never silent** — an exception in the gate records `UNKNOWN`
   with the error in the evaluation trace and `persisted:false` visible in the UI.
5. **Gaps that weaken this:** (a) estimator output bypasses the gate entirely;
   (b) claim/supplement status writes bypass governance; (c) the four agents and job
   pipeline (which could execute tool actions) are dormant — if they are ever
   connected, they must pass through the same gates; (d) `external_action`-gated
   tools exist in `tool-registry.ts` but are unreachable — good, but unverifiable.

## What must never happen

- Atlas issuing a coverage opinion, legal conclusion, or engineering determination
  in any output (chat, draft, package, estimate, voice).
- Any UI affordance that implies Atlas submitted/sent something externally.
- A placeholder knowledge record reaching `applicableRules` as authority.
- A dormant subsystem (agents/jobs) being enabled without governance gates.