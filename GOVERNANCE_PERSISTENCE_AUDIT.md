# GOVERNANCE PERSISTENCE AUDIT

> **Acceptance criterion:** Atlas must be able to prove, after the fact, what it
> decided, why it decided it, what knowledge and evidence supported it, what
> authority applied, whether a human was required, whether the action executed,
> and what happened afterward.
>
> This audit covers the governance persistence phase (migration 20260904 +
> persistence service + orchestrator wiring + UI + tests) on top of the
> previously completed governance engine phase.

---

## 1. Database

### Tables created

**`governance_decisions`** — append-only evaluation history with an execution/
approval state machine on each row. One row per governance evaluation; the
original decision is never mutated (overrides are recorded alongside it).

| Column group | Columns |
|---|---|
| Tenant/entity | `tenant_id` (FK tenants, CASCADE), `claim_id`, `entity_type`, `entity_id`, `action_type` |
| Decision | `decision` (ALLOW / REVIEW_REQUIRED / BLOCK / UNKNOWN), `risk_level`, `jurisdiction`, `actor_role` |
| Temporal | `evaluated_at`, `knowledge_reference_date` (evaluation date — **never the loss date**), `loss_date`, `policy_period_start/end` |
| Provenance | `applicable_rules` (JSONB, structured refs), `applicable_standards` (JSONB), `required_approvals` (TEXT[]), `knowledge_gaps` (JSONB), `citations` (TEXT[]), `evidence_references` (JSONB), `decision_rationale` |
| Engine | `governance_engine`, `knowledge_corpus_version` |
| Linkage | `orchestration_id`, `action_id`, `dedup_key` |
| State | `execution_status` (not_executed / executed / awaiting_approval / approved / rejected / blocked / escalated / superseded / awaiting_external), `approval_status` (not_required / required / approved / rejected), `approved_by/at/notes` |
| Override | `override_decision`, `override_reason`, `override_by`, `overridden_at` |

**`governance_events`** — immutable audit log: `governance.evaluated`,
`governance.allowed`, `governance.review_required`, `governance.blocked`,
`governance.unknown`, `governance.approved`, `governance.rejected`,
`governance.escalated`, `governance.overridden`, `governance.superseded`
(one per transition, with payload + actor + timestamp).

### RLS

- `service_role`: full access (workers).
- `authenticated`: tenant-scoped SELECT + own-tenant INSERT via the memberships
  join — the exact pattern from `0021_atlas_human_reviews`.
- `super_admin`: full access (existing platform rule, reused — no second RBAC).
- All mutating RPCs are `SECURITY DEFINER` and **re-verify the caller's tenant
  inside the function body** (`governance_resolve_tenant`): a client can never
  insert, read, or decide for another organization's records (super_admin may
  pass an explicit tenant).

### Indexes

- `(tenant_id, claim_id, evaluated_at DESC)` — claim history.
- `(tenant_id, action_type, evaluated_at DESC)` — action history.
- Partial `(tenant_id, evaluated_at DESC) WHERE approval_status='required' AND
  execution_status IN ('awaiting_approval','blocked')` — actionable work queue.
- `(tenant_id, dedup_key, evaluated_at DESC)` — dedup resolution.

### Relationships

```
governance_decisions ──tenant──▶ tenants
governance_decisions ◀──decision_id── governance_events
governance_decisions ──approved_by/override_by──▶ auth.users
```

---

## 2. Execution — every material Atlas action

| Action | Governance | Persistence | Approval | Audit | Bypass |
|---|---|---|---|---|---|
| `reviewClaim` (claim_analysis) | ✅ gate `claim_analysis` | ✅ `governance_record_decision` | ALLOW → none | ✅ evidence record + `governance.allowed` | ❌ none |
| `prepareSupplement` (supplement_preparation) | ✅ gate (REVIEW_REQUIRED by matrix) | ✅ persisted | required (`human_review`) | ✅ `governance.review_required` | ❌ none — output is a draft; **no submission integration exists** |
| `draftCommunication` (communication_drafting/sending) | ✅ gate | ✅ persisted | required for external comms | ✅ | ❌ none — **no send path exists**; drafts only |
| `calculateRecovery` (financial_calculation) | ✅ gate (ALLOW) | ✅ persisted | none | ✅ | ❌ none — calculation is client-side, no external financial system |
| `legal_conclusion` / `engineering_determination` / `contract_execution` | ✅ **BLOCK** by role matrix | persisted as blocked | override only (super_admin/atlas_admin) | ✅ `governance.blocked` | ❌ no code path executes them |
| `coverage_determination` | ✅ **REVIEW_REQUIRED** (licensed adjuster/public adjuster) | persisted | required | ✅ | ❌ |

Persistence is best-effort but **never silent**: a persistence failure is
recorded on the governance summary's trace (`[GOVERNANCE-PERSIST] …`) and the
result carries `persisted: false`. The decision record is created **even when
execution is blocked** (BLOCK/UNKNOWN rows are persisted with
`execution_status = 'blocked'`).

### Decision → state mapping (enforced in SQL)

| Decision | execution_status | approval_status | Work queue |
|---|---|---|---|
| ALLOW | not_executed | not_required | — |
| REVIEW_REQUIRED | awaiting_approval | required | Approve / Reject / Escalate |
| BLOCK | blocked | required | Escalate / authorized override |
| UNKNOWN | blocked | required | Resolve gap / escalate / authorized override |

**Invariant: `UNKNOWN != ALLOW`.** UNKNOWN maps to `blocked`, cannot be
plain-approved, and requires an explicit `override_decision` from a
`super_admin`/`atlas_admin` — with the override recorded next to the original
decision. History is never mutated.

---

## 3. Knowledge provenance

Every persisted decision carries structured references, not prose:

```
Decision
  ↓
Knowledge Object  (applicable_rules[].{id,title,authorityLevel,authorityBasis,
                   citation,effectiveFrom,jurisdiction,confidence})
  ↓
Source            (sourceName + sourceUrl on the KnowledgeObject; citation
                   string retained)
  ↓
Authority Level   (structured authorityLevel + authorityBasis — never
                   inferred from wording; placeholder records demoted to
                   general_ai_knowledge / "not authoritative")
  ↓
Jurisdiction      (jurisdiction column, resolved from the property address)
  ↓
Effective Date    (effectiveFrom on each rule ref)
  ↓
Evaluated Date    (knowledge_reference_date = evaluation date)
```

A reviewer can therefore answer "which version of the rule applied at
evaluation time" for every decision. The UI explicitly labels
`general_ai_knowledge` items as **not authoritative** (never presented as law).

## 4. Work Queue

`governance_list_actionable()` returns every decision still awaiting a human
(REVIEW_REQUIRED/BLOCK/UNKNOWN). The Work Queue page now renders an **"Atlas
governance — pending decisions"** panel with Approve / Reject / Escalate
actions, the decision rationale, and knowledge gaps. BLOCK/UNKNOWN rows show
"Requires super_admin / atlas_admin override".

Deduplication: each evaluation has a deterministic `dedup_key`
(`action_type|entity_type|entity_id`). Recording a new evaluation for the same
key **supersedes** the prior actionable row (`execution_status = 'superseded'`)
instead of creating a duplicate work item — repeated evaluation produces exactly
one actionable row (verified by live E2E test J). History is preserved; the
superseded row is not deleted.

## 5. Human control

- **REVIEW_REQUIRED** → Atlas stops; the work item requires Approve / Reject /
  Escalate (`governance_decide`), each recorded as an audit event.
- **BLOCK / UNKNOWN** → Atlas stops; only an authorized human
  (`super_admin`/`atlas_admin`) may override, and only with an explicit
  `override_decision` + reason, recorded alongside the original decision.
- **Approvals** are recorded with `approved_by` (auth user id), `approved_at`,
  and notes; the `governance_events` log is append-only.
- There are **no autonomous external execution paths** in the system: no
  supplement submission integration, no communication send integration, no
  external financial system. All outputs are `drafted`/`prepared` and remain
  `awaiting_approval` — nothing claims an external integration that does not
  exist (Phase 19).

## 6. Tests

```
Governance tests:   26 passed  (knowledge-source 17, persistence 9) + 1 live e2e skipped by default
Orchestrator tests:  5 passed  (governance wiring — ALLOW/REVIEW_REQUIRED paths,
                                jurisdiction resolution, persistence-failure trace)
Integration tests:   1 live e2e (RUN_LIVE_E2E=1) — A..E + J: record, list,
                     actionable, approve, block-override, tenant isolation, dedup
Full suite:         1356 passed / 8 failed / 5 skipped
                     (8 failures are the SAME pre-existing legacy milestone
                     7/7b/9 stale-require failures — untouched, unrelated)
TypeScript:          scoped check of all changed files: 0 errors
                     repo-wide `tsc -b` remains red from pre-existing
                     ai-runtime type errors (untouched, present at HEAD)
Build:               not run (Vite build does not typecheck; scoped tsc +
                     full vitest suite are the verification gates used here)
```

## 7. Remaining gaps (real ones only)

1. **Migration not applied to the live Supabase project** — the RPCs/RLS exist
   in `supabase/migrations/20260904_atlas_governance.sql` but require
   `supabase db push` (or the SQL editor) to become live. Until then
   persistence reports `no_authenticated_session`/RPC-not-found and the UI
   shows "Not persisted".
2. **Live E2E** (`governance-live.e2e.test.ts`) needs the migration applied and
   `RUN_LIVE_E2E=1` to execute.
3. **External execution** (supplement submission, communication sending) is
   intentionally absent — no real integration exists. When one is built, it
   must check the persisted decision state before executing (bypass test
   patterns H/I are documented in the live test).
4. **Pre-existing repo debt** (unchanged by this phase): `ai-runtime` TypeScript
   errors at HEAD; legacy milestone 7/7b/9 tests using stale `require()` paths;
   `human_reviews_list`-style RPCs trust a passed tenant id (governance RPCs
   intentionally do not — they re-derive the tenant in-body).
5. **Orchestrator duplicate workflows**: `workflows/claim-review.ts` and
   `workflows/supplement-preparation.ts` still have no callers (the orchestrator
   runs its inline pipeline). Consolidation is a separate cleanup, not a
   correctness gap — the live path is governance-gated and persisted.