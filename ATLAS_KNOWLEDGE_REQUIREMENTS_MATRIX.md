# ATLAS — KNOWLEDGE REQUIREMENTS MATRIX

> **Purpose.** Define, for every worker, the knowledge Atlas needs to complete the
> job — classified into six authority tiers. This is a **requirements** matrix: it
> lists what knowledge objects Atlas must eventually hold, the tier each belongs in,
> and the metadata every knowledge record must carry (mirroring the existing
> `KnowledgeObject` shape in `src/lib/governance/types.ts` and the
> `authoritativeKnowledge` table from migration `20260826_atlas_knowledge_layer.sql`).
>
> **Truth constraint:** Atlas's own seed corpus (`src/lib/knowledge/corpus/`,
> `Atlas_U.S.md`) is 112 records, of which the 51 jurisdiction profiles are
> **placeholders** and are demoted to `general_ai_knowledge` by
> `src/lib/governance/knowledge-source.ts` (never authoritative). Nothing in this
> matrix converts a placeholder into knowledge — the matrix is the acquisition plan.

## Tier definitions (matching `AuthorityLevel` in `governance/types.ts`)

| Tier | Class | AuthorityLevel mapping | Example |
|---|---|---|---|
| Tier 1 | Authoritative law/regulation | `applicable_law`, `binding_regulation` | State insurance codes, unfair-claims-practices statutes, licensing statutes, SOL statutes |
| Tier 2 | Government/regulator guidance | `official_regulator_guidance`, `official_court_authority` | State DOI bulletins, NAIC model acts (as model only), federal agency guidance |
| Tier 3 | Contractual/policy knowledge | `insurance_policy_language`, `carrier_specific_procedure` | Actual policy forms, carrier manuals, contractor agreements, customer contracts |
| Tier 4 | Industry standards | `industry_standard`, `official_building_code_authority` | IICRC S500/S520, ANSI standards, adopted building codes, estimating methodology |
| Tier 5 | Company-specific | `company_sop` | SOPs, pricing rules, approval limits, escalation policies, communication policies |
| Tier 6 | General knowledge | `historical_practice`, `general_ai_knowledge` | Background understanding — **must never outrank tiers 1–5** |

## Required metadata per knowledge record

```text
source           — canonical source name + URL (sourceName/sourceUrl)
authority level  — one of the 11 AuthorityLevel values (never inferred from wording)
jurisdiction     — federal / state / county / municipality / territory
effective date   — effectiveFrom (epoch ms)
expiration date  — effectiveTo (or null)
version          — source version (statute edition, code edition, bulletin number)
applicability    — workflow/action/role applicability list
citation         — statute/regulation/standard citation string
provenance       — retrieval date + method + who reviewed (verifiedAt, reviewStatus)
review status    — unverified / verified / stale / superseded / conflicted / retired
```

The schema for this already exists (`KnowledgeObject` + `authoritativeKnowledge`
columns: `publicationDate`, `retrievalDate`, `effectiveDate`, `expirationDate`,
`version`, `contentHash`, `normalizedFact`, `freshness`, `supersedesId`,
`supersededById`, `reviewStatus`, `confidence`). What is missing is **populated,
verified records**.

---

## MATRIX — by worker × knowledge need

Legend: **W** = Worker(s) · **Tier** = required tier · **Cur** = current state
(HAVE / PLACEHOLDER / MISSING).

### A. Insurance regulation (Claims Manager, Supplement Specialist, Revenue Recovery)

| Knowledge need | W | Tier | Cur | Notes |
|---|---|---|---|---|
| State insurance codes (per jurisdiction) | CM, SS | 1 | PLACEHOLDER | Corpus has 8 federal regs only; state statutes not ingested |
| Unfair claims practices / trade practices acts | CM, SS | 1 | PLACEHOLDER | Needed to judge carrier conduct and response obligations |
| Claim-handling requirements (acknowledgment, investigation timelines) | CM | 1–2 | PLACEHOLDER | State-specific deadlines |
| Adjuster licensing (staff/public) | CM, SS | 1 | PLACEHOLDER | Determines who may perform which claim functions |
| Producer licensing (where relevant) | CM | 1 | MISSING | Only if Atlas work touches sales |
| Appraisal / mediation requirements | SS, RR | 1–2 | MISSING | Dispute clauses and state appraisal law |
| Complaint handling requirements | CS | 1–2 | MISSING | State DOI complaint expectations |
| Communication requirements (written notice, acknowledgment) | CS, CM | 1–2 | MISSING | What must be in writing, by when |
| Document retention requirements | CM, RR | 1–2 | MISSING | Retention periods per record type |
| Statute of limitations / suit deadlines | CM, PM | 1 | PARTIAL | `deadline-tracker.ts` has TX/FL/CA/NY + Default only |

### B. Property restoration (all workers)

| Knowledge need | W | Tier | Cur |
|---|---|---|---|
| Restoration standards — water (IICRC S500), fire/smoke (S540), mold (S520) | SS, ES, PM | 4 | MISSING (standards metadata only, 5 entries) |
| Remediation practice and documentation | SS, ES, PM | 4 | MISSING |
| Roofing / storm damage practice | SS, ES | 4 | PLACEHOLDER |
| Safety (OSHA, fall protection) | PM, ES | 1–4 | MISSING (OSHA cited in corpus source metadata only) |
| Damage documentation practice | CM, SS, ES | 4 | PARTIAL (evidence categories + 36 doc types) |

### C. Estimating (Estimator, Supplement Specialist)

| Knowledge need | W | Tier | Cur |
|---|---|---|---|
| Estimating methodology (line items, units, waste, access) | ES, SS | 4 | PLACEHOLDER (revenue concepts corpus) |
| Pricing databases (Xactimate line codes, RSMeans-style) | ES | 4/3 | MISSING — **licensing required; cannot be reproduced** |
| Line-item conventions and documentation standards | ES, SS | 4 | MISSING |
| Measurement standards (roof squares, linear feet) | ES | 4 | MISSING |
| Code-related requirements (code upgrades, permit scope) | ES, SS | 1/4 | MISSING |

### D. Construction / jurisdiction (Project Manager, Estimator)

| Knowledge need | W | Tier | Cur |
|---|---|---|---|
| Applicable building codes (adopted edition per jurisdiction) | ES, PM | 1/4 | PLACEHOLDER |
| Permit requirements and jurisdictions | PM | 1–2 | MISSING |
| Trade requirements (licensing per trade) | PM, ES | 1 | MISSING |
| Wind/storm rating zones (IBHS/state maps) | ES, PM | 2/4 | MISSING |

### E. Financial recovery (Revenue Recovery, Supplement Specialist)

| Knowledge need | W | Tier | Cur |
|---|---|---|---|
| Payment reconciliation practice | RR | 4–5 | PARTIAL (revenue concepts) |
| Supplement accounting (requested/approved/denied/paid) | RR, SS | 4–5 | PARTIAL |
| Collections practice and consumer-protection constraints (FDCPA-style limits on contractor collections) | RR | 1/4 | MISSING |
| Invoice documentation standards | RR | 4 | MISSING |
| Carrier payment timing norms | RR | 5 | MISSING (company-specific) |

### F. Customer communication (Customer Success)

| Knowledge need | W | Tier | Cur |
|---|---|---|---|
| Privacy/consent (state privacy law, TCPA-style contact rules) | CS | 1 | MISSING |
| Communication standards (what/when to communicate) | CS | 5 | MISSING (company SOP) |
| Recordkeeping for customer interactions | CS | 1/5 | MISSING |
| Escalation standards | CS | 5 | MISSING |

### G. Company-specific (all workers — Tier 5, tenant-scoped)

| Knowledge need | Tier | Cur |
|---|---|---|
| SOPs (claim handling, supplement prep, billing) | 5 | MISSING — no table; `companyProfiles`/`companySystems` exist but hold no SOP content |
| Pricing rules and approval limits | 5 | MISSING |
| Escalation policies | 5 | MISSING |
| Communication policies and tone | 5 | PARTIAL (draft tones: formal/professional/friendly/urgent) |

### H. General knowledge (Tier 6 — never authoritative)

| Knowledge need | Cur |
|---|---|
| Restoration-industry background | PLACEHOLDER — present in corpus, demoted automatically |
| Claims terminology | HAVE — corpus terminology records |
| Historical practice | PARTIAL — `historical_practice` authority level exists |

---

## Knowledge-object counts the matrix implies (target vs current)

| Class | Target (verified records) | Current |
|---|---|---:|
| Tier 1 state statutes/regulations (50+ states × ~8 topics) | 400+ | 0 (8 federal only) |
| Tier 2 regulator guidance | 100+ | 0 |
| Tier 3 policy/carrier/contract (tenant-scoped, not global) | per-tenant | 0 |
| Tier 4 standards | ~20 | 5 metadata entries |
| Tier 5 company SOP | per-tenant | 0 |
| Tier 6 general | bounded | present, demoted |

## Non-negotiable rules (carried from the corpus manifest + governance engine)

1. **PLACEHOLDER ≠ knowledge.** Every placeholder record carries
   `verificationStatus: "placeholder"` and is demoted to `general_ai_knowledge` —
   this is already implemented and must survive all future phases.
2. **Knowledge acquisition is separate from knowledge authorization.** Ingesting a
   statute is not authorization to act on it; authorization happens through the
   governance gate with a `reviewStatus` transition.
3. **Effective dates rule.** `filterEffectiveAt` + `selectRuleVersion` in
   `src/lib/governance/authority.ts` already implement version selection at
   evaluation time — populated records must supply real dates or they are excluded.
4. **Tenant scoping.** Tiers 3 and 5 are tenant-specific; the global corpus must
   never leak one company's SOP/policy into another tenant's decisions (RLS already
   protects tables; the knowledge layer must preserve that boundary).
5. **No copyrighted pricing content.** Xactimate/pricing-database content must be
   referenced by citation, never reproduced (the corpus release already states
   this).