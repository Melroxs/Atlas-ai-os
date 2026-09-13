// ---------------------------------------------------------------------------
// Atlas Voice — deterministic intent router
//
// Decides which ATLAS tool (if any) a spoken command maps to. This is Atlas
// intent routing, not ElevenLabs: ElevenLabs only produced the transcript.
//
// Rules are explicit and ORDERED, because several phrasings overlap
// ("show me claims needing review" is a search, not navigation). Atlas never
// guesses: when a command is ambiguous it is handed to the existing
// conversation engine, and when a tool cannot identify a claim it asks a short
// clarifying question instead of picking one at random.
// ---------------------------------------------------------------------------

import { resolveDestinationId } from "./navigation";

export type AtlasIntentName =
  | "navigate_atlas"
  | "search_claims"
  | "get_claim"
  | "get_claim_findings"
  | "get_missing_evidence";

export interface AtlasIntent {
  name: AtlasIntentName;
  /** Arguments for the tool (shapes match tools.ts). */
  args: Record<string, string | boolean>;
}

export interface IntentContext {
  /** Claim id derived from the current route, when the user is on a claim. */
  claimId?: string | null;
}

const NAVIGATE_RE =
  /\b(?:open|go to|goto|take me to|navigate to|show me|pull up|bring up|jump to)\b\s*(.*)$/i;
const MISSING_RE =
  /\b(?:what'?s missing|what is missing|missing evidence|what'?s outstanding|what is outstanding|what do we need|what'?s still needed|evidence gaps?|information gaps?|info gaps?)\b/i;
const FINDINGS_RE =
  /\b(?:findings?|what did we find|what'?s been found|issues? found)\b/i;
const ATTENTION_RE =
  /\b(?:needing? review|needs? (?:my )?attention|waiting for review|requires? attention|needing attention|to review)\b/i;
const SEARCH_VERB_RE = /\b(?:find|show|list|search|look up|which|what|any)\b/i;
const CLAIM_WORD_RE = /\bclaims?\b/i;
const STATUS_RE =
  /\b(?:what'?s (?:happening|going on|the status|up)|status of|status on|status|how much is|tell me about|what about|details? (?:on|for|about))\b/i;
const LEADING_SEARCH_VERB_RE =
  /^.*?\b(?:find|show|list|search|look up|which|what|any)\b/i;

const LEADING_FILLER_RE = /^(?:the|a|an|for|on|about|of|in|to|with|regarding|re)\b[\s,]*/i;

/**
 * Reduce a spoken fragment ("the Carter claim", "on CLM-9") to the meaningful
 * claim reference ("Carter", "CLM-9"). Returns "" when nothing meaningful is
 * left, so callers fall back to page context instead of using stray punctuation.
 */
export function extractClaimReference(fragment: string): string {
  let text = (fragment ?? "").trim();
  text = text.replace(/\b(?:the|a|an)\b/gi, " ");
  text = text.replace(/\bclaims?\b/gi, " ");
  text = text.replace(/\b(?:please|for me|now|page|detail|details|view|screen)\b/gi, " ");
  text = text.replace(/\s+/g, " ").trim();

  // Strip leftover leading prepositions from the matched verb phrase.
  let previous = "";
  while (previous !== text) {
    previous = text;
    text = text.replace(LEADING_FILLER_RE, "").trim();
  }

  text = text.replace(/[^\p{L}\p{N}\s\-_.]/gu, " ").replace(/\s+/g, " ").trim();
  if (!/[\p{L}\p{N}]/u.test(text)) return "";
  return text;
}

/** Longest destination phrase contained in the fragment, if any. */
function destinationInFragment(fragment: string): string | null {
  const text = (fragment ?? "").toLowerCase().trim();
  if (!text) return null;
  const direct = resolveDestinationId(text);
  if (direct) return direct;

  const words = text.split(/\s+/);
  for (let end = words.length; end > 0; end--) {
    const candidate = words.slice(0, end).join(" ");
    const id = resolveDestinationId(candidate);
    if (id) return id;
  }
  return null;
}

/**
 * Classify a spoken command into at most one Atlas tool.
 * Returns null when the utterance should go to the conversation engine.
 */
export function routeAtlasIntent(
  transcript: string,
  context: IntentContext = {},
): AtlasIntent | null {
  const text = (transcript ?? "").trim();
  if (!text) return null;
  const contextClaimId = (context.claimId ?? "").trim() || null;

  // 0. "claims needing review" is a SEARCH even when phrased with a navigation
  //    verb ("show me claims needing review"). Must precede navigation.
  if (CLAIM_WORD_RE.test(text) && ATTENTION_RE.test(text)) {
    return { name: "search_claims", args: { needsAttention: true } };
  }

  // 1. "what's missing" / evidence gaps — strongest contextual signal.
  if (MISSING_RE.test(text)) {
    const explicit = extractClaimReference(text.replace(MISSING_RE, " "));
    const ref = explicit || contextClaimId;
    return ref ? { name: "get_missing_evidence", args: { claimRef: ref } } : null;
  }

  // 2. findings
  if (FINDINGS_RE.test(text)) {
    const explicit = extractClaimReference(text.replace(FINDINGS_RE, " "));
    const ref = explicit || contextClaimId;
    return ref ? { name: "get_claim_findings", args: { claimRef: ref } } : null;
  }

  // 3. navigation
  const navigateMatch = text.match(NAVIGATE_RE);
  if (navigateMatch) {
    const fragment = navigateMatch[1] ?? "";
    const destination = destinationInFragment(fragment);
    if (destination) {
      const claimRef = extractClaimReference(fragment);
      return {
        name: "navigate_atlas",
        args: {
          destination,
          // Only meaningful for claim destinations; harmless otherwise.
          ...(claimRef ? { claimRef } : {}),
        },
      };
    }
    // "open Carter" (no page word) means Carter's claim.
    const claimRef = extractClaimReference(fragment);
    if (claimRef) {
      return { name: "navigate_atlas", args: { destination: "claim", claimRef } };
    }
    return null;
  }

  // 4. "what's happening with Carter" / "status of CLM-1042"
  //    Checked BEFORE the generic search rule, because status questions also
  //    contain search-ish words ("what").
  if (STATUS_RE.test(text)) {
    const explicit = extractClaimReference(text.replace(STATUS_RE, " "));
    const ref = explicit || contextClaimId;
    if (ref) return { name: "get_claim", args: { claimRef: ref } };
  }

  // 5. claim search ("find Carter", "which claims do we have")
  if (SEARCH_VERB_RE.test(text)) {
    const query = extractClaimReference(text.replace(LEADING_SEARCH_VERB_RE, " "));
    if (query) return { name: "search_claims", args: { query } };
  }

  return null;
}

/** True when the transcript is a request to stop Atlas speaking. */
export function isInterruptPhrase(transcript: string): boolean {
  const text = (transcript ?? "").trim().toLowerCase();
  if (!text) return false;
  if (/^(?:stop|wait|quiet|pause|hold on|never ?mind|cancel that|be quiet|hush|enough)\b/.test(text)) {
    return true;
  }
  return /\b(?:atlas|please)[,\s]+(?:stop|wait|quiet|pause|hold on|be quiet)\b/.test(text);
}
