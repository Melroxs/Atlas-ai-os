# ATLAS — DATA MODEL GAP ANALYSIS

> **Purpose.** Determine whether the current database structures can represent
> everything discovered in the blueprint — without creating migrations. This is a
> documentation phase. Classification: **EXISTS** (fully represents the need) ·
> **INSUFFICIENT** (exists but cannot represent the full need) · **MISSING** (no
> structure) · **DUPLICATED** (more than one structure competes for the same need).
>
> Schema source: `supabase/migrations/0001_schema.sql` (core),
> `0020_atlas_jobs.sql` (jobs), `0021_atlas_human_reviews.sql` (human reviews),
> `20260826_atlas_knowledge_layer.sql` (knowledge), `20260904_atlas_governance.sql`
> (governance), plus mail/crm/pilot/stripe migrations.

## Per-structure classification

| Structure | Class | Current representation | Gap |
|---|---|---|---|
| Claim | INSUFFICIENT | `insuranceClaims` — rich row (16 statuses, financial fields, scope/evidence jsonb) | No enforced state machine; coverage context = raw numbers (deductible/policyLimits) with no policy document link; `timeline` jsonb unstructured; `carrierResponse` only on supplements, not claims |
| Claim lifecycle state | INSUFFICIENT | `status` + `currentStage` text columns + client `CLAIM_STATUSES`/`RECOVERY_PIPELINE` | No persisted transition table, no allowed-from/to, no role/evidence requirements per transition |
| Worker tasks / work items | MISSING | `buildWorkQueue` derived in-memory per load; governance `pendingGovernanceForWorker` is the only persistent "todo" | No `workItems` table — assignments, due dates, owners, and dependencies vanish on reload |
| Handoffs | MISSING | None | No `workerHandoffs`; cross-worker continuity impossible (see ATLAS_CROSS_WORKER_HANDOFFS.md) |
| Evidence | INSUFFICIENT | `documents`, `documentChunks`, `entities`, `entityRelationships`, `knowledgeAssertions`; claim `evidenceDocumentIds` jsonb | No evidence-per-fact/per-line-item join structure; evidence on findings/supplements/line items is free-text arrays; no evidence chain table |
| Evidence chain (fact → source → rule → decision) | MISSING | Governance decisions carry `evidence_references` jsonb + `applicable_rules` | Only for governance decisions; no generic chain for findings/estimates/comms |
| Knowledge objects | INSUFFICIENT | `authoritativeSources`, `authoritativeKnowledge` (rich metadata incl. effective/expiration/version/reviewStatus); corpus JSON modules | Schema is right; **records are seed-grade placeholders**; no acquisition/verification tooling; `impactAssessments` has no writer |
| Regulations / jurisdiction knowledge | INSUFFICIENT | Corpus JSON (51 placeholder profiles); no per-jurisdiction records in tables | No verified state law/regulation records; jurisdiction is a text field, no jurisdiction entity with metadata |
| Policies (insurance policies) | MISSING | `insuranceClaims.policy` text; `policyLimits`/`deductible` numbers | No policy table (form, terms, endorsements, period, jurisdiction applicability) — coverage reasoning impossible |
| Estimates / estimate line items | INSUFFICIENT | `estimateAmount`, `estimateLineItemCount`, `scopeItems`/`expectedScope`/`actualScope` jsonb; estimator output in-memory | No estimate table, no line-item rows (quantity/unit/price/evidence/provenance/confidence/governance per line) — the single biggest blocker for Estimator + Supplement Specialist |
| Supplement line items | MISSING | `claimSupplements.affectedLineItems`/`requestedItems` jsonb + single `amount` | No per-line requested/approved/denied values, no evidence links, no pricing basis |
| Recovery events | MISSING | Supplement status changes (free transitions) + `insurance_record_claim_payment` (increments a total) | No event ledger: no payment history rows, no response events, no aging inputs — expected-vs-received reconciliation impossible |
| Payment records | MISSING | `paymentAmount` running total | Individual payments (date, amount, method, reference, advice) never stored; the total is non-auditable and non-matchable |
| Project milestones | MISSING | Claim statuses only | No project entity, milestones, dependencies, schedules, crews, inspections |
| Customer communications | MISSING | Orchestrator `CommunicationRecord` is in-memory; CRM outreach/mail live in separate tables | No worker-communication log (subject, body, recipient, approval, send status, delivery) per claim/customer |
| Customer records | MISSING | `insuranceClaims.customer` text; pilot CRM leads | No customer entity (contact info, consent, preferences, communication history) shared across workers |
| Approvals | DUPLICATED | `workflowApprovals` (workflow system), `governance_decisions.approval_status/approved_by` (governance), `toolActions.confirmedBy` (tools), `recommendations.decidedBy` (recommendations) | Four approval mechanisms; governance is the correct one for worker actions — consolidation needed to keep human approvals auditable in one place |
| External execution records | INSUFFICIENT | `toolActions` (status, confirmation, outcome, verification) | Table exists but no worker execution uses it; no external-action ledger for sends/submissions |
| Outcomes | INSUFFICIENT | Supplement approved/denied/outstanding amounts; claim status | No outcome records (what happened, when, evidence, decision ref) per recovery cycle |
| Audit history | EXISTS | `auditLogs` (RPC writes) + `governance_events` (append-only) | Adequate for current surfaces; must extend to any new writes (line items, payments, comms) |
| Workflows / instances | INSUFFICIENT | `workflowInstances`/`workflowSteps` tables + `workflows` namespace | The orchestrator's inline pipeline bypasses them; definitions `workflows/claim-review.ts` + `supplement-preparation.ts` have no callers — DUPLICATED logic, dormant tables |
| Jobs | EXISTS (dormant) | `atlas_jobs` + steps/attempts/events + 12 RPCs | Schema + engine exist and are tested, but nothing enqueues/runs jobs in the product |
| Human reviews | DUPLICATED | In-memory `ReviewRequest` store (`agents/human-review.ts`) + `atlas_human_reviews` migration (0021) + governance approval state machine | Three review concepts; governance persistence is the live one; agents' in-memory store is unreachable |
| Governance | EXISTS | `governance_decisions` + `governance_events`, RLS, dedup, override, indexes | Complete for its scope; needs handoff_id/worker linkage and claim-stage-gating to cover new surfaces |
| Notifications | EXISTS (underused) | `notifications` table | No worker writes notifications; no channel delivery |

## Structural gaps by worker (which structures block completion)

| Worker | Blocking structures |
|---|---|
| Claims Manager | Enforced claim state machine; evidence-chain table; policy table; persisted work items |
| Supplement Specialist | Estimate line-item table; supplement line-item table; evidence-per-line-item; carrier response events |
| Revenue Recovery | Payment records; recovery events; aging; escalation records |
| Project Manager | Projects; milestones; dependencies; schedules (all MISSING) |
| Estimator | Estimate + line-item tables with per-line provenance/governance |
| Customer Success | Customer records; communication log; consent/preferences |
| Cross-worker | Handoffs table; persisted work items; unified approvals |

## Rules honored in this analysis

1. **No migrations were created or drafted** — this is a documentation artifact.
2. **No structure was invented to make the system look complete** — every MISSING
   row reflects a capability in the blueprint that has no home in the schema.
3. **DUPLICATED items are flagged, not merged** — consolidation is an engineering
   phase, not an audit claim.
4. **Tenant isolation and RLS patterns** are the template any new table must follow
   (tenantId column + tenant-scoped policies + security-definer RPCs re-verifying
   the caller's tenant in-body).