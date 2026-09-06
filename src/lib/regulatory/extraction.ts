// ---------------------------------------------------------------------------
// Atlas Regulatory Intelligence — Deterministic Extraction
//
// Cost control: do the extraction that can be done deterministically BEFORE
// any model call. This module extracts citations, deadlines, effective dates,
// actors, and claim phases from regulatory text with regex + heuristics.
//
// A failure to extract is NEVER filled with a guess — extraction results are
// best-effort and any missing field stays undefined.
// ---------------------------------------------------------------------------

import type { ActorType, DeadlineUnit } from "./types";
import { ACTOR_IDS } from "./taxonomy";

// ---------------------------------------------------------------------------
// Date parsing
// ---------------------------------------------------------------------------

/** Parse common US date formats. Returns epoch ms or undefined. */
export function parseRegulatoryDate(input: string): number | undefined {
  const s = input.trim();
  if (!s) return undefined;

  // ISO-8601 (YYYY-MM-DD)
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isFinite(t) ? t : undefined;
  }

  // "January 1, 2025" / "Jan. 1, 2025"
  m = s.match(/^(jan(?:uary)?\.?|feb(?:ruary)?\.?|mar(?:ch)?\.?|apr(?:il)?\.?|may\.?|jun(?:e)?\.?|jul(?:y)?\.?|aug(?:ust)?\.?|sep(?:tember)?\.?|oct(?:ober)?\.?|nov(?:ember)?\.?|dec(?:ember)?\.?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i);
  if (m) {
    const MONTHS: Record<string, number> = {
      jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
      may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8,
      september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
    };
    const month = MONTHS[m[1].toLowerCase().replace(".", "")];
    if (month === undefined) return undefined;
    const t = Date.UTC(Number(m[3]), month, Number(m[2]));
    return Number.isFinite(t) ? t : undefined;
  }

  // "MM/DD/YYYY"
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    const year = Number(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
    const t = Date.UTC(year, month - 1, day);
    return Number.isFinite(t) ? t : undefined;
  }

  // Bare year
  m = s.match(/^(\d{4})$/);
  if (m) {
    const t = Date.UTC(Number(m[1]), 0, 1);
    return Number.isFinite(t) ? t : undefined;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Citation extraction
// ---------------------------------------------------------------------------

const CITATION_PATTERNS: RegExp[] = [
  // State statutes: "Fla. Stat. § 627.428", "Texas Insurance Code § 542.051"
  /\b((?:[A-Z][a-z]+\.?|[A-Z]{2})\s*(?:Stat\.|Statutes?|Insurance Code|Ins\. Code|Revised Statutes|Code Ann\.?|General Laws|Public Act|Session Laws))\s*§{0,2}\s*([\dA-Za-z]+(?:[-.]\d+)*)/g,
  // Generic section: "§ 542.051", "Section 542.051"
  /\b(?:§|Section|Sec\.)\s+([\dA-Za-z]+(?:[-.]\d+)*)/g,
  // Federal: "29 CFR 1926.501", "40 CFR 745"
  /\b(\d{1,2}\s+CFR\s+[\d.]+)/gi,
  // Public laws: "Pub. L. 116-93"
  /\b(?:Pub\.?\s*L\.?|Public Law)\s+(\d{2,3}-\d{1,3})/gi,
  // US Code: "42 U.S.C. § 5151"
  /\b(\d{1,3}\s+U\.?S\.?C\.?\s*§{0,2}\s*[\dA-Za-z]+(?:[-.]\d+)*)/gi,
];

/** Extract citation-like strings from text. Returns unique, ordered matches. */
export function extractCitations(text: string): string[] {
  const out: string[] = [];
  for (const re of CITATION_PATTERNS) {
    const reCopy = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const m of text.matchAll(reCopy)) {
      const cit = (m[0] ?? "").trim().replace(/\s+/g, " ");
      if (cit && !out.includes(cit)) out.push(cit);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deadline extraction
// ---------------------------------------------------------------------------

const DEADLINE_PATTERNS: Array<{
  re: RegExp;
  unit: DeadlineUnit;
  subject?: string;
}> = [
  {
    // "within 14 days", "within thirty (30) days"
    re: /\bwithin\s+(?:an?\s+)?(\d{1,3}|thirty|fifteen|ten|five)\s*(?:\(\d{1,3}\))?\s*(business\s+)?(days?|hours?|months?|years?)\b/i,
    unit: "calendar_days",
  },
  {
    // "no later than 60 days after"
    re: /\bno\s+later\s+than\s+(\d{1,3})\s*(business\s+)?(days?|hours?|months?|years?)\b/i,
    unit: "calendar_days",
  },
  {
    // "within 15 business days"
    re: /\bwithin\s+(\d{1,3})\s+business\s+(days?|hours?)\b/i,
    unit: "business_days",
  },
  {
    // "not less than 30 days" / "at least 30 days"
    re: /\b(?:not\s+less\s+than|at\s+least)\s+(\d{1,3})\s*(business\s+)?(days?|hours?|months?|years?)\b/i,
    unit: "calendar_days",
  },
];

export interface ExtractedDeadline {
  amount: number;
  unit: DeadlineUnit;
  /** The matched phrase, e.g. "within 14 days". */
  phrase: string;
}

const NUMBER_WORDS: Record<string, number> = {
  five: 5,
  ten: 10,
  fifteen: 15,
  thirty: 30,
};

/** Extract the first deadline found in text (best-effort, never invented). */
export function extractDeadline(text: string): ExtractedDeadline | undefined {
  for (const { re, unit: fallbackUnit } of DEADLINE_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const raw = m[1];
    const amount = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : NUMBER_WORDS[raw.toLowerCase()];
    if (amount === undefined || !Number.isFinite(amount)) continue;
    const isBusiness = (m[2] ?? "").toLowerCase().includes("business");
    const unitWord = (m[3] ?? "").toLowerCase();
    let unit: DeadlineUnit;
    if (unitWord.startsWith("hour")) unit = "hours";
    else if (unitWord.startsWith("month")) unit = "months";
    else if (unitWord.startsWith("year")) unit = "years";
    else if (isBusiness) unit = "business_days";
    else unit = "calendar_days";
    void fallbackUnit;
    return { amount, unit, phrase: m[0].trim().replace(/\s+/g, " ") };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Actor extraction
// ---------------------------------------------------------------------------

const ACTOR_PATTERNS: Array<{ actor: ActorType; re: RegExp }> = [
  { actor: "public_adjuster", re: /\bpublic\s+adjuster\b/i },
  { actor: "independent_adjuster", re: /\bindependent\s+adjuster\b/i },
  { actor: "restoration_contractor", re: /\brestoration\s+contractor\b|\bcontractor\b/i },
  { actor: "insurer", re: /\binsurer\b|\binsurance\s+company\b|\bcarrier\b|\bcompany\b/i },
  { actor: "insured", re: /\binsured\b|\bpolicyholder\b/i },
  { actor: "attorney", re: /\battorney\b|\bcounsel\b|\blawyer\b/i },
  { actor: "mortgagee", re: /\bmortgagee\b/i },
  { actor: "regulator", re: /\b(?:commissioner|department\s+of\s+insurance|division\s+of\s+insurance|superintendent|director\s+of\s+insurance)\b/i },
];

/** Extract the primary actor addressed by a rule (ordered heuristic). */
export function extractActor(text: string): ActorType | undefined {
  const found: ActorType[] = [];
  for (const { actor, re } of ACTOR_PATTERNS) {
    if (re.test(text) && !found.includes(actor)) found.push(actor);
  }
  if (found.length === 0) return undefined;
  // Prefer the most specific actor for restoration context.
  if (found.includes("restoration_contractor")) return "restoration_contractor";
  if (found.includes("public_adjuster")) return "public_adjuster";
  if (found.includes("independent_adjuster")) return "independent_adjuster";
  if (found.includes("insurer")) return "insurer";
  if (found.includes("insured")) return "insured";
  return found[0];
}

/** Check whether an actor appears in text (multi-actor rules). */
export function actorMentions(text: string): ActorType[] {
  return ACTOR_IDS.filter((a) => ACTOR_PATTERNS.some((p) => p.actor === a && p.re.test(text)));
}

// ---------------------------------------------------------------------------
// Claim-phase detection
// ---------------------------------------------------------------------------

const PHASE_PATTERNS: Array<{ phase: string; re: RegExp }> = [
  { phase: "notice", re: /\bnotice\s+of\s+loss\b|\bfirst\s+notice\b|\bfnol\b/i },
  { phase: "mitigation", re: /\bmitigat(e|ion)\b|\bemergency\s+services\b|\bwater\s+extraction\b/i },
  { phase: "documentation", re: /\bproof\s+of\s+loss\b|\bdocumentation\b|\brecords?\b/i },
  { phase: "estimation", re: /\bestimat(e|ion|ing)\b|\bxactimate\b|\bscope\b/i },
  { phase: "supplement_submission", re: /\bsupplement\b|\badditional\s+claim\b|\breopened\b/i },
  { phase: "carrier_review", re: /\b(?:acknowledge|acknowledgment|response\s+to\s+claim|claims?\s+(?:handling|practices)|investigat(e|ion))\b/i },
  { phase: "payment", re: /\bpay(?:ment|able)?\b|\bprompt\s+pay\b/i },
  { phase: "dispute", re: /\bappraisal\b|\bmediation\b|\blitigat(e|ion)\b|\bpre[- ]suit\b|\bbad\s+faith\b|\bdispute\b/i },
  { phase: "reopening", re: /\breopen(?:ing|ed)?\b|\bsupplemental\b/i },
];

/** Detect claim phases referenced by a rule (best-effort). */
export function detectClaimPhases(text: string): string[] {
  const out: string[] = [];
  for (const { phase, re } of PHASE_PATTERNS) {
    if (re.test(text) && !out.includes(phase)) out.push(phase);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Requirement / prohibition classification
// ---------------------------------------------------------------------------

/** Is this rule text stating a requirement ("must", "shall", "is required")? */
export function isRequirement(text: string): boolean {
  return /\b(?:must|shall|is\s+required|is\s+obligated|required\s+to|has\s+the\s+duty|may\s+not\s+refuse|it\s+shall\s+be\s+the\s+duty)\b/i.test(text);
}

/** Is this rule text stating a prohibition? */
export function isProhibition(text: string): boolean {
  return /\b(?:shall\s+not|must\s+not|may\s+not|is\s+prohibited|no\s+(?:person|insurer|contractor)\s+shall|it\s+is\s+unlawful|shall\s+be\s+unlawful)\b/i.test(text);
}

/** Extract an exception clause ("unless", "provided that", "except"). */
export function extractException(text: string): string | undefined {
  const m = text.match(/(?:unless|except(?: that)?|provided that|provided, however,)[^.]*\.[^.]*\.?/i);
  return m?.[0]?.trim() || undefined;
}

/** Simple normalized rule: collapse whitespace and lowercase. */
export function normalizeRuleText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Verification flags
// ---------------------------------------------------------------------------

/** Whether the text is a plausible direct quote from a source (no hedging). */
export function isDirectRuleStatement(text: string): boolean {
  if (!text.trim()) return false;
  // Hedging markers suggest paraphrase or uncertainty — flag for review.
  if (/\b(?:i\s+believe|i\s+think|likely|probably|appears\s+to|may\s+or\s+may\s+not)\b/i.test(text)) {
    return false;
  }
  return true;
}