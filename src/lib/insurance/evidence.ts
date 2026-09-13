// ---------------------------------------------------------------------------
// Atlas canonical evidence contract — frontend decoder.
//
// Every evidence-bearing row must present `evidence` as a string array, no
// matter where it came from:
//
//   - current pipeline (jsonb column / jsonb value)  → array already
//   - current pipeline written pre-2026-09-09 (TEXT column holding a
//     JSON-array literal, e.g. `["estimate"]`)       → JSON string
//   - legacy pipelines (plain text, comma lists, malformed JSON) → string
//   - missing / not yet processed                     → null / undefined
//
// This module is the single canonical decoder. It NEVER throws, NEVER
// fabricates entries, and NEVER drops the original value: anything that is
// not a real array is preserved as a single-element array so the data stays
// discoverable. Consumers may render these values verbatim.
// ---------------------------------------------------------------------------

/** Coerce a single evidence entry to its displayable string form. */
function toEvidenceString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Canonical decoder: returns a real string array for ANY input.
 *
 * - null / undefined / missing            → []
 * - real array                            → stringified entries
 * - JSON-string containing an array       → parsed + stringified entries
 * - malformed JSON-string                 → [original string] (never dropped)
 * - any other value (plain legacy text)   → [stringified value]
 */
export function normalizeEvidence(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map(toEvidenceString);

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "" || trimmed === "null") return [];
    if (trimmed.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.map(toEvidenceString);
      } catch {
        // fall through — keep the raw string, never crash on malformed JSON
      }
    }
    return [value];
  }

  // Unexpected shapes (objects, numbers, booleans): keep them discoverable
  // as a single entry rather than silently returning [].
  return [toEvidenceString(value)];
}

/**
 * Normalize a single finding/candidate row's `evidence` field in place-safe
 * fashion (returns a new object; the raw row is never mutated).
 */
export function normalizeEvidenceRow<T extends Record<string, unknown>>(row: T): T {
  return {
    ...row,
    evidence: normalizeEvidence(row.evidence),
  } as T;
}

/**
 * Normalize every row in a findings/candidates list. Always returns an array;
 * non-array inputs collapse to [].
 */
export function normalizeEvidenceRows(
  rows: unknown,
): Array<Record<string, unknown>> {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) =>
    row && typeof row === "object" && !Array.isArray(row)
      ? normalizeEvidenceRow(row as Record<string, unknown>)
      : { evidence: [] },
  );
}