# ATLAS — DIGITAL EMPLOYEE CAPABILITY AUDIT

> **Purpose.** Determine, with evidence, what Atlas can actually *do* today for the six
> digital employee roles (Claims Manager, Supplement Specialist, Revenue Recovery
> Coordinator, Project Manager, Estimator, Customer Success Manager) — and where each
> capability sits on the ladder **code exists → capability exists → connected →
> persisted → governed → tested → production-ready.**
>
> **Method.** Every row below was traced through the repository (git HEAD `24c3312`,
> "Add Atlas workforce UX: command center, six workers, governance page (#7)").
> "Connected" means the capability is reachable from a real execution path (a page,
> an edge function, or a live orchestrator call) — an import alone is not connection.
> "Persisted" means a Supabase table/RPC or an append-only store survives the process.
> "Governed" means it passes the governance gate and leaves an auditable decision.
> "Tested" means a `*.test.ts` covers it (70 test files; ~1,373 documented tests,
> 8 pre-existing failures in legacy `milestone7/7b/9`, 5 skipped live-E2E).

Legend for the matrix columns: **E** = exists, **C** = connected, **P** = persisted,
**G** = governed, **T** = tested, **PR** = production-ready.
Values: ✅ = yes · 🟡 = partial · ❌ = no.

---

## 1. Stack at a glance (verified)

| Layer | Technology | Evidence |
|---|---|---|
| Frontend | React 19 + TypeScript + Vite + Tailwind v4 + shadcn/ui + Framer Motion | `package.json`, `src/main.tsx` |
| Backend | Supabase: Postgres + RLS + RPCs + Auth + Storage + Edge Functions | `supabase/migrations/*` (54 migrations), `supabase/functions/*` (9 functions) |
| API contract | `src/lib/api.ts` typed registry (query / mutation / edge / client) | `src/lib/api.ts` |
| AI | `conversation-converse` edge function: deterministic retrieval + optional Gemini | `supabase/functions/conversation-converse/source/index.ts` |
| Testing | Vitest, 70 `*.test.ts` files; live E2E gated by `RUN_LIVE_E2E=1` | `src/lib/**/*.test.ts`, docs |
| Package manager | Bun | `README.md` |

**Critical working-tree fact:** `supabase/migrations/` and `supabase/functions/` ARE
present on disk and tracked (verified via `ls` + `git ls-files`); earlier tooling
reported them empty — that was a listing artifact, not missing code.

---

## 2. Capability inventory

### 2.1 Ingestion & document processing

| Capability | E | C | P | G | T | PR | Evidence / trace |
|---|---|---:|---:|---:|---:|---:|---|
| Archive upload (zip/rar), analyze, extract, dedupe, version groups | ✅ | ✅ | ✅ | 🟡 | ✅ | 🟡 | `src/lib/archive/engine.ts` (`detectArchiveFormat`, `analyzeArchive`, `buildUploadPlan`), `extract.ts` (unrar via `public/unrar.wasm`), `archive.ts` action loop, `archiveIngestions`/`archiveFiles` tables (0001), pages `ArchiveDetail.tsx` |
| Document upload → `documents` row → chunks + embeddings | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | `src/lib/actions/ingestion.ts` (`processDocumentClient`, `ingestTextClient`), `src/lib/ingest/text.ts`, `documentChunks`, `localEmbed.ts` |
| PDF / DOCX / text / HTML parsing | ✅ | ✅ | — | ❌ | ✅ | ✅ | `src/lib/ingest/pdf.ts`, `docx.ts`, `text.ts`, `formats.ts` (supported extensions), `parsers.ts` |
| OCR (scanned PDFs / images) | 🟡 | ❌ | ❌ | ❌ | 🟡 | ❌ | `src/lib/ingest/ocr.ts`: `OCR_AVAILABLE = false`; honest "needs OCR" state; **no engine configured** |
| Legacy formats (`.doc`, `.msg`) | ❌ | ❌ | ❌ | ❌ | 🟡 | ❌ | `formats.ts` explicitly rejects with user guidance |
| Classification (document/file) | ✅ | ✅ | ✅ | ❌ | ✅ | 🟡 | `src/lib/archive/classify.ts` (`classifyFile`, `ARCHIVE_CLASSIFICATIONS`, `classificationBasis`, `classificationConfidence` on `archiveFiles`); `src/lib/ingest/formats.ts` |
| Text extraction from evidence for claim enrichment | ✅ | ✅ | 🟡 | ❌ | ✅ | 🟡 | `enrichClaimFromEvidence` (`src/lib/insurance/logic.ts`) — amounts + scope + evidence categories extracted from chunk text; runs inside `insurance_run_claim_analysis` (api.ts client impl) |
| Duplicate / version detection | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | `archive.ts` (dedupe by checksum, `isDuplicate`, `versionGroup`, `isSuperseded`), `archive_files` columns, `archive-contract.test.ts` |

### 2.2 Extraction, entity resolution, claim reconstruction

| Capability | E | C | P | G | T | PR | Evidence / trace |
|---|---|---:|---:|---:|---:|---:|---|
| Claim-number / customer / property extraction from paths + text | ✅ | ✅ | 🟡 | ❌ | ✅ | 🟡 | `src/lib/insurance/reconstruct.ts` (`extractClaimNumber`, `deriveCustomerFromPath`, `clusterDocumentsByClaimNumber`, `buildCandidateFromArchive`) |
| Claim candidate generation from archives | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | `runClaimDiscovery` (`src/lib/actions/claim-discovery.ts`) → `insurance_upsert_candidates` → `claimCandidates` table; wired in `archive.ts` and `insurance_run_claim_analysis` |
| Candidate approve / reject → real claim row | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | `insurance_approve_claim_candidate` / `insurance_reject_claim_candidate` RPCs; Revenue Recovery page |
| Entity extraction + graph (entities, relationships, assertions) | ✅ | ✅ | ✅ | ❌ | ✅ | 🟡 | `entities`, `entityRelationships`, `knowledgeAssertions` tables (0001); Business Brain page; `src/lib/atlas-data/business.ts` |
| Evidence requirements engine (§-style workflow-relative assessment) | ✅ | ✅ | ❌ | 🟡 | ✅ | 🟡 | `supabase/functions/conversation-converse/source/evidence-requirements.ts` (`assessReadiness`, workflow keys); `src/lib/insurance/evidence-requirements.ts` + tests; not persisted as its own table |
| Contradiction detection (cross-document) | ✅ | ✅ | ❌ | 🟡 | ✅ | ✅ | `src/lib/evidence/contradictions.ts`, `src/lib/insurance/contradictions.ts`, edge-function copy; surfaced in Ask Atlas; not a table |
| Claim reconstruction (heterogeneous evidence → claim record) | 🟡 | 🟡 | 🟡 | ❌ | ✅ | 🟡 | `discovery.ts` (decisions: create/enrich/propose/keep_evidence), `reconstruct.ts`, `enrichClaimFromEvidence`; candidates require human approve; **no full autonomous reconstruction** |

### 2.3 Claim analysis & intelligence

| Capability | E | C | P | G | T | PR | Evidence / trace |
|---|---|---:|---:|---:|---:|---:|---|
| Claim completeness model (verified/extracted/inferred/missing/needs_review/conflicted/stale) | ✅ | ✅ | 🟡 | ❌ | ✅ | ✅ | `analyzeClaimCompleteness` (`src/lib/insurance/logic.ts`) — 11 rules incl. freshness (30-day staleness) + financial-state conflict detection; derived at the data boundary; findings persisted via `insurance_upsert_findings` |
| Claim findings (9 categories: missing_scope, documentation_gap, scope_inconsistency, unresolved_carrier_response, potential_underpayment, workflow_delay, supplement_opportunity, estimate_inconsistency, overlooked_line_item, billing_reconciliation) | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | `buildClaimFindings` → `analyzeRecoveryOpportunities` (`src/lib/atlas-data/everest-insurance.ts`); `claimFindings` table; ClaimDetail run-analysis flow |
| Financial reconciliation (estimate vs supplements vs approved vs denied vs paid) | ✅ | ✅ | 🟡 | 🟡 | ✅ | ✅ | `reconcileClaim`; used by orchestrator `calculateRecovery` (governance-gated, persisted as decision) and ClaimDetail; derived, not stored |
| Recovery analytics (counts, trend, carrier breakdown, status distribution) | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | `insurance_claim_counts`, `insurance_recovery_analytics` RPCs; `buildRecoveryTrend`, `buildCarrierBreakdown`, `buildStatusDistribution`; Revenue Recovery page |
| Claim timeline reconstruction | ✅ | ✅ | 🟡 | ❌ | ✅ | ✅ | `buildClaimTimeline` (claim/findings/supplements/payments; atlas vs source labeled); ClaimDetail |
| Claim package model (verified/derived/inferred/missing/conflicting) | ✅ | ✅ | 🟡 | ❌ | ✅ | ✅ | `buildClaimPackage`; `insurance_get_claim_package`; Revenue Recovery claim package page |
| Claim review orchestrator (completeness + findings + reconciliation + deadlines + queue + follow-ups + recommendations) | ✅ | ✅ | 🟡 | ✅ | ✅ | 🟡 | `AtlasWorkforce.reviewClaim` (`src/lib/orchestrator/atlas-workforce.ts`) → governance gate (`claim_analysis`) → persisted decision; triggered from ClaimDetail (`useAtlasWorkflow`); outputs are in-memory results, not rows |
| Statute-of-limitations / policy-period / follow-up deadline tracking | ✅ | ✅ | 🟡 | ❌ | ✅ | 🟡 | `trackDeadlines` (`src/lib/comms/deadline-tracker.ts`) — `DEFAULT_JURISDICTION_RULES`: TX, FL, CA, NY + Default; types statute_of_limitations / carrier_response / internal_sla; derived in-memory |
| Work queue (prioritized, deterministic) | ✅ | ✅ | ❌ | 🟡 | ✅ | 🟡 | `buildWorkQueue` (`src/lib/work-queue/service.ts`), 10 categories + actionable types; WorkQueue page + worker attention lists; **not persisted** — recomputed per load |

### 2.4 Supplements

| Capability | E | C | P | G | T | PR | Evidence / trace |
|---|---|---:|---:|---:|---:|---:|---|
| Supplement record lifecycle (draft → ready_for_submission → submitted → carrier_review → approved / partially_approved / denied / additional_docs_requested / payment_received / closed) | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | `claimSupplements` table + `insurance_create_supplement` + `insurance_update_supplement_status` (status + carrierResponse + approved/denied/outstanding amounts + submissionDate); ClaimDetail |
| Supplement opportunity detection | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | `buildClaimFindings` + findings upsert; Supplement Specialist attention queue |
| Supplement narrative draft (8 draft types incl. supplement_narrative, carrier_correspondence, payment_followup, document_request) | ✅ | ✅ | ❌ | ✅ | ✅ | 🟡 | `generateDraft` (`src/lib/comms/drafting.ts`); orchestrator `prepareSupplement`/`draftCommunication` governance-gated; **draft only — never sent**; not persisted (in-memory `CommunicationRecord`) |
| Structured supplement document builder | ✅ | ✅ | 🟡 | ❌ | ✅ | ✅ | `buildSupplementDocument` (`src/lib/insurance/logic.ts`) — claim info, scope, evidence, line items, justification, amounts, limitations, reviewer notes; persisted only as whatever is stored in the supplement row |
| Supplement package HTML | ✅ | ✅ | 🟡 | ❌ | ✅ | 🟡 | `generatePackageHtml` (`src/lib/insurance/package-html.ts`) + `package-types.ts`, `package-client.ts`; ClaimDetail package view |
| Line-item-level supplement reasoning (quantity/unit/labor/material/waste/access/code) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | **Absent.** Supplement amounts are single `amount` values; no line-item child records, no pricing model |
| Carrier response tracking beyond a status + free-text | 🟡 | 🟡 | 🟡 | ❌ | ❌ | ❌ | `carrierResponse` text + approved/denied/outstanding amounts; no structured response events, no proof attachments, no aging |
| External submission (Xactimate / carrier portal / email) | ❌ | ❌ | ❌ | 🟡 | ❌ | ❌ | None. Supplements stop at `PREPARED`/`AWAITING_EXTERNAL_EXECUTION`; UI states human submission required |

### 2.5 Revenue recovery

| Capability | E | C | P | G | T | PR | Evidence / trace |
|---|---|---:|---:|---:|---:|---:|---|
| Recovery lifecycle pipeline (20-stage `RECOVERY_PIPELINE` in `logic.ts`) | ✅ | ✅ | 🟡 | ❌ | ✅ | 🟡 | Pipeline view in Revenue Recovery; stages derived from claim/supplement status, not a separate table |
| Outstanding / potential / requested / approved / denied / paid aggregates | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | `insurance_claim_counts`; Recovery Metrics selector (`buildRecoveryMetrics`) |
| Claim payment recording | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | `insurance_record_claim_payment` (increments `paymentAmount`); audit log; **no payment history table** — the total is overwritten |
| Payment matching (expected vs received per line/item/event) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | Absent |
| Aging / follow-up scheduling | 🟡 | 🟡 | ❌ | ❌ | ✅ | 🟡 | `scheduleFollowUps` (`src/lib/comms/follow-up-scheduler.ts`) derived in-memory; no persisted reminders, no aging buckets |
| Escalation workflow | 🟡 | 🟡 | ❌ | 🟡 | 🟡 | ❌ | `escalation_message` draft type + governance `escalation` ALLOW; no escalation state machine, no persisted escalation records |
| Reconciliation to zero (expected vs received per claim) | 🟡 | ✅ | 🟡 | 🟡 | ✅ | 🟡 | `reconcileClaim` computes outstanding from estimate/approved baseline − paid; cannot match payment events (none exist) |

### 2.6 Projects / deadlines / work execution

| Capability | E | C | P | G | T | PR | Evidence / trace |
|---|---|---:|---:|---:|---:|---:|---|
| Project / job records | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | **No projects table.** Claims are the only work entity |
| Project milestones / scheduling / dependencies | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | Absent (claim `status` + `currentStage` are the only lifecycle fields) |
| Deadline engine | ✅ | ✅ | 🟡 | ❌ | ✅ | 🟡 | `trackDeadlines`; Project Manager page attention; 4 jurisdiction rules only |
| Work queue | ✅ | ✅ | ❌ | 🟡 | ✅ | 🟡 | `buildWorkQueue`; persisted only indirectly via governance `pendingGovernanceForWorker` |
| Background jobs engine (queue, steps, retries, backoff, observability) | ✅ | ❌ | ✅ | ❌ | ✅ | ❌ | `src/lib/jobs/*` + migration `0020_atlas_jobs.sql` (tables + 12 RPCs); engine tests (67) — **but no production caller**: nothing imports `@/lib/jobs` outside jobs itself; `registerAgentPipeline` is invoked only in tests; no worker process runs |
| Agent runtime (evidence/gap/supplement/QA agents + tools + human review) | ✅ | ❌ | ❌ | 🟡 | ✅ | ❌ | `src/lib/agents/*`; `executeAgent` only called from `jobs/agent-pipeline.ts` (itself uncalled); human review store is **in-memory** (`human-review.ts`), the RPC layer (`human-review-api.ts`) targets `atlas_human_reviews` tables (migration 0021) but nothing invokes it in the product path |
| AI runtime (model registry, task router, usage tracking, eval) | ✅ | ❌ | 🟡 | ❌ | ✅ | ❌ | `src/lib/ai-runtime/*`; `runTask` called only from `ai-runtime/index.ts`; **no product consumer**; repo-wide `tsc -b` still red on pre-existing ai-runtime provider errors (documented in prior phase reports) |

### 2.7 Communications

| Capability | E | C | P | G | T | PR | Evidence / trace |
|---|---|---:|---:|---:|---:|---:|---|
| Communication drafting (8 types) | ✅ | ✅ | ❌ | ✅ | ✅ | 🟡 | `generateDraft`; orchestrator gated (`communication_drafting` ALLOW, `communication_sending` REVIEW_REQUIRED); **drafts are in-memory only** |
| Communication sending (worker comms to carriers/customers) | ❌ | ❌ | ❌ | 🟡 | ❌ | ❌ | **No send path for worker communications.** Every record stays `status: "drafted"`, `requiresApproval: true` |
| CRM outreach send (Resend) | ✅ | ✅ | ✅ | 🟡 | ✅ | 🟡 | `outreach-send` edge function (actions send_email/send_test_email/suppression), super_admin/atlas_admin only; **sole production caller: PilotOutreach page** (sales outreach, not worker comms) |
| Mail accounts (IMAP/SMTP) | ✅ | ✅ | ✅ | 🟡 | ✅ | 🟡 | `email` edge function (test_connection, setup_account, sync_folder, send_message); AES-GCM encrypted credentials (`ENCRYPTION_KEY`); MailInbox page; **user mailboxes, not worker outbound** |
| Team invite email | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | `team-invite-email` edge function |
| Notifications table | ✅ | 🟡 | ✅ | ❌ | 🟡 | 🟡 | `notifications` table (0001); no worker page writes notifications |

### 2.8 Customer information

| Capability | E | C | P | G | T | PR | Evidence / trace |
|---|---|---:|---:|---:|---:|---:|---|
| Customer as claim field | ✅ | ✅ | ✅ | ❌ | ✅ | 🟡 | `insuranceClaims.customer` (text); no customer entity/table, no contact info, no consent records |
| CRM leads (pilot) | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | `crm` namespace (`api.crm`), `data/atlas-qualified-leads.csv`, CSV import (`src/lib/crm/csv-import.ts`), Pilot CRM pages |
| Customer communication history | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | Drafts are in-memory; no per-customer comm log persisted |

### 2.9 Financial information

| Capability | E | C | P | G | T | PR | Evidence / trace |
|---|---|---:|---:|---:|---:|---:|---|
| Claim financial fields (estimate, invoice, payment, approved, collected, openBalance, deductible, policyLimits) | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | `insuranceClaims` columns + RPCs |
| Financial calculation governance | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | `calculateRecovery` → `gateFinancial` → persisted decision (`financial_calculation` ALLOW) |
| Stripe billing (subscriptions/checkout/portal/webhook) | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | `stripe-checkout`, `stripe-portal`, `stripe-webhook` edge functions; `20260901_atlas_subscriptions` migrations; Pricing/Checkout pages; **not claim-payment related** |
| Accounting / QuickBooks | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | Catalog entry only (`connectors-registry.ts`: quickbooks "planned") |

### 2.10 Knowledge & governance

| Capability | E | C | P | G | T | PR | Evidence / trace |
|---|---|---:|---:|---:|---:|---:|---|
| Knowledge corpus (seed: 112 records, 8 federal regs, 31 workflow stages, 36 evidence reqs, 51 jurisdiction profiles, 5 standards, 21 risks, 16 revenue concepts) | ✅ | ✅ | ✅ | 🟡 | ✅ | 🟡 | `src/lib/knowledge/corpus/*`; `Atlas_U.S.md` (release 0.1.0); corpus tables `authoritativeSources`/`authoritativeKnowledge`/`impactAssessments` (20260826); `atlas_ingest_full_corpus.sql` |
| Jurisdiction profiles (50 states + DC) | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | ❌ | `corpus/jurisdictions.ts` — **explicitly PLACEHOLDER** per manifest warnings: "must not be represented as authoritative"; demoted to `general_ai_knowledge` in `knowledge-source.ts` |
| Authority hierarchy + temporal validity + supersession | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | `src/lib/governance/authority.ts` (`compareAuthority`, `filterEffectiveAt`, `selectRuleVersion`, `isWithinStatuteOfLimitations`), `types.ts` (`AUTHORITY_RANK`) |
| Governance gate (compliance decision: ALLOW / REVIEW_REQUIRED / BLOCK / UNKNOWN + risk) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | `governance-gate.ts`, `compliance.ts`; role-boundary matrix (26 action types) in `role-boundary.ts` |
| Governance persistence (decisions + immutable events + approval/override state machine) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | `governance_decisions` / `governance_events` (migration `20260904_atlas_governance.sql`); `src/lib/governance/persistence.ts`; RLS tenant-scoped; supersede-on-dedup; **invariant UNKNOWN ≠ ALLOW**; override only super_admin/atlas_admin |
| Governance UI (Governance page: pending + history + search/filter) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | `/dashboard/governance`; WorkQueue governance panel; ClaimDetail review panel |
| Role boundaries (legal_conclusion, engineering_determination, medical_determination, contract_execution, financial_commitment → PROHIBITED) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | `role-boundary.ts`; persisted as BLOCK when orchestrator evaluates them |
| Knowledge acquisition pipeline | 🟡 | ❌ | ❌ | ❌ | 🟡 | ❌ | `governance/types.ts` defines `PipelineStage`; `build_atlas_corpus.py` exists (offline builder); **no live acquisition/verification loop** — `impactAssessments` has no writer in the product path |

### 2.11 Voice / Ask Atlas / AI runtime

| Capability | E | C | P | G | T | PR | Evidence / trace |
|---|---|---:|---:|---:|---:|---:|---|
| Ask Atlas (typed conversational Q&A over tenant evidence) | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | `conversation-converse` edge function + local fallback `answerLocally` (`src/lib/ask/retrieval.ts`); `askSessions`/`askEvidence` tables |
| Gemini reasoning layer (optional, key-gated) | ✅ | ✅ | ❌ | 🟡 | ✅ | 🟡 | `conversation-converse/source/gemini.ts`: evidence-only context, hallucinated citation IDs dropped, schema validation, fallback to deterministic |
| Voice (STT/TTS, wake word, intent router, safety gates, voice bridge) | ✅ | ✅ | 🟡 | 🟡 | ✅ | 🟡 | `src/lib/voice-runtime/*` (65 Phase-7 tests), `VoiceSessionProvider` in `main.tsx`; conversation routed to same brain; NVIDIA NIM voice is early-access/unverified |

### 2.12 External systems / connectors

| Capability | E | C | P | G | T | PR | Evidence / trace |
|---|---|---:|---:|---:|---:|---:|---|
| Manual upload | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | `connectors-registry.ts` (manual_upload implemented) |
| Google Drive (OAuth, change detection, dedupe, sync) | ✅ | ✅ | ✅ | ❌ | ✅ | 🟡 | Only implemented connector (README); `connections-run-due-syncs` edge function; triggered on app load/OAuth (app-shell); scheduled cron **not enabled** |
| Gmail / Microsoft 365 / Slack / HubSpot / QuickBooks / Stripe (connector) / Dropbox / Notion / GitHub | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | Catalog entries only, `implementationStatus: "planned"` |
| Xactimate | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | **No integration.** Estimator explicitly "review-ready data for input into Xactimate" (disclaimer in `estimator.ts`, UI) |
| Insurance carrier portals | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | None |
| Weather / mapping / pricing data feeds | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | None |

---

## 3. Execution-path audit (who actually runs what)

**Live product execution paths (verified callers):**

```
Pages ──▶ useQuery/useMutation (src/hooks/use-supabase.ts) ──▶ api.* registry ──▶ RPCs / edge functions
ClaimDetail ──▶ insurance_get_claim_package · runClaimAnalysis (client analyzers + upsert_findings)
                · createSupplement · updateSupplementStatus · recordClaimPayment
                · useAtlasWorkflow → reviewClaim (governance-gated, persisted)
Revenue Recovery ──▶ listClaims · claimCounts · recoveryAnalytics · candidates approve/reject
Workers/Command Center ──▶ listClaims · claimCounts · candidates · trackDeadlines · buildWorkQueue
                · listActionableGovernance · generateEstimateLineItems · draftCommunication (draft only)
Governance page ──▶ listActionableGovernance · decideGovernanceDecision · listGovernanceDecisions
Ask Atlas / Voice ──▶ conversation-converse edge function (retrieval + optional Gemini)
Archive/Knowledge ──▶ archive actions · ingestion actions · runClaimDiscovery · documents/chunks/entities RPCs
PilotOutreach ──▶ outreach-send edge function (Resend) — the ONLY real send path, admin-gated, sales-only
MailInbox ──▶ email edge function (IMAP/SMTP) — user mailboxes
```

**Dead code / dormant subsystems (code + tests exist, no product caller):**

| Subsystem | Evidence of dormancy | Risk |
|---|---|---|
| Job engine + pipeline (`src/lib/jobs/*`) | No import of `@/lib/jobs` outside jobs itself; worker never started; `registerAgentPipeline` called only in tests | Agent execution, evidence pipeline, claim-review handler are **not running** |
| Agent runtime (`src/lib/agents/*`) | `executeAgent` only called from `jobs/agent-pipeline.ts`; in-memory human reviews never reach the RPC persistence path | The four agents exist as logic + tests only |
| AI runtime (`src/lib/ai-runtime/*`) | `runTask` only called from its own barrel; no UI/hook consumes it; pre-existing TS errors | Model routing/cost controls unused by the product |
| Workflow definitions `workflows/claim-review.ts`, `supplement-preparation.ts` | "no callers" (documented in GOVERNANCE_PERSISTENCE_AUDIT) | Duplicate definitions of the orchestrator's inline pipeline |
| `tools` namespace RPCs (`tools_list`, etc.) | MVP audit: not present in deployed schema; Actions page renders empty state | Tool execution surface is a shell |
| OCR | `OCR_AVAILABLE = false` | Scanned evidence cannot become text — a hard cap on claim reconstruction from scans |
| Impact assessments / knowledge acquisition | No product writer | Authority monitoring is schema + catalog only |

---

## 4. The six workers — capability verdicts (see ATLAS_REMAINING_ENGINEERING_ROADMAP.md for the scorecard)

| Worker | What is real today | What is missing to *complete the job* |
|---|---|---|
| **Claims Manager** | Claim intake (create/update/attach evidence), completeness model, findings, timeline, package, reconciliation, deadlines, governance-gated review, work queue | No claim state machine enforcement (16 statuses are advisory strings), no coverage context, no policy documents, no per-claim comm history, no persisted claim-analysis outputs (only findings), no autonomous intake (candidates need human approve) |
| **Supplement Specialist** | Opportunity detection, draft narrative + structured supplement doc + package HTML, governance-gated preparation, status lifecycle | No line-item reasoning, no pricing, no evidence-per-line-item chain, no original-estimate ingestion (estimates are a number + scope arrays), no submission path, no Xactimate |
| **Revenue Recovery Coordinator** | Financial aggregates, discrepancy detection, reconciliation, follow-up scheduling (in-memory), payment recording (total only) | No payment history, no expected-vs-received matching, no aging, no escalation state machine, no collections, no accounting integration |
| **Project Manager** | Deadline tracking (4 states), stale detection, work queue, daily briefing | **No projects**, no milestones, no scheduling, no dependencies, no assignments, no contractor/customer coordination, no project state machine |
| **Estimator** | Deterministic scope inference (damage-type rules), line-item candidates with statuses/confidence/evidence arrays, summary with disclaimer | No photos/measurements/field-notes input, no pricing source, no line-item evidence chain, no estimate persistence, no Xactimate, no licensed-review gate wired |
| **Customer Success Manager** | Overdue/update detection, governance-gated draft comms (8 types), follow-up scheduling | No customer records, no contact history, no send path, no appointments, no complaints/escalations, no satisfaction feedback |

---

## 5. Capability matrix (Phase 1 summary table)

| Capability | Exists | Connected | Persisted | Governed | Tested | Production-ready |
| ---------- | ------: | --------: | --------: | -------: | -----: | ---------------: |
| Archive ingestion (zip/rar) + dedupe | ✅ | ✅ | ✅ | 🟡 | ✅ | 🟡 |
| Document upload + chunking + embeddings | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| OCR | 🟡 | ❌ | ❌ | ❌ | 🟡 | ❌ |
| Classification | ✅ | ✅ | ✅ | ❌ | ✅ | 🟡 |
| Claim discovery/reconstruction (candidates) | ✅ | ✅ | ✅ | ❌ | ✅ | 🟡 |
| Entity resolution / knowledge graph | ✅ | ✅ | ✅ | ❌ | ✅ | 🟡 |
| Claim completeness + findings + reconciliation | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ |
| Contradiction detection | ✅ | ✅ | ❌ | 🟡 | ✅ | ✅ |
| Evidence requirements | ✅ | ✅ | ❌ | 🟡 | ✅ | 🟡 |
| Deadline tracking (4 jurisdictions) | ✅ | ✅ | ❌ | ❌ | ✅ | 🟡 |
| Work queue | ✅ | ✅ | ❌ | 🟡 | ✅ | 🟡 |
| Supplement lifecycle + package docs | ✅ | ✅ | ✅ | 🟡 | ✅ | 🟡 |
| Supplement line-item reasoning | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Carrier response tracking | 🟡 | 🟡 | 🟡 | ❌ | ❌ | ❌ |
| Payment recording | ✅ | ✅ | ✅ | ❌ | ✅ | 🟡 |
| Payment matching / aging / collections | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Projects / milestones / scheduling | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Communication drafting | ✅ | ✅ | ❌ | ✅ | ✅ | 🟡 |
| Communication sending (workers) | ❌ | ❌ | ❌ | 🟡 | ❌ | ❌ |
| CRM outreach send (Resend, pilot) | ✅ | ✅ | ✅ | 🟡 | ✅ | 🟡 |
| Mail (IMAP/SMTP user mailboxes) | ✅ | ✅ | ✅ | 🟡 | ✅ | 🟡 |
| Voice + Ask Atlas | ✅ | ✅ | ✅ | 🟡 | ✅ | 🟡 |
| Gemini reasoning (optional) | ✅ | ✅ | ❌ | 🟡 | ✅ | 🟡 |
| Agent runtime | ✅ | ❌ | ❌ | 🟡 | ✅ | ❌ |
| Job engine / pipelines | ✅ | ❌ | ✅ | ❌ | ✅ | ❌ |
| AI runtime / model routing | ✅ | ❌ | 🟡 | ❌ | ✅ | ❌ |
| Governance engine + persistence | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Role boundaries (PROHIBITED actions) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Knowledge corpus (seed) | ✅ | ✅ | ✅ | 🟡 | ✅ | 🟡 |
| Jurisdiction knowledge (51 profiles) | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | ❌ |
| Connectors (Drive) | ✅ | ✅ | ✅ | ❌ | ✅ | 🟡 |
| Xactimate / carrier portals / accounting | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

---

## 6. Bottom line

1. **The claims-and-revenue spine is real, wired, persisted, and tested.** Claims,
   findings, supplements, payments (as totals), recovery analytics, candidate
   discovery, evidence attachment, and a fully governed orchestrator all execute in
   the product today.
2. **Governance is the most mature layer** — the only capability consistently at
   "governed/tested" and persisted with an immutable audit trail, approval state
   machine, and the UNKNOWN ≠ ALLOW invariant.
3. **The six workers are dashboards over that spine, not employees.** Every worker
   page composes existing read services; only Estimator (line-item generation) and
   Customer Success (drafting) execute worker-specific logic, and neither can finish
   its job (no Xactimate; no send path).
4. **The automation layer (agents, jobs, AI runtime) is dormant.** It has the most
   code and the least connection: no production caller reaches `executeAgent`,
   `runTask`, or the job worker.
5. **Knowledge is seed-grade.** The 51 jurisdiction profiles are placeholders by
   the corpus's own manifest; the governance engine correctly demotes them. There is
   no authoritative, versioned, jurisdiction-verified knowledge in production.
6. **No external execution exists for any worker.** No Xactimate, no carrier
   portal, no worker communication send, no accounting — everything external stops
   at "prepared for human submission," honestly labeled.