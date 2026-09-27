// ---------------------------------------------------------------------------
// Atlas Knowledge Layer — document-level deduplication
//
// Deterministic by construction: no random ids, no LLM judgement. Two records
// are compared by a normalized-text fingerprint and a token-set similarity, and
// the VERDICT is a classification the caller acts on — this module never
// silently merges or deletes anything.
//
// The authority rules are absolute:
//   - Identical wording is NOT identical authority. A training statement that
//     reads like a regulatory one must not replace it. `mergeable` is only ever
//     true for two records from the SAME source & classification.
//   - A higher-authority existing record is never erased. When the incoming
//     record resembles a higher-authority one, the verdict is reported and
//     `wouldEraseHigherAuthority` is true, which forces the caller to keep both.
// ---------------------------------------------------------------------------

import type { KnowledgeItem, SourceClassification } from "../types";

// ---------------------------------------------------------------------------
// Deterministic hashing (no crypto dependency; identical across runtimes)
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit over a string, returned as 8 hex chars. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** FNV-1a over raw bytes, returned as 8 hex chars. */
export function fnv1aBytes(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < b.length; i++) {
    h ^= b[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Content fingerprint of a document. Two hashes over the bytes keep the chance
 * of a collision negligible while staying deterministic and dependency-free.
 */
export function fingerprintBytes(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const forward = fnv1aBytes(b);
  // Reverse pass with a different seed makes the pair far harder to collide.
  let h = 0x9e3779b9 >>> 0;
  for (let i = b.length - 1; i >= 0; i--) {
    h ^= b[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const backward = (h >>> 0).toString(16).padStart(8, "0");
  return `${forward}${backward}`;
}

// ---------------------------------------------------------------------------
// Normalization + similarity
// ---------------------------------------------------------------------------

/**
 * Normalize text for comparison: lowercase, strip punctuation, collapse
 * whitespace. Deliberately conservative — it never removes meaningful words.
 */
export function normalizeForFingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fingerprint of a knowledge statement's normalized text. */
export function fingerprintItem(item: Pick<KnowledgeItem, "title" | "statement">): string {
  return fnv1a(normalizeForFingerprint(`${item.title} ${item.statement}`));
}

/** Token-set (Jaccard) similarity over normalized text, 0..1. */
export function textSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeForFingerprint(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeForFingerprint(b).split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type DuplicateVerdict =
  | "unique"
  | "exact_duplicate"
  | "near_duplicate"
  | "related"
  | "contradictory";

export interface DedupDecision {
  verdict: DuplicateVerdict;
  /** Existing item this was compared against, when a match was found. */
  matchedId?: string;
  matchedSourceClassification?: SourceClassification;
  similarity: number;
  /**
   * True only when the incoming item may be MERGED into the existing record —
   * i.e. same document/source/classification and substantively identical.
   */
  mergeable: boolean;
  /**
   * True when merging would drop a higher-authority record. Must keep both.
   */
  wouldEraseHigherAuthority: boolean;
  reason: string;
}

/** Authority order used for the "never erase higher authority" rule. */
export const AUTHORITY_ORDER: Record<SourceClassification, number> = {
  MODEL_INFERENCE: 0,
  TRAINING_MANUAL: 1,
  ATLAS_CURATED: 2,
  CARRIER_OR_INSURANCE: 3,
  PROFESSIONAL_GUIDANCE: 4,
  CUSTOMER_PROVIDED: 5,
  CUSTOMER_GENERATED: 6,
  MANUFACTURER: 7,
  INDUSTRY_STANDARD: 8,
  REGULATORY: 9,
};

const CONTRADICTION_MARKERS: Array<[RegExp, RegExp]> = [
  [/\bmust\b/i, /\bmust not\b/i],
  [/\bshall\b/i, /\bshall not\b/i],
  [/\ballowed\b/i, /\b(prohibited|forbidden|not allowed)\b/i],
  [/\brequired\b/i, /\b(optional|not required)\b/i],
  [/\bpermitted\b/i, /\bprohibited\b/i],
];

/** Whether two texts share a subject yet assert opposite modality. */
export function isContradictory(a: string, b: string): boolean {
  for (const [positive, negative] of CONTRADICTION_MARKERS) {
    if (
      (positive.test(a) && negative.test(b)) ||
      (negative.test(a) && positive.test(b))
    ) {
      return true;
    }
  }
  return false;
}

export interface DedupOptions {
  /** Similarity at/above which items are near-duplicates. */
  nearThreshold?: number;
  /** Similarity at/above which items are merely related. */
  relatedThreshold?: number;
}

const DEFAULT_NEAR = 0.86;
const DEFAULT_RELATED = 0.5;

/**
 * Classify one incoming item against an existing corpus.
 *
 * Returns the strongest verdict across all existing items, with the authority
 * safety rule applied. Never mutates either input.
 */
export function classifyDuplicate(
  incoming: KnowledgeItem,
  existing: KnowledgeItem[],
  options: DedupOptions = {},
): DedupDecision {
  const near = options.nearThreshold ?? DEFAULT_NEAR;
  const related = options.relatedThreshold ?? DEFAULT_RELATED;

  const incomingFp = fingerprintItem(incoming);
  const incomingText = `${incoming.title} ${incoming.statement}`;

  let best: DedupDecision = {
    verdict: "unique",
    similarity: 0,
    mergeable: false,
    wouldEraseHigherAuthority: false,
    reason: "No substantially similar existing knowledge found.",
  };

  for (const candidate of existing) {
    const similarity = textSimilarity(incomingText, `${candidate.title} ${candidate.statement}`);
    const exact =
      fingerprintItem(candidate) === incomingFp &&
      normalizeForFingerprint(candidate.statement) === normalizeForFingerprint(incoming.statement);

    const contradiction = similarity >= related && isContradictory(incoming.statement, candidate.statement);

    let verdict: DuplicateVerdict | null = null;
    if (exact) verdict = "exact_duplicate";
    else if (contradiction) verdict = "contradictory";
    else if (similarity >= near) verdict = "near_duplicate";
    else if (similarity >= related) verdict = "related";
    if (!verdict) continue;

    const sameAuthority =
      incoming.sourceClassification === candidate.sourceClassification;
    const sameSource =
      (incoming.sourceId ?? incoming.documentId) ===
      (candidate.sourceId ?? candidate.documentId);

    const existingRank = AUTHORITY_ORDER[candidate.sourceClassification] ?? 0;
    const incomingRank = AUTHORITY_ORDER[incoming.sourceClassification] ?? 0;
    const wouldEraseHigherAuthority = existingRank > incomingRank;

    const mergeable =
      exact && sameAuthority && sameSource && !wouldEraseHigherAuthority;

    // Rank candidate verdicts: exact > contradictory > near > related.
    const weight: Record<DuplicateVerdict, number> = {
      unique: 0,
      related: 1,
      near_duplicate: 2,
      contradictory: 3,
      exact_duplicate: 4,
    };

    if (weight[verdict] > weight[best.verdict]) {
      best = {
        verdict,
        matchedId: candidate.id,
        matchedSourceClassification: candidate.sourceClassification,
        similarity,
        mergeable,
        wouldEraseHigherAuthority,
        reason: describe(verdict, similarity, candidate, wouldEraseHigherAuthority),
      };
    }
  }

  return best;
}

function describe(
  verdict: DuplicateVerdict,
  similarity: number,
  candidate: KnowledgeItem,
  wouldEraseHigherAuthority: boolean,
): string {
  const pct = Math.round(similarity * 100);
  const suffix = wouldEraseHigherAuthority
    ? " The existing record has higher authority and must be preserved."
    : "";
  switch (verdict) {
    case "exact_duplicate":
      return `Substantively identical to ${candidate.id} (${pct}% token overlap).${suffix}`;
    case "near_duplicate":
      return `Highly similar to ${candidate.id} (${pct}% token overlap); additional context may be preserved separately.${suffix}`;
    case "contradictory":
      return `Shares a subject with ${candidate.id} (${pct}% token overlap) but asserts the opposite. Both sources must be kept and the authority distinction preserved.${suffix}`;
    case "related":
      return `Related to ${candidate.id} (${pct}% token overlap) but carries different information; keep both.${suffix}`;
    default:
      return "No substantially similar existing knowledge found.";
  }
}

/**
 * Deduplicate a batch, preserving order and never dropping a higher-authority
 * existing record. Returns actionable decisions keyed to the incoming items.
 */
export function dedupeAgainstCorpus(
  incoming: KnowledgeItem[],
  existing: KnowledgeItem[],
  options: DedupOptions = {},
): Array<{ item: KnowledgeItem; decision: DedupDecision }> {
  return incoming.map((item) => ({
    item,
    decision: classifyDuplicate(item, existing, options),
  }));
}
