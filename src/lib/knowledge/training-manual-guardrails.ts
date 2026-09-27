// ---------------------------------------------------------------------------
// Atlas Knowledge Layer — training-manual guardrails
//
// Enforcement, not documentation.
//
// The knowledge layer's safety properties are only real if they are enforced
// in code at the point where items are created and returned. This module is
// that enforcement point for the Christian Construction Insurance Education
// Manual, and it is deliberately usable without the document: it validates
// any item claiming that provenance, whether or not the manual has been read.
//
// Four properties are enforced:
//
//   1. PAGE-LEVEL PROVENANCE — an item citing a paged document without a
//      page/section locator is rejected, because "the manual says" with no
//      page is an unverifiable citation.
//   2. TEMPORAL SCOPE — items default to `historical_context` and cannot be
//      served as current, so 2020-2021 statistics are never restated as
//      today's market.
//   3. AUTHORITY FLOOR — the manual cannot outrank policy, code, manufacturer
//      documentation or verified evidence, and cannot answer coverage or
//      legal questions at all.
//   4. INTEGRITY — items modelling prohibited practices are rejected, and
//      proposals can never be presented as confirmed findings.
// ---------------------------------------------------------------------------

import type {
  KnowledgeItem,
  KnowledgeRetrievalResult,
  SourceClassification,
  TemporalScope,
} from "./types";
import {
  CONDITION_CLASSIFICATIONS,
  CONTENT_INGESTED,
  COVERAGE_DETERMINATION_REFUSAL as COVERAGE_REFUSAL_TEXT,
  EVIDENCE_STATUSES,
  FACT_PRESENTING_STATUSES,
  OBSERVATION_LAYERS,
  OPERATIONAL_PRINCIPLE,
  PROHIBITED_PRACTICES,
  REGULATED_BOUNDARY_TOPICS,
  TRAINING_MANUAL_MAX_PRIORITY_RANK,
  TRAINING_MANUAL_SOURCE_ID,
  TRAINING_MANUAL_TAGS,
  isTrainingManualClassification,
} from "./training-manual";

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export type GuardrailSeverity = "error" | "warning";

export interface GuardrailViolation {
  rule:
    | "missing_locator"
    | "missing_temporal_scope"
    | "historical_tag_missing"
    | "prohibited_practice"
    | "legal_authority_claim"
    | "coverage_determination"
    | "invalid_evidence_status"
    | "proposed_presented_as_fact"
    | "unknown_source";
  severity: GuardrailSeverity;
  message: string;
}

export interface GuardrailResult {
  valid: boolean;
  violations: GuardrailViolation[];
  /** Value the item should be coerced to, when the rule is recoverable. */
  coerced?: { temporalScope?: TemporalScope; tags?: string[] };
}

function ok(violations: GuardrailViolation[]): GuardrailResult {
  return { valid: !violations.some((v) => v.severity === "error"), violations };
}

// ---------------------------------------------------------------------------
// Phrase detectors
// ---------------------------------------------------------------------------

/**
 * Phrases that assert a current legal, regulatory, coverage or carrier
 * requirement. A training manual is never the authority for any of these.
 */
const LEGAL_AUTHORITY_PATTERNS: readonly RegExp[] = [
  /\b(is|are|will be) (covered|not covered)\b/i,
  /\bcoverage (is|will be) (determined|approved|denied)\b/i,
  /\bmust (comply|follow) (with )?(the )?law\b/i,
  /\b(required|required by) (by )?(law|statute|regulation|code)\b/i,
  /\bthe law requires\b/i,
  /\bcarrier (requires|will require|mandates)\b/i,
  /\binsurer (will|shall) pay\b/i,
  /\bis legally required\b/i,
  /\bunder (the )?current (law|regulation|code)\b/i,
  /\bpolicy (guarantees|entitles)\b/i,
];

const COVERAGE_DETERMINATION_PATTERNS: readonly RegExp[] = [
  /\bwill (the )?(insurer|carrier) (cover|pay|approve)\b/i,
  /\bshould (i|we) (claim|report) (this|it)\b/i,
  /\bis this (covered|claimable|eligible)\b/i,
  /\bwhat will (the )?(insurer|carrier) (pay|approve|do)\b/i,
  /\bdo i have a (valid )?claim\b/i,
];

/**
 * Substrings indicating manipulative or fraudulent framing. Matched against
 * normalized text so that legitimate *warnings* about these practices are not
 * themselves blocked — see `isProhibitedPracticeText` for that distinction.
 */
const PROHIBITED_PRACTICE_PATTERNS: readonly RegExp[] = [
  /\binflate (the |a |some )?(quantity|quantities|scope|estimate|line items?)\b/i,
  /\b(add|adding|included?|include)\b[^.]{0,40}\b(to increase|to raise|to boost|to maximize)\b[^.]{0,30}\b(claim|estimate|total|scope|value|payout)\b/i,
  /\bpad(ding)? the (estimate|scope|claim)\b/i,
  /\bbump (up )?the (estimate|claim|scope)\b/i,
  /\binvent(s|ed|ing)?\s+(a|an|the|some)?\s*(damage|measurement|measurements|photograph|photographs|photo|photos|labor|labour|material|materials|code requirement|code requirements|evidence|support|documentation|photo evidence)\b/i,
  /\bfabricat(e|ed|ing) (evidence|photograph|photo|measurement|damage|support|documentation)\b/i,
  /\bcreate (a )?false (damage|damage narrative|evidence)\b/i,
  /\bhide (the )?discrepanc/i,
  /\bconceal (the )?discrepanc/i,
  /\bunderstate the (damage|scope)\b/i,
  /\bmisrepresent (the )?(condition|damage|scope|claim)\b/i,
  /\bpressure the adjuster\b/i,
  /\bintimidate the adjuster\b/i,
  /\bwork around the policy exclusion\b/i,
  /\bcircumvent (the )?policy exclusion/i,
  /\bcharge the homeowner (for )?the deductible (and )?keep\b/i,
  /\bwaive the deductible (and )?(reimburse|charge)\b/i,
  /\bdifferent invoice(s)? to different (parties|people|insurers?)\b/i,
  /\bcollect (the )?insurance (money|proceeds) (without|before) (completing|doing) the work\b/i,
  /\bfalse testimony\b/i,
  /\bexaggerate (the )?damage\b/i,
];

/**
 * Words that signal a legitimate ethics *warning* rather than an instruction
 * to commit the act. A sentence that forbids a practice is safe to index; a
 * sentence that recommends one is not.
 */
const PROHIBITION_CUES: readonly RegExp[] = [
  /\b(never|do not|don'?t|must not|should not|shall not|avoid|refuse|unethical|illegal|prohibited|not allowed|is a violation|is fraud|penalized|discipline)\b/i,
  /\b(ethical|ethics|integrity|integrity standards)\b/i,
];

/** Words that mark a sentence as descriptive/educational rather than directive. */
const DESCRIPTIVE_CUES: readonly RegExp[] = [
  /\b(commonly|typically|often|may|might|can|warns|warn|cautions|avoid|avoidance|is a common|are common|red flag|warning sign|scam|fraudulent|unscrupulous)\b/i,
  /\b(do not|don'?t|never|avoid|refuse|unethical|illegal|prohibited)\b/i,
];

export function containsAnyPattern(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

// ---------------------------------------------------------------------------
// Rule 1 + 2 + 4: item validation
// ---------------------------------------------------------------------------

export interface ValidateItemOptions {
  /**
   * Treat the item as originating from this manual. Defaults to inference
   * from `sourceClassification` and `sourceId`.
   */
  assumeTrainingManual?: boolean;
}

/**
 * Validate a knowledge item claimed to originate from the training manual.
 *
 * Recoverable problems are reported as warnings and surfaced through
 * `coerced`, so a caller can safely accept the item with the value fixed
 * rather than silently dropping it. Unrecoverable problems are errors.
 */
export function validateTrainingManualItem(
  item: KnowledgeItem,
  options: ValidateItemOptions = {},
): GuardrailResult {
  const violations: GuardrailViolation[] = [];

  const isManual =
    options.assumeTrainingManual === true ||
    isTrainingManualClassification(item.sourceClassification) ||
    item.sourceId === TRAINING_MANUAL_SOURCE_ID;

  if (!isManual) {
    violations.push({
      rule: "unknown_source",
      severity: "warning",
      message: "Item is not from the training manual; manual-specific rules were not applied.",
    });
    return ok(violations);
  }

  // -- Rule: page-level provenance -----------------------------------------
  const hasLocator =
    Boolean(item.locator?.page) ||
    (typeof item.locator?.section === "string" && item.locator.section.trim().length > 0);

  if (!hasLocator) {
    violations.push({
      rule: "missing_locator",
      severity: "error",
      message:
        "An item citing the training manual must carry a page number or section so the citation can be verified against the source document.",
    });
  }

  // -- Rule: temporal scope ------------------------------------------------
  const temporalScope = item.temporalScope;
  if (!temporalScope) {
    violations.push({
      rule: "missing_temporal_scope",
      severity: "warning",
      message:
        "No temporal scope set. Training-manual items default to historical_context because the manual's statistics are associated with 2020-2021.",
    });
  } else if (temporalScope !== "current" && temporalScope !== "historical_context") {
    violations.push({
      rule: "missing_temporal_scope",
      severity: "error",
      message: `Unknown temporal scope: ${String(temporalScope)}.`,
    });
  }

  // Anything from the manual that asserts a current fact needs to be able to
  // justify it. Unmarked items are treated as historical.
  const effectiveScope: TemporalScope = temporalScope ?? "historical_context";

  const tags = item.tags ?? [];
  if (effectiveScope === "historical_context" && !tags.includes("historical-2020-2021")) {
    violations.push({
      rule: "historical_tag_missing",
      severity: "warning",
      message:
        'Historical-scope item should carry the "historical-2020-2021" tag so it is filterable and never restated as a current statistic.',
    });
  }

  // -- Rule: prohibited practices ------------------------------------------
  const statementText = `${item.title} ${item.statement} ${item.interpretation ?? ""}`;
  if (isProhibitedPracticeText(statementText)) {
    violations.push({
      rule: "prohibited_practice",
      severity: "error",
      message:
        "Text models a prohibited claim-manipulation practice. Training sources must strengthen integrity controls, never optimize claim value.",
    });
  }

  // -- Rule: legal / carrier authority -------------------------------------
  if (containsAnyPattern(statementText, LEGAL_AUTHORITY_PATTERNS)) {
    violations.push({
      rule: "legal_authority_claim",
      severity: "error",
      message:
        "Text asserts a current legal, regulatory, coverage or carrier requirement. The training manual is not the current legal authority; flag for verification against a current authoritative source.",
    });
  }

  if (containsAnyPattern(statementText, COVERAGE_DETERMINATION_PATTERNS)) {
    violations.push({
      rule: "coverage_determination",
      severity: "error",
      message:
        "Text makes or invites a coverage determination, which belongs to the applicable policy, the insurer, or an authorized claims professional.",
    });
  }

  // -- Rule: confirmed vs proposed ----------------------------------------
  if (item.evidenceStatus) {
    const known = EVIDENCE_STATUSES.some((s) => s.id === item.evidenceStatus);
    if (!known) {
      violations.push({
        rule: "invalid_evidence_status",
        severity: "error",
        message: `Unknown evidence status "${item.evidenceStatus}". Use one of: ${EVIDENCE_STATUSES.map((s) => s.id).join(", ")}.`,
      });
    }
  } else {
    violations.push({
      rule: "proposed_presented_as_fact",
      severity: "warning",
      message:
        "No evidence status set. Items must be marked as a confirmed finding or a proposal/potential item; a discrepancy is never automatically a recoverable supplement.",
    });
  }

  const coerced: GuardrailResult["coerced"] = {
    temporalScope: effectiveScope,
  };
  if (effectiveScope === "historical_context" && !tags.includes("historical-2020-2021")) {
    coerced.tags = [...tags, "historical-2020-2021"];
  }

  return { valid: ok(violations).valid, violations, coerced };
}

/**
 * Distinguish an instruction to manipulate a claim from a warning *about*
 * one. Both may be indexed, but only the warning is a knowledge statement —
 * a prohibition is evidence that Atlas will not help commit the act.
 */
export function isProhibitedPracticeText(text: string): boolean {
  if (!containsAnyPattern(text, PROHIBITED_PRACTICE_PATTERNS)) return false;

  // An explicit prohibition cue flips the meaning: "never fabricate evidence"
  // is an integrity control, not an instruction to fabricate evidence.
  if (containsAnyPattern(text, PROHIBITION_CUES)) return false;

  // Descriptive framing ("claims padding is a common red flag") is likewise
  // safe, but only when it is not also directive.
  if (containsAnyPattern(text, DESCRIPTIVE_CUES) && /\b(red flag|warning sign|scam|fraud|unscrupulous)\b/i.test(text)) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Rule 3: authority floor at retrieval time
// ---------------------------------------------------------------------------

/**
 * Relevance ceiling for items from this source.
 *
 * A training manual may be highly *relevant* to a question while still being
 * weak *authority*. Capping relevance rather than dropping results keeps it
 * available for training and citation while guaranteeing a current
 * authoritative source, when one matches, ranks above it.
 */
export const TRAINING_MANUAL_RELEVANCE_CEILING = 0.55;

/** True if a retrieval result originates from the training manual. */
export function isTrainingManualResult(result: KnowledgeRetrievalResult): boolean {
  return (
    isTrainingManualClassification(result.sourceClassification) ||
    result.provenance?.sourceId === TRAINING_MANUAL_SOURCE_ID ||
    result.item.sourceId === TRAINING_MANUAL_SOURCE_ID
  );
}

/**
 * Apply the authority floor to a ranked result set, in place.
 *
 * Historical results are stamped so downstream consumers must mark them, and
 * manual-sourced results are capped below the ceiling.
 */
export function applyAuthorityFloor(results: KnowledgeRetrievalResult[]): KnowledgeRetrievalResult[] {
  for (const result of results) {
    if (!isTrainingManualResult(result)) continue;

    const item = result.item;
    if (!item.temporalScope) item.temporalScope = "historical_context";
    if (!item.evidenceStatus) item.evidenceStatus = "supported_potential";

    result.temporalScope = item.temporalScope;
    result.evidenceStatus = item.evidenceStatus;
    if (item.locator) result.locator = item.locator;

    result.relevance = Math.min(result.relevance, TRAINING_MANUAL_RELEVANCE_CEILING);
  }

  results.sort((a, b) => b.relevance - a.relevance);
  return results;
}

// ---------------------------------------------------------------------------
// Rendering: historical and provenance markers
// ---------------------------------------------------------------------------

/** Prefix that must precede any historical-context statement. */
export const HISTORICAL_PREFIX = "[Historical context — associated with 2020-2021, not current] ";

/** Provenance suffix appended to a manual-sourced statement. */
export function formatProvenance(result: KnowledgeRetrievalResult): string {
  const parts: string[] = [];
  // Fall back to the item so provenance is still correct if a caller renders
  // a result that has not been through applyAuthorityFloor.
  const scope = result.temporalScope ?? result.item.temporalScope;
  const locator = result.locator ?? result.item.locator;
  if (scope === "historical_context") parts.push("historical context");
  if (result.provenance?.sourceName) parts.push(`source: ${result.provenance.sourceName}`);
  if (locator?.page != null) parts.push(`p. ${locator.page}`);
  if (locator?.section) parts.push(`section: ${locator.section}`);
  parts.push("training reference, not a current legal or coverage authority");
  return ` [${parts.join("; ")}]`;
}

/**
 * Render a result for the reasoning layer with the historical marker and
 * provenance applied. Unmarked historical text is the specific failure this
 * prevents.
 */
export function renderForReasoning(result: KnowledgeRetrievalResult): string {
  const body = result.snippet ?? result.item.statement;
  const scope = result.temporalScope ?? result.item.temporalScope;
  const prefix = scope === "historical_context" ? HISTORICAL_PREFIX : "";
  return `${prefix}${body}${formatProvenance(result)}`;
}

// ---------------------------------------------------------------------------
// §12 boundary triggers
// ---------------------------------------------------------------------------

/** True if text touches a topic the manual cannot be the authority for. */
export function requiresCurrentAuthorityVerification(text: string): boolean {
  const lower = text.toLowerCase();
  return REGULATED_BOUNDARY_TOPICS.some((topic) => lower.includes(topic));
}

/** True if the text is asking Atlas for a coverage determination. */
export function isCoverageDeterminationRequest(text: string): boolean {
  return containsAnyPattern(text, COVERAGE_DETERMINATION_PATTERNS);
}

/**
 * The refusal Atlas must return for a coverage determination, paired with the
 * sources that can actually answer it.
 */
export const COVERAGE_DETERMINATION_HANDOFF = {
  message: COVERAGE_REFUSAL_TEXT,
  deferTo: [
    "the applicable policy and its endorsements",
    "the insurer or carrier",
    "an authorized claims professional or public adjuster, where licensed",
    "current building code for the applicable jurisdiction",
  ],
  mayStillAssistWith: [
    "assembling the evidence the decision will rest on",
    "identifying documentation gaps",
    "explaining concepts in plain language",
    "preparing a factual, evidence-backed summary for the decision-maker",
  ],
} as const;

// ---------------------------------------------------------------------------
// Vocabulary sanity exports (used by the reasoning layer and by tests)
// ---------------------------------------------------------------------------

export const TRAINING_MANUAL_VOCABULARY = {
  tags: TRAINING_MANUAL_TAGS,
  domains: TRAINING_MANUAL_SOURCE_ID ? true : false,
  observationLayers: OBSERVATION_LAYERS.map((l) => l.id),
  conditionClassifications: CONDITION_CLASSIFICATIONS.map((c) => c.id),
  evidenceStatuses: EVIDENCE_STATUSES.map((e) => e.id),
  factPresentingStatuses: FACT_PRESENTING_STATUSES,
  prohibitedPractices: PROHIBITED_PRACTICES,
  operationalPrinciple: OPERATIONAL_PRINCIPLE,
  maxPriorityRank: TRAINING_MANUAL_MAX_PRIORITY_RANK,
  relevanceCeiling: TRAINING_MANUAL_RELEVANCE_CEILING,
  contentIngested: CONTENT_INGESTED,
} as const;

/**
 * Guard against drift: the manual's own documented ceiling and the enforced
 * one must agree, or the documented ranking is a lie.
 */
export const AUTHORITY_FLOOR_CONSISTENT =
  TRAINING_MANUAL_RELEVANCE_CEILING <= 0.6 && TRAINING_MANUAL_MAX_PRIORITY_RANK === 7;
