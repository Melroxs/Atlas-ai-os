# ATLAS — LEARNING MATERIAL PLAN

> **Purpose.** A structured **acquisition list** — not a list of ingested knowledge.
> Nothing below is claimed to be ingested or verified; every row names the topic,
> why Atlas needs it, which workers use it, the authority tier, the source type, the
> authoritative source to acquire from, and the ingestion/verification requirements.
> Per the absolute rules: **never fabricate regulatory knowledge** — this plan only
> directs acquisition; every acquired record must then pass the human verification
> gate and carry the full provenance metadata from
> `ATLAS_KNOWLEDGE_REQUIREMENTS_MATRIX.md`.

Columns: TOPIC · WHY ATLAS NEEDS IT · WORKER(S) · AUTHORITY LEVEL · SOURCE TYPE ·
AUTHORITATIVE SOURCE TO ACQUIRE · JURISDICTION · TIME VALIDITY · INGESTION METHOD ·
STRUCTURED DATA NEEDED · HUMAN REVIEW REQUIRED · TESTS REQUIRED

Legend — workers: CM=Claims Manager, SS=Supplement Specialist, RR=Revenue Recovery,
PM=Project Manager, ES=Estimator, CS=Customer Success.

---

## 1. Insurance regulation

| TOPIC | WHY | W | AUTH | SOURCE TYPE | SOURCE TO ACQUIRE | JUR | TIME | INGEST | STRUCTURED | HUMAN | TESTS |
|---|---|---|---|---|---|---|---|---|---|---|---|
| State insurance codes (claims handling chapters) | Legal basis for claim-handling obligations | CM, SS | Tier 1 | Statute | Each state's official legislature site (e.g., state legislature statutes portal) — acquire per state via the jurisdiction matrix | 50 states + DC | Annual refresh; check after each legislative session | Curated ingest (not automated crawl) with citation capture | Statute number, section, effective date, obligation text, deadline | Yes — every record verified by a human reviewer before `verified` status | Deadlines tests per state; authority-order tests |
| Unfair claims settlement practices acts | Detect carrier conduct issues and response deadlines | CM, SS | Tier 1 | Statute | Same as above (state-specific chapter) | 50 states + DC | Annual | Curated ingest | Prohibited-practice list, response deadlines, penalties | Yes | Compliance-gate tests: carrier-response deadline derivation |
| Adjuster licensing (staff/public) | Know who may legally perform which claim function | CM, SS | Tier 1 | Statute + regulator | State DOI (official site) | 50 states + DC | Annual; check CE/ renewal cycles | Curated ingest | License classes, reciprocity, exemptions, CE requirements | Yes | Role-boundary tests: licensing preconditions |
| Producer licensing | Only if Atlas work touches sales | CM | Tier 1 | Statute + regulator | State DOI | As needed | Annual | Curated | License classes | Yes | Boundary tests |
| Appraisal / mediation provisions | Dispute-resolution paths for supplements | SS, RR | Tier 1–2 | Statute + DOI guidance | State insurance code appraisal clause + state DOI dispute pages | 50 states + DC | Annual | Curated | Trigger conditions, timelines, process | Yes | Workflow tests: appraisal trigger |
| Complaint handling requirements | Regulatory complaint expectations | CS | Tier 1–2 | Statute + DOI | State DOI complaint guidance | 50 states + DC | Annual | Curated | Response timelines, required records | Yes | Comms-gate tests |
| Communication requirements | What must be written, by when | CM, CS | Tier 1–2 | Statute + DOI guidance | State DOI bulletins + claim-handling regs | 50 states + DC | Annual | Curated | Notice types, deadlines, content requirements | Yes | Draft-validation tests |
| Document retention requirements | Retention of claim/correspondence records | CM, RR | Tier 1–2 | Statute + DOI | State DOI recordkeeping guidance | 50 states + DC | Annual | Curated | Record classes, retention periods | Yes | Data-model tests (retention field) |
| Statutes of limitations (contract/suit) | Deadline engine correctness | CM, PM | Tier 1 | Statute | State code (civil procedure / contracts) — extend the 4 rules in `deadline-tracker.ts` to all states | 50 states + DC | Annual; check tort-reform changes | Curated + test-verified | SOL years per claim type, trigger events, extensions | Yes | Per-state deadline tests (critical — deadlines drive actions) |

## 2. Property restoration

| TOPIC | WHY | W | AUTH | SOURCE TYPE | SOURCE TO ACQUIRE | JUR | TIME | INGEST | STRUCTURED | HUMAN | TESTS |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Water damage restoration standard (IICRC S500) | Defines defensible mitigation scope | SS, ES, PM | Tier 4 | Industry standard (licensed) | IICRC (official publisher) — licensed copy, citation-only ingestion | National | Check edition | Licensed extract of key requirements only (no wholesale reproduction) | Category coverage, drying criteria, documentation steps | Yes | Scope-reasoning tests |
| Fire/smoke restoration (IICRC S540) | Fire scope reconstruction | SS, ES, PM | Tier 4 | Industry standard | IICRC | National | Check edition | Licensed extract | Categories, process, documentation | Yes | Scope-reasoning tests |
| Mold remediation (IICRC S520 / EPA guidance) | Mold scope + safety | SS, ES, PM | Tier 4 | Standard + federal guidance | IICRC; EPA mold guidance (official) | National | Check edition | Licensed extract + EPA public docs | Containment classes, documentation | Yes | Boundary tests (remediation is not medical/engineering) |
| Roofing practice (NRCA / manufacturer specs) | Roofing scope | ES, SS | Tier 4 | Industry association | NRCA (official) + manufacturer installation specs | National | Check edition | Curated | Component lists, failure modes, documentation | Yes | Line-item tests |
| Storm damage documentation practice | Evidence standards for storm claims | CM, SS | Tier 4 | Industry practice | Industry standards orgs (e.g., IA path AIC) | National | Rolling | Curated | Evidence checklist per loss type | Yes | Evidence-requirements tests |
| OSHA construction safety (29 CFR 1926) | Safety obligations + documentation | PM, ES | Tier 1 | Federal regulation | OSHA eCFR (official) | Federal | Rolling | Public ingest | Fall protection, PPE, documentation | Yes | Reference-only tests (no action advice from Atlas) |

## 3. Estimating

| TOPIC | WHY | W | AUTH | SOURCE TYPE | SOURCE TO ACQUIRE | JUR | TIME | INGEST | STRUCTURED | HUMAN | TESTS |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Estimating methodology (line items, units, waste, access) | Line-item construction rules | ES, SS | Tier 4 | Industry standard | Estimating standards org (e.g., Xactware documentation via licensed access) | National | Rolling | Curated methodology only (never reproduce pricing) | Line-item taxonomy, unit conventions, waste/access factors | Yes | Line-item generator tests |
| Pricing databases (Xactimate / RSMeans-type) | Defensible pricing | ES | Tier 3/4 | Licensed pricing data | Vendor (Xactimate API / RSMeans license) — **integration, not copy** | National/regional | Subscription | API or licensed feed | Price per line code per region, effective dates | Yes (rates) | Pricing-resolution tests |
| Measurement standards | Quantity accuracy | ES | Tier 4 | Industry standard | Estimating standards + construction measurement practice | National | Rolling | Curated | Unit-of-measure rules per component | Yes | Quantity tests |
| Code-related requirements | Code-upgrade scope | ES, SS | Tier 1/4 | Adopted code + amendments | State/local adopted code editions (official) | Per jurisdiction | Code edition cycle | Curated per jurisdiction | Adopted edition, amendments, effective dates | Yes | Jurisdiction-code tests |

## 4. Construction & jurisdiction

| TOPIC | WHY | W | AUTH | SOURCE TYPE | SOURCE TO ACQUIRE | JUR | TIME | INGEST | STRUCTURED | HUMAN | TESTS |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Adopted building codes | Permit/scope rules | ES, PM | Tier 1 | Code | State/local code adoption records (official) | Per jurisdiction | Code cycle | Curated | Adopted edition + amendments | Yes | Jurisdiction matrix tests |
| Permit requirements | PM milestone logic | PM | Tier 1–2 | Regulation + local | Local building departments (official) | Per locality | Rolling | Curated | Permit types, thresholds, timelines | Yes | PM milestone tests |
| Trade licensing | Contractor boundary | PM, ES | Tier 1 | Statute + regulator | State contractor license boards (official) | Per state | Annual | Curated | License classes, work scopes, bonding | Yes | Boundary tests |

## 5. Financial recovery

| TOPIC | WHY | W | AUTH | SOURCE TYPE | SOURCE TO ACQUIRE | JUR | TIME | INGEST | STRUCTURED | HUMAN | TESTS |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Payment reconciliation practice | Expected-vs-received model | RR | Tier 4/5 | Industry + company | Industry practice docs + company SOP | National/company | Rolling | Curated | Event taxonomy (request/approve/pay/deny) | Yes | Ledger tests |
| Supplement accounting conventions | Correct financial fields | SS, RR | Tier 4/5 | Industry + company | Company SOP + industry guidance | Company | Rolling | Curated | Amount semantics per status | Yes | Reconciliation tests |
| Collections constraints (FDCPA-type limits on contractors, state rules) | Legal boundary on collections | RR | Tier 1 | Statute + federal | Federal statute (official) + state debt-collection statutes | Federal + states | Rolling | Curated | Prohibited practices, timing | Yes | Boundary tests |
| Invoice documentation standards | Billable documentation | RR | Tier 4 | Industry | Industry practice | National | Rolling | Curated | Required invoice fields | Yes | Invoice tests |

## 6. Customer communication

| TOPIC | WHY | W | AUTH | SOURCE TYPE | SOURCE TO ACQUIRE | JUR | TIME | INGEST | STRUCTURED | HUMAN | TESTS |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Privacy / consent rules (state privacy + TCPA-type contact rules) | Contact legality | CS | Tier 1 | Statute + federal | Federal statute (official) + state privacy statutes | Federal + states | Rolling | Curated | Consent requirements, opt-out, timing | Yes | Comms-gate tests |
| Communication standards | What/when to communicate | CS | Tier 5 | Company SOP | Company policy (tenant-scoped) | Company | Rolling | Curated | Message types, cadence, tone | Yes | Draft tests |
| Customer interaction recordkeeping | Auditability of contact | CS | Tier 1/5 | Company + statute | Company SOP + retention rules | Company | Rolling | Curated | Contact log schema | Yes | Audit tests |

## 7. Company-specific (Tier 5 — tenant-scoped)

| TOPIC | WHY | W | AUTH | SOURCE TYPE | SOURCE TO ACQUIRE | JUR | TIME | INGEST | STRUCTURED | HUMAN | TESTS |
|---|---|---|---|---|---|---|---|---|---|---|---|
| SOPs (claim handling, supplement prep, billing) | Operational ground truth | All | Tier 5 | Company docs | Company owner/admin (via a guided SOP questionnaire, tenant-scoped table) | Company | Rolling | Curated import | Step sequences, owners, evidence per step | Yes | Workflow tests per SOP |
| Pricing rules / approval limits | Financial authority | All | Tier 5 | Company docs | Company admin | Company | Rolling | Curated | Approval thresholds per role/amount | Yes | Gate tests (amount-threshold REVIEW_REQUIRED) |
| Escalation policies | When to escalate | All | Tier 5 | Company docs | Company admin | Company | Rolling | Curated | Escalation matrix (condition → owner → SLA) | Yes | Escalation tests |
| Communication policies | Tone/consent | CS | Tier 5 | Company docs | Company admin | Company | Rolling | Curated | Allowed channels, approval flow | Yes | Comms tests |

## 8. General knowledge (Tier 6 — bounded, never authoritative)

| TOPIC | WHY | W | AUTH | SOURCE TYPE | SOURCE TO ACQUIRE | JUR | TIME | INGEST | STRUCTURED | HUMAN | TESTS |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Restoration industry terminology | Shared vocabulary | All | Tier 6 | Reference | Existing corpus terminology records (already present) | National | Static | Existing | Terms + definitions | Review once | Retrieval tests |
| Claims lifecycle background | Conversation grounding | All | Tier 6 | Reference | Existing corpus (31 workflow stages present) | National | Static | Existing | Stage definitions | Review once | Retrieval tests |

---

## Ingestion pipeline requirements (what must exist before acquisition starts)

1. **Curated-ingest UI / import path** — a human-authorized way to add a verified
   knowledge record with full metadata (the schema exists in
   `authoritativeKnowledge`; the tooling does not).
2. **Review workflow** — each record starts `unverified` and requires a human
   reviewer to flip it to `verified` (pattern already exists conceptually in
   `impactAssessments.requiresHumanReview`).
3. **Versioning** — `effectiveDate` / `expirationDate` / `version` /
   `supersedesId` enforcement via `selectRuleVersion` (already implemented in
   `src/lib/governance/authority.ts`).
4. **Refresh cadence** — monthly URL/source-version checks for federal sources,
   quarterly state-profile refresh, immediate review on statutory/regulatory/
   code-edition/disaster change (from `Atlas_U.S.md`).
5. **License discipline** — pricing/standards content is integrated by reference
   (API/licensed feed) or cited, never copied (already stated in the corpus release).

## What must NOT happen during acquisition

- Automated crawls marking records `verified` without human review.
- Treating NAIC model acts as enacted law (corpus already avoids this).
- Copying Xactimate/pricing content into the corpus.
- Any record reaching the governance `applicableRules` path with
  `verificationStatus: "placeholder"`.