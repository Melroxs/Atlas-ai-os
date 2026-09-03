# ATLAS WORKFORCE UX AUDIT

> Baseline: branch `main` @ `7fad459` (merge of PR #6). Working tree has 3 pending
> files from the prior verified governance phase (live E2E test fix,
> `src/lib/supabase.ts` anon-key export, `scripts/run-db-sql.mjs` utility) —
> reported, not part of this phase's changes.
>
> Governance persistence is LIVE on Supabase project `ibxvzxblyhzwokljkslt`
> (tables, RLS, 9 RPCs, tracker record, live E2E verified).

---

## 1. Current route map (all protected routes under `/dashboard`)

| Route | Page | Primary user | Data source | Role |
|---|---|---|---|---|
| `/` | Landing | Public | static | Public |
| `/pricing` `/checkout` `/pricing-success` `/auth` `/setup` | Billing/auth | Public/signed-in | Stripe edge fns | Public |
| `/dashboard` | **Atlas Home** (Dashboard.tsx) | Operator | claims, counts, recommendations, activity, knowledge graph, briefing | Primary |
| `/dashboard/ask` | Ask Atlas | Operator | conversation edge fn | Primary |
| `/dashboard/knowledge` | Knowledge base (docs + ingestion) | Operator/analyst | documents, archive lists | Primary |
| `/dashboard/knowledge/:id` | Document detail | Analyst | document detail | Secondary |
| `/dashboard/knowledge/archives/:id` | Archive detail (ingestion) | Operator | archive detail | Primary |
| `/dashboard/intelligence` | Intelligence packs | Analyst | packs | Secondary |
| `/dashboard/brain` | Business Brain | Analyst | events/entities | Secondary |
| `/dashboard/recommendations` | Recommendations | Operator | recommendations RPCs | Secondary |
| `/dashboard/connections` | Connections | Admin | connectors | Secondary |
| `/dashboard/actions` | Actions & Tools | Admin | tools | Secondary |
| `/dashboard/events` | Events | Admin | events RPCs | Secondary |
| `/dashboard/workflows` + `/:id` | Workflows | Admin/operator | workflow RPCs | Secondary |
| `/dashboard/work-queue` | Work Queue | Operator | work-queue service + governance actionable | **Worker queue** |
| `/dashboard/revenue-recovery` + `/:id` | Revenue Recovery + Claim Package | Operator | insurance claims/recovery RPCs | Primary |
| `/dashboard/team` | Team | Admin | tenants/members | Secondary |
| `/dashboard/audit` | Activity / Audit | Admin | audit logs | Secondary |
| `/dashboard/settings` | Settings | Admin | tenant | Secondary |
| `/dashboard/mail*` `/dashboard/users` `/dashboard/pilot*` | Mail / Users / Pilot | Role-gated | mail/users/pilot RPCs | Role-gated |

## 2. Navigation today (app-shell.tsx `NAV_SECTIONS`)

Operations (Atlas Home, Revenue Recovery, Work Queue, Workflows) · Intelligence
(Atlas Intelligence, Business Brain, Knowledge, Events) · Atlas (Ask Atlas,
Actions, Recommendations, Activity/Audit) · Workspace (Connections, Team,
Settings) · Admin/Mail/Pilot (role-gated).

**Problem:** the nav is a flat catalog of *internal systems*. There is no
concept of the six worker functions the orchestrator already implements
(`CapabilityDomain` in `src/lib/orchestrator/types.ts` already enumerates
claims_management, supplement_specialist, revenue_recovery, project_management,
estimating, customer_success). Claims have no dedicated home (they live inside
Revenue Recovery → ClaimDetail).

## 3. Backend capabilities that exist and must be surfaced

| Capability | Where | Notes |
|---|---|---|
| Atlas Workforce Orchestrator | `src/lib/orchestrator/atlas-workforce.ts` | `reviewClaim`, `prepareSupplement`, `draftCommunication`, `calculateRecovery`, governance-gated + persisted |
| Governance engine + persistence | `src/lib/governance/*` | LIVE on Supabase: decisions, events, RLS, RPCs, approvals, overrides |
| Work queue service | `src/lib/work-queue/service.ts` | deterministic `buildWorkQueue(claims)` → prioritized `WorkItem[]` |
| Deadline tracker | `src/lib/comms/deadline-tracker.ts` | `trackDeadlines(claims)` (SOL, policy period, follow-up) |
| Daily briefing | `src/lib/comms/daily-briefing.ts` + `DailyBriefingPanel` | already surfaced on Dashboard |
| Follow-up scheduler | `src/lib/comms/follow-up-scheduler.ts` | `scheduleFollowUps(claims)` |
| Communication drafting | `src/lib/comms/drafting.ts` (via orchestrator `draftCommunication`, governance-gated) | drafts only — **no send path** (honest) |
| Estimator | `src/lib/orchestrator/estimator.ts` | `generateEstimateLineItems(claim)` — review-ready data, **no Xactimate integration** (honest) |
| Claims engine | `src/lib/insurance/*` + `api.insurance.claims` | listClaims, getClaimPackage, claimCounts, recoveryAnalytics, runClaimAnalysis, supplements, findings |
| Claim discovery | `api.insurance.candidates` | candidates, approve/reject, reconstructClaims |
| Agent runtime | `src/lib/agents/*` | evidence/gap/supplement/QA agents, tool registry with `external_action` gating |
| Jobs/pipeline | `src/lib/jobs/*` | durable jobs, claim-review handler |
| Recommendations | `api.recommendations` | signals with counts |
| Events/audit | `api.events`, `api.audit` | system history |
| Knowledge | `api.knowledge` + corpus | entities, assertions, graph |

## 4. Scalability audit (unbounded collections)

| Page | Collection | Today | Fix |
|---|---|---|---|
| ArchiveDetail | archive files | all rows in a max-h scroll table | search + status filter + folder groups + collapsible + pagination |
| Knowledge | documents | flat list of all docs | search + filter + pagination + counts |
| Knowledge | archives | flat list | counts + search |
| WorkQueue | work items | flat grouped lists | search + filter chips + pagination |
| RevenueRecovery | claims table | flat | search + pagination (partial: page exists) |
| Governance (new) | decisions | — | search + filter + pagination from day one |
| Recommendations/Events/Workflows | lists | capped by backend | keep + compact rows |

## 5. Current → New mapping

| Current | New Atlas experience |
|---|---|
| Atlas Home `/dashboard` | **Command Center** (operational home: workforce status, attention queue, financial intelligence, deadlines, recent work) |
| *(no dedicated page)* | **Workers hub `/dashboard/workers`** |
| *(no dedicated page)* | **Claims Manager** `/dashboard/workers/claims` |
| Workflows supplements/ClaimDetail | **Supplement Specialist** `/dashboard/workers/supplements` |
| Revenue Recovery | **Revenue Recovery Coordinator** `/dashboard/workers/recovery` (old page retained at its route) |
| *(no dedicated page)* | **Project Manager** `/dashboard/workers/projects` |
| Estimator lib (no UI) | **Estimator** `/dashboard/workers/estimator` |
| *(no dedicated page)* | **Customer Success Manager** `/dashboard/workers/customers` |
| Work Queue | Shared attention queue under Workforce (retained) |
| Intelligence packs | Intelligence → **Evidence & Intelligence packs** (retained) |
| Governance (panel in ClaimDetail only) | **Governance page** `/dashboard/governance` (pending approvals + decision history + gaps) + in-context cards |
| Knowledge (docs+ingestion) | Data → **Knowledge & Ingestion** (retained, made scalable) |
| Workflows/Events/Actions/Audit/Connections/Team/Settings | **System** (retained, de-emphasized) |
| Ask Atlas, Business Brain, Recommendations | Intelligence (retained) |

## 6. Reusable components

`atlas-ui.tsx` (PageHeader, Panel, StatCard, EmptyPanel, badges), shadcn `ui/*`
(Tabs, Collapsible, Accordion, Table, Input, Badge, Button, Sheet, Dialog),
`workforce/daily-briefing-panel.tsx`, `workforce/atlas-review-panel.tsx`,
`use-atlas-workforce` hook, work-queue `WorkItem` type, governance
`persistence.ts` (listActionableGovernance, decideGovernanceDecision),
estimator `generateEstimateLineItems`, comms `trackDeadlines`/`scheduleFollowUps`.

## 7. Governance connection status

- Wired: orchestrator → governance gate → persistence (4 material actions),
  Review Panel card + history, Work Queue pending-decisions panel.
- **Gap:** no standalone Governance page; governance results are not grouped by
  worker; no search/filter over the decision history. → New Governance page +
  per-worker governance filters.

## 8. Honesty constraints (must be preserved)

- No communication SEND path exists → every "send" affordance must stay a
  "draft for review" affordance with governance REVIEW_REQUIRED visible.
- No Xactimate integration → estimator output is labeled
  "review-ready data for input into Xactimate".
- No insurer submission integration → supplement state stays PREPARED /
  AWAITING_EXTERNAL_EXECUTION.
- No fake metrics: use claimCounts / recoveryAnalytics / work items; empty
  states where data is absent.