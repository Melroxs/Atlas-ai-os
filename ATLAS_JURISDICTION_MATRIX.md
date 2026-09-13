# ATLAS — JURISDICTION MATRIX

> **Purpose.** Per-jurisdiction status of Atlas's knowledge for the categories that
> govern the six workers' work. This is a **status** matrix — it records where
> verified knowledge exists (nowhere yet), where placeholders exist (51 corpus
> profiles), and where nothing exists (territories, most topical categories).
>
> **Status legend:**
> - **VERIFIED** — a human-reviewed, dated, cited knowledge record exists in the
>   knowledge layer and passes the governance gate's authority resolution. **None
>   exist today.**
> - **PARTIAL** — some derived logic exists (e.g., deadline rules) but it is not
>   backed by verified knowledge records.
> - **PLACEHOLDER** — a corpus profile exists (51 profiles in
>   `src/lib/knowledge/corpus/jurisdictions.ts`) and is **explicitly demoted to
>   `general_ai_knowledge`** by `src/lib/governance/knowledge-source.ts`; it must
>   never be presented as authoritative.
> - **UNKNOWN** — no profile, no rules, nothing.
>
> **Categories tracked per jurisdiction:** REG = insurance regulation & claims
> handling · SOL = statutes of limitations/deadlines · LIC = adjuster/producer
> licensing · CON = contractor requirements · COD = construction codes & permits ·
> CUS = consumer protection · COMM = communication requirements · DIS = dispute
> resolution (appraisal/mediation) · DOC = documentation/retention · BND =
> professional boundaries (what only licensed humans may do).

## Federal

| Jurisdiction | REG | SOL | LIC | CON | COD | CUS | COMM | DIS | DOC | BND | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Federal | 🟡 | 🟡 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | 🟡 | **PLACEHOLDER** | 8 federal-regulation records in the seed corpus (`corpus/regulations.ts`); OSHA cited in source metadata; none human-verified |

## States + DC

All 50 states and DC currently have a **PLACEHOLDER** corpus profile (51 profiles,
release 0.1.0, `Atlas_U.S.md`: "State profiles intentionally identify missing
official research rather than inventing requirements"). The per-category status is
uniformly ❌/🟡 unless noted. Four states have **PARTIAL** derived deadline logic in
`src/lib/comms/deadline-tracker.ts` (`DEFAULT_JURISDICTION_RULES`).

| Jurisdiction | REG | SOL | LIC | CON | COD | CUS | COMM | DIS | DOC | BND | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Alabama | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Alaska | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Arizona | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Arkansas | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| California | ❌ | 🟡 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | **PARTIAL** | SOL/policy-period rule in `deadline-tracker.ts`; not statute-verified |
| Colorado | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Connecticut | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Delaware | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| District of Columbia | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | Corpus profile exists |
| Florida | ❌ | 🟡 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | **PARTIAL** | SOL rule in `deadline-tracker.ts`; not statute-verified |
| Georgia | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Hawaii | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Idaho | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Illinois | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Indiana | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Iowa | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Kansas | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Kentucky | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Louisiana | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Maine | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Maryland | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Massachusetts | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Michigan | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Minnesota | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Mississippi | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Missouri | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Montana | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Nebraska | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Nevada | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| New Hampshire | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| New Jersey | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| New Mexico | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| New York | ❌ | 🟡 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | **PARTIAL** | SOL rule in `deadline-tracker.ts`; not statute-verified |
| North Carolina | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| North Dakota | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Ohio | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Oklahoma | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Oregon | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Pennsylvania | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Rhode Island | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| South Carolina | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| South Dakota | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Tennessee | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Texas | ❌ | 🟡 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | **PARTIAL** | SOL rule in `deadline-tracker.ts`; not statute-verified |
| Utah | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Vermont | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Virginia | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Washington | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| West Virginia | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Wisconsin | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |
| Wyoming | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | PLACEHOLDER | |

## Territories

| Jurisdiction | All categories | Status | Notes |
|---|---|---|---|
| Puerto Rico | ❌ | **UNKNOWN** | No profile in corpus |
| Guam | ❌ | **UNKNOWN** | No profile |
| U.S. Virgin Islands | ❌ | **UNKNOWN** | No profile |
| American Samoa | ❌ | **UNKNOWN** | No profile |
| Northern Mariana Islands | ❌ | **UNKNOWN** | No profile |

## What the matrix means operationally

1. **No jurisdiction is actionable today.** Any governance evaluation that depends
   on jurisdiction-specific law resolves to placeholder → `general_ai_knowledge` →
   correctly non-authoritative, or to `UNKNOWN` → BLOCK/REVIEW_REQUIRED.
2. **The four PARTIAL states are still not safe.** The TX/FL/CA/NY deadline rules
   are heuristic constants, not verified statute records with effective dates.
   Until each is replaced by a verified `applicable_law` record, the deadline engine
   must keep labeling them as non-authoritative (they currently have no citation —
   a gap that must be closed before deadlines drive external actions).
3. **The acquisition order** (from `ATLAS_LEARNING_MATERIAL_PLAN.md`) should start
   with the states in which the company actually operates (tenant operating
   geography — `companyProfiles.operatingGeography`, `operatingLocations.jurisdiction`
   already exist in the schema), not all 50.
4. **Never convert a placeholder into authoritative knowledge.** The demotion in
   `knowledge-source.ts` is the enforcement point; it must remain independent of the
   AI model and the UI.