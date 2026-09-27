import { describe, expect, it } from "vitest";
import type { KnowledgeItem } from "../types";
import { TRAINING_MANUAL_SOURCE_ID } from "../training-manual";
import {
  classifyDuplicate,
  dedupeAgainstCorpus,
  fingerprintBytes,
  fingerprintItem,
  fnv1a,
  isContradictory,
  normalizeForFingerprint,
  textSimilarity,
} from "./dedup";

function item(overrides: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    id: "tm_a",
    layer: "atlas_industry",
    sourceClassification: "TRAINING_MANUAL",
    sourceId: TRAINING_MANUAL_SOURCE_ID,
    documentId: TRAINING_MANUAL_SOURCE_ID,
    title: "Documentation",
    statement: "Record every observed condition with photographs and measurements.",
    knowledgeType: "training_guidance",
    confidence: 0.55,
    status: "draft",
    isInference: false,
    locator: { page: 4 },
    temporalScope: "historical_context",
    ...overrides,
  };
}

describe("deterministic fingerprints", () => {
  it("is stable across calls and runtimes", () => {
    expect(fnv1a("documentation")).toBe(fnv1a("documentation"));
    expect(fingerprintItem(item())).toBe(fingerprintItem(item()));
    expect(fingerprintBytes(new Uint8Array([1, 2, 3]))).toBe(fingerprintBytes(new Uint8Array([1, 2, 3])));
  });

  it("changes when content changes", () => {
    expect(fingerprintBytes(new Uint8Array([1, 2, 3]))).not.toBe(fingerprintBytes(new Uint8Array([1, 2, 4])));
    expect(fingerprintItem(item())).not.toBe(fingerprintItem(item({ statement: "Different statement." })));
  });

  it("normalizes case and punctuation but keeps words", () => {
    expect(normalizeForFingerprint("Record, Every  Observation!")).toBe("record every observation");
  });

  it("scores identical text as 1 and unrelated text as low", () => {
    expect(textSimilarity("record every observation", "record every observation")).toBe(1);
    expect(textSimilarity("record every observation", "hail bruising on shingles")).toBeLessThan(0.4);
  });
});

describe("duplicate classification", () => {
  it("returns unique when nothing similar exists", () => {
    const d = classifyDuplicate(item(), [item({ id: "other", statement: "Unrelated concept entirely." })]);
    expect(d.verdict).toBe("unique");
    expect(d.mergeable).toBe(false);
  });

  it("classifies an identical same-source item as an exact duplicate that may merge", () => {
    const existing = item({ id: "tm_existing" });
    const d = classifyDuplicate(item({ id: "tm_incoming" }), [existing]);
    expect(d.verdict).toBe("exact_duplicate");
    expect(d.mergeable).toBe(true);
    expect(d.matchedId).toBe("tm_existing");
  });

  it("keeps a highly similar but differently-sourced item rather than merging it", () => {
    const existing = item({ id: "tm_existing" });
    const incoming = item({
      id: "tm_incoming",
      documentId: "a-different-document",
      statement: "Record every observed condition with photographs and measurement.",
    });
    const d = classifyDuplicate(incoming, [existing]);
    expect(d.verdict).not.toBe("unique");
    expect(d.mergeable).toBe(false);
  });

  it("keeps related-but-different concepts separate", () => {
    const existing = item({ id: "tm_existing", statement: "Record every observed condition with photographs." });
    const incoming = item({
      id: "tm_incoming",
      statement: "Record hail bruising locations and count strikes per square.",
    });
    const d = classifyDuplicate(incoming, [existing]);
    expect(["related", "unique"]).toContain(d.verdict);
  });

  it("never treats identical wording as identical authority", () => {
    const regulatory: KnowledgeItem = {
      ...item({ id: "kr_1" }),
      sourceClassification: "REGULATORY",
      sourceId: "src_reg",
      documentId: "reg-doc",
    };
    const d = classifyDuplicate(item({ id: "tm_incoming" }), [regulatory]);
    expect(d.verdict).toBe("exact_duplicate");
    // The existing regulatory record must survive; merging would erase it.
    expect(d.mergeable).toBe(false);
    expect(d.wouldEraseHigherAuthority).toBe(true);
  });

  it("flags contradictory content instead of silently merging", () => {
    const existing = item({ id: "tm_existing", statement: "A contractor must not fabricate measurements." });
    const incoming = item({ id: "tm_incoming", statement: "A contractor must fabricate measurements." });
    expect(isContradictory(incoming.statement, existing.statement)).toBe(true);
    const d = classifyDuplicate(incoming, [existing]);
    expect(d.verdict).toBe("contradictory");
    expect(d.mergeable).toBe(false);
  });

  it("produces one decision per incoming item and never mutates inputs", () => {
    const existing = [item({ id: "tm_existing" })];
    const incoming = [item({ id: "tm_incoming" })];
    const before = JSON.stringify(existing);
    const decisions = dedupeAgainstCorpus(incoming, existing);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].item.id).toBe("tm_incoming");
    expect(JSON.stringify(existing)).toBe(before);
  });
});
