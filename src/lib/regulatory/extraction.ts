import type { Citation, RegulatoryProposition, SourceCandidate, AcquiredSource, ResearchTopic, SupplementFinding } from "./types";
import { RESEARCH_TOPICS } from "./types";

const TOPIC_PATTERNS: Array<[ResearchTopic, RegExp]> = [
  ["notice_of_loss", /notice\s+of\s+loss|notice\s+of\s+claim/i],
  ["acknowledgment", /acknowledg(?:e|ement|ing)|receipt\s+of\s+claim/i],
  ["investigation", /investigat(?:e|ion|ing)/i],
  ["inspection", /inspect(?:ion|ing|ed)/i],
  ["coverage_determination", /coverage\s+determination|coverage\s+decision/i],
  ["claim_decision", /claim\s+(?:decision|determination)/i],
  ["payment", /pay(?:ment|ments)|tender/i],
  ["denial", /den(?:y|ial|ied)/i],
  ["partial_denial", /partial\s+denial/i],
  ["proof_of_loss", /proof\s+of\s+loss/i],
  ["claim_documentation", /claim\s+document(?:ation|s)|records?\s+of\s+claim/i],
  ["communication_requirements", /communicat(?:e|ion)|written\s+notice/i],
  ["claim_records", /claim\s+records?|recordkeeping/i],
  ["unfair_claims_practices", /unfair\s+(?:claim|trade)\s+practice|unfair\s+settlement/i],
  ["bad_faith", /bad\s+faith/i],
  ["complaint_procedures", /complaint|consumer\s+assistance/i],
  ["supplemental_claims", /supplement(?:al|s)|additional\s+damage/i],
  ["additional_damage", /additional\s+damage/i],
  ["reopened_claims", /reopen(?:ed|ing)?\s+claim/i],
  ["supplemental_deadlines", /supplement(?:al)?[^.]{0,80}\b(?:day|days|month|months|year|years|deadline)/i],
  ["documentation_requirements", /document(?:ation)?\s+required|supporting\s+document/i],
  ["carrier_response_requirements", /insurer[^.]{0,80}(?:respond|response|reply)/i],
  ["proof_requirements", /proof\s+required|proof\s+of/i],
  ["estimate_change_order_requirements", /estimate|change\s+order/i],
  ["dispute_procedures", /dispute|resolution\s+procedure/i],
  ["appraisal", /appraisal/i],
  ["mediation", /mediation/i],
  ["pre_suit_requirements", /pre[-\s]suit|before\s+filing\s+suit/i],
  ["litigation_requirements", /litigat(?:e|ion)|lawsuit|civil\s+action/i],
  ["dispute_deadlines", /dispute[^.]{0,80}\b(?:day|days|month|months|year|years|deadline)/i],
  ["filing_deadlines", /fil(?:e|ing)[^.]{0,80}\b(?:day|days|month|months|year|years|deadline)/i],
  ["statute_of_limitations", /statute\s+of\s+limitations|limitations\s+period/i],
  ["contractor_licensing", /contractor[^.]{0,40}licen[cs]/i],
  ["restoration_contracting", /restoration\s+contract|repair\s+contract/i],
  ["contract_requirements", /contract[^.]{0,50}(?:must|shall|required|include)/i],
  ["cancellation_rights", /cancel(?:lation)?\s+(?:right|period)|right\s+to\s+cancel/i],
  ["solicitation", /solicit(?:ation|ing)|door[-\s]to[-\s]door/i],
  ["advertising", /advertis(?:e|ement|ing)/i],
  ["disclosures", /disclos(?:e|ure)/i],
  ["deductible_restrictions", /deductible[^.]{0,80}(?:rebate|waive|pay|absorb|restrict)/i],
  ["rebates", /rebate/i],
  ["inducements", /inducement|incentive/i],
  ["assignment_of_benefits", /assignment\s+of\s+benefit|AOB\b/i],
  ["direction_to_pay", /direction\s+to\s+pay/i],
  ["contractor_representation", /represent(?:ation|ative)|act\s+on\s+behalf/i],
  ["prohibited_practices", /prohibited|unlawful|may\s+not|shall\s+not/i],
  ["public_adjuster_licensing", /public\s+adjust(?:er|ing)[^.]{0,80}licen[cs]/i],
  ["public_adjuster_fees", /public\s+adjust(?:er|ing)[^.]{0,80}fee/i],
  ["public_adjuster_fee_limits", /public\s+adjust(?:er|ing)[^.]{0,100}(?:percent|%|fee\s+limit|maximum)/i],
  ["public_adjuster_contracts", /public\s+adjust(?:er|ing)[^.]{0,80}contract/i],
  ["public_adjuster_disclosures", /public\s+adjust(?:er|ing)[^.]{0,80}disclos/i],
  ["public_adjuster_cancellation", /public\s+adjust(?:er|ing)[^.]{0,100}cancel/i],
  ["public_adjuster_solicitation", /public\s+adjust(?:er|ing)[^.]{0,100}solicit/i],
  ["catastrophe_rules", /catastrophe|emergency\s+adjust/i],
  ["recordkeeping", /recordkeep|retain[^.]{0,30}records?/i],
  ["hurricane", /hurricane/i],
  ["wind", /windstorm|wind\s+damage/i],
  ["hail", /hail/i],
  ["storm", /storm/i],
  ["flood", /flood/i],
  ["fire", /fire/i],
  ["smoke", /smoke/i],
  ["water", /water\s+damage|water/i],
  ["mold", /mold/i],
  ["roof", /roof|roofing/i],
];

function nearestLine(text: string, index: number): { line: string; location: string } {
  const before = text.slice(0, index);
  const lineNumber = before.split(/\r?\n/).length;
  const line = text.split(/\r?\n/)[lineNumber - 1]?.trim() ?? "";
  return { line, location: `line ${lineNumber}` };
}

export function extractCitations(text: string): Citation[] {
  const citations: Citation[] = [];
  const patterns: Array<[RegExp, keyof Citation]> = [
    [/\b(?:Fla?\.?|Florida)\s+Stat\.?\s*[§§]?\s*([\d.-]+)/gi, "statuteNumber"],
    [/\b(?:Tex\.?|Texas)\s+(?:Ins\.?\s+)?Code\s*[§§]?\s*([\d.-]+)/gi, "statuteNumber"],
    [/\b(?:Cal\.?|California)\s+(?:Ins\.?\s+)?Code\s*[§§]?\s*([\d.-]+)/gi, "statuteNumber"],
    [/\b(?:N\.Y\.|NY|New York)\s+Ins\.?\s+Law\s*[§§]?\s*([\d.-]+)/gi, "statuteNumber"],
    [/\b(?:Colo\.?|Colorado)\s+Rev\.?\s+Stat\.?\s*[§§]?\s*([\d.-]+)/gi, "statuteNumber"],
    [/(?:§|Section)\s*(\d+(?:\.\d+)*(?:[-\w]+)?)/gi, "citation"],
    [/(?:Rule|Regulation|WAC|COMAR|O\.C\.G\.A\.|LAC)\s*([-\dA-Za-z.()]+)/gi, "regulationNumber"],
  ];
  for (const [pattern, key] of patterns) {
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      const { line, location } = nearestLine(text, index);
      const value = match[0].trim();
      const citation: Citation = { citation: value, location, text: line };
      citation[key] = key === "citation" ? value : match[1] ?? value;
      if (!citations.some((existing) => existing.citation === citation.citation && existing.location === citation.location)) citations.push(citation);
    }
  }
  return citations;
}

export function classifyTopics(text: string): ResearchTopic[] {
  const topics = new Set<ResearchTopic>();
  for (const [topic, pattern] of TOPIC_PATTERNS) if (pattern.test(text)) topics.add(topic);
  return [...topics];
}

function extractEvidenceWindows(text: string, topics: ResearchTopic[], citations: Citation[]): Array<{ text: string; location: string; topics: ResearchTopic[] }> {
  const lines = text.split(/\r?\n/);
  return lines.flatMap((line, index) => {
    const lineTopics = classifyTopics(line);
    if (lineTopics.length === 0 && citations.every((citation) => citation.location !== `line ${index + 1}`)) return [];
    const evidenceText = lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 2)).join(" ").trim();
    return [{ text: evidenceText, location: `line ${index + 1}`, topics: lineTopics.length ? lineTopics : topics }];
  });
}

function parseTimeValue(text: string): { amount: number; unit: string } | undefined {
  const match = text.match(/\b(\d+)\s*(hours?|business\s+days?|calendar\s+days?|days?|months?|years?)\b/i);
  return match ? { amount: Number(match[1]), unit: match[2].toLowerCase().replace(/\s+/g, "_") } : undefined;
}

export function supplementFindingFor(topics: ResearchTopic[], text: string): SupplementFinding | undefined {
  if (!topics.some((topic) => ["supplemental_claims", "supplemental_deadlines", "additional_damage", "reopened_claims"].includes(topic))) return undefined;
  if (/supplement(?:al|s)|reopen(?:ed|ing)?\s+claim/i.test(text) && /shall|required|must|deadline|day|month|year|regulation|statute/i.test(text)) return "EXPLICIT";
  if (/additional\s+damage|claim\s+documentation|proof\s+of\s+loss|investigat|reopen/i.test(text)) return "INDIRECT";
  return "INCOMPLETE";
}

export function extractPropositions(source: AcquiredSource, text: string = source.rawContent ?? ""): RegulatoryProposition[] {
  if (!text.trim()) return [];
  const citations = extractCitations(text);
  const topics = classifyTopics(text);
  const windows = extractEvidenceWindows(text, topics, citations);
  return windows.flatMap((window, index) => {
    const citation = citations.find((item) => item.location === window.location) ?? citations[0];
    if (!citation || window.topics.length === 0) return [];
    const time = parseTimeValue(window.text);
    return window.topics.map((topic) => ({
      jurisdictionCode: source.jurisdictionCode,
      topic,
      statement: window.text,
      normalizedValue: time ? { amount: time.amount, unit: time.unit } : undefined,
      citation,
      sourceId: source.id,
      discoverySourceId: source.discoverySourceId,
      authorityTier: source.authorityTier,
      verificationState: "UNVERIFIED" as const,
      supplementFinding: supplementFindingFor(window.topics, window.text),
      evidenceText: window.text,
      evidenceLocation: window.location,
      confidence: Math.min(0.98, 0.55 + (citation.citation ? 0.2 : 0) + (source.authorityTier === "secondary_reference" ? 0 : 0.2)),
      requiresHumanReview: source.kind === "secondary" || !citation.citation,
      id: `${source.id}_${topic}_${index}`,
    }));
  });
}

export function normalizeProposition(proposition: RegulatoryProposition): RegulatoryProposition {
  return {
    ...proposition,
    jurisdictionCode: proposition.jurisdictionCode.toUpperCase(),
    statement: proposition.statement.replace(/\s+/g, " ").trim(),
    citation: {
      ...proposition.citation,
      citation: proposition.citation.citation?.replace(/\s+/g, " ").trim(),
    },
    normalizedValue: proposition.normalizedValue
      ? { ...proposition.normalizedValue }
      : undefined,
  };
}

export function sourceCandidateFromSecondary(
  jurisdictionCode: string,
  url: string,
  title: string,
  topics: ResearchTopic[] = RESEARCH_TOPICS.slice(0, 1),
): SourceCandidate {
  return {
    jurisdictionCode,
    url,
    title,
    kind: "secondary",
    authorityTier: "secondary_reference",
    relationship: "DISCOVERY_SOURCE",
    topics,
  };
}
