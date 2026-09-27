// ---------------------------------------------------------------------------
// Atlas Knowledge Layer — candidate KnowledgeItem construction
//
// Turns extracted PAGE TEXT into candidate knowledge records. The critical
// property: a candidate's `statement` is the document's own text, verbatim.
// This module never summarizes, paraphrases, corrects, categorizes by model
// judgement, or fills a gap. Granularity is chosen by deterministic rules
// (paragraph, then sentence fallback for very long blocks) so a page becomes a
// handful of coherent items rather than one giant blob.
//
// Every candidate carries `documentId` + `locator.page` (+ `locator.section`
// when a heading was detected). Ids are deterministic functions of the document
// version, page and block index, which makes re-running ingestion idempotent.
// ---------------------------------------------------------------------------

import type { KnowledgeItem } from "../types";
import { SOURCE_CLASSIFICATIONS } from "../types";
import {
  TRAINING_MANUAL_SOURCE_ID,
  TRAINING_MANUAL_TAGS,
  type TrainingManualTag,
} from "../training-manual";
import type { TrainingManualDocument } from "./types";

/** Maximum characters in a single candidate statement before sentence splitting. */
const MAX_BLOCK_CHARS = 1200;

/**
 * Keyword → tag map. A tag is applied only when its keyword ACTUALLY appears
 * in the extracted text, so tagging is deterministic evidence, not inference.
 */
const TAG_KEYWORDS: Array<{ tag: TrainingManualTag; pattern: RegExp }> = [
  { tag: "xactimate", pattern: /\bxactimate\b/i },
  { tag: "ACV", pattern: /\bACV\b|\bactual cash value\b/i },
  { tag: "RCV", pattern: /\bRCV\b|\breplacement cost value\b/i },
  { tag: "deductible", pattern: /\bdeductible\b/i },
  { tag: "depreciation", pattern: /\bdepreciat/i },
  { tag: "supplements", pattern: /\bsupplement/i },
  { tag: "denials", pattern: /\bdeni(?:al|ed|es)\b/i },
  { tag: "reinspection", pattern: /\breinspect/i },
  { tag: "adjuster", pattern: /\badjuster\b/i },
  { tag: "scope-of-work", pattern: /\bscope of work\b/i },
  { tag: "code-upgrades", pattern: /\bcode (?:upgrade|requirement)/i },
  { tag: "manufacturer-requirements", pattern: /\bmanufactur/i },
  { tag: "homeowner-education", pattern: /\bhomeowner\b/i },
  { tag: "contractor-ethics", pattern: /\bethic|\bintegrity\b/i },
  { tag: "fraud-prevention", pattern: /\bfraud\b/i },
  { tag: "storm-chasers", pattern: /\bstorm chaser/i },
  { tag: "public-adjuster", pattern: /\bpublic adjuster\b/i },
  { tag: "appraisal", pattern: /\bappraisal\b/i },
  { tag: "roofing", pattern: /\broof/i },
  { tag: "wind", pattern: /\bwind\b/i },
  { tag: "hail", pattern: /\bhail\b/i },
  { tag: "storm-damage", pattern: /\bstorm\b/i },
  { tag: "photography", pattern: /\bphotograph/i },
  { tag: "measurements", pattern: /\bmeasurement|\bmeasure\b/i },
  { tag: "estimates", pattern: /\bestimate\b/i },
];

const TAG_VOCAB = new Set<string>(TRAINING_MANUAL_TAGS);

/** A candidate item plus the extraction coordinates it came from. */
export interface CandidateItem {
  item: KnowledgeItem;
  page: number;
  section?: string;
  /** 0-indexed block position within the page. */
  block: number;
}

/** Split a block of text on blank lines into paragraph-level blocks. */
function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

/** Split an over-long block on sentence boundaries, never mid-sentence. */
function splitLongBlock(block: string): string[] {
  if (block.length <= MAX_BLOCK_CHARS) return [block];
  const sentences = block.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) ?? [block];
  const out: string[] = [];
  let buf = "";
  for (const sentence of sentences) {
    if (buf && (buf + sentence).length > MAX_BLOCK_CHARS) {
      out.push(buf.trim());
      buf = sentence;
    } else {
      buf = buf ? buf + sentence : sentence;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.length ? out : [block];
}

/** Deterministic tags for a block of text. */
function tagsFor(text: string): string[] {
  const tags = new Set<string>(["source-training-manual", "historical-2020-2021"]);
  for (const { tag, pattern } of TAG_KEYWORDS) {
    if (TAG_VOCAB.has(tag) && pattern.test(text)) tags.add(tag);
  }
  return [...tags];
}

/** Title derived from the document's own words (section, else first line). */
function titleFor(block: string, section: string | undefined): string {
  if (section) return section;
  const firstLine = block.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const t = firstLine.trim();
  return t.length > 80 ? `${t.slice(0, 77).trimEnd()}…` : t;
}

/**
 * Build candidate items from a document. Pages that were not read (OCR
 * unavailable, extraction failed, empty) produce NO candidates — there is no
 * text to state, so nothing is fabricated for them.
 */
export function buildCandidateItems(document: TrainingManualDocument): CandidateItem[] {
  const candidates: CandidateItem[] = [];
  const confidence = SOURCE_CLASSIFICATIONS.TRAINING_MANUAL.defaultConfidence;

  for (const page of document.pages) {
    const text = page.text.trim();
    if (!text) continue;

    const blocks = splitParagraphs(text).flatMap(splitLongBlock);
    blocks.forEach((block, index) => {
      candidates.push({
        page: page.pageNumber,
        section: page.section,
        block: index,
        item: {
          id: `tm_${document.version}_p${page.pageNumber}_${index}`,
          layer: "atlas_industry",
          sourceClassification: "TRAINING_MANUAL",
          sourceId: TRAINING_MANUAL_SOURCE_ID,
          documentId: document.documentId,
          title: titleFor(block, page.section),
          statement: block,
          knowledgeType: "training_guidance",
          industry: "insurance restoration",
          confidence,
          status: "draft",
          isInference: false,
          locator: {
            page: page.pageNumber,
            section: page.section,
            excerpt: block.slice(0, 100),
          },
          // The manual's statistics are associated with 2020-2021; the source
          // default is historical and the guardrail enforces the tag.
          temporalScope: "historical_context",
          tags: tagsFor(block),
          // Training guidance is a proposal to consider, never a confirmed
          // claim finding. The guardrail requires an explicit status.
          evidenceStatus: "supported_potential",
        },
      });
    });
  }

  return candidates;
}
