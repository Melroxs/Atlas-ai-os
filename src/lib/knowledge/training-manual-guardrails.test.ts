import { describe, it, expect } from "vitest";
import type { KnowledgeItem, KnowledgeRetrievalResult } from "./types";
import {
  TRAINING_MANUAL_SOURCE,
  TRAINING_MANUAL_SOURCE_ID,
  TRAINING_MANUAL_TAGS,
  TRAINING_MANUAL_DOMAINS,
  TRAINING_MANUAL_MAX_PRIORITY_RANK,
  CONTENT_INGESTED,
  MISSING_INPUT,
  OBSERVATION_LAYERS,
  CONDITION_CLASSIFICATIONS,
  CLAIM_ANALYSIS_SEQUENCE,
  EVIDENCE_STATUSES,
  FACT_PRESENTING_STATUSES,
  REGULATED_BOUNDARY_TOPICS,
  REGULATED_ROLES,
  RETRIEVAL_PRIORITY,
  PROHIBITED_PRACTICES,
  ATTRIBUTION_FORMS,
  OPERATIONAL_PRINCIPLE,
  COVERAGE_DETERMINATION_REFUSAL,
  isTrainingManualSource,
  isTrainingManualClassification,
} from "./training-manual";
import {
  validateTrainingManualItem,
  isProhibitedPracticeText,
  applyAuthorityFloor,
  isTrainingManualResult,
  requiresCurrentAuthorityVerification,
  isCoverageDeterminationRequest,
  renderForReasoning,
  formatProvenance,
  TRAINING_MANUAL_RELEVANCE_CEILING,
  TRAINING_MANUAL_VOCABULARY,
  AUTHORITY_FLOOR_CONSISTENT,
  HISTORICAL_PREFIX,
  COVERAGE_DETERMINATION_HANDOFF,
  type GuardrailResult,
} from "./training-manual-guardrails";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function manualItem(overrides: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    id: "km_1",
    layer: "atlas_industry",
    sourceClassification: "TRAINING_MANUAL",
    sourceId: TRAINING_MANUAL_SOURCE_ID,
    title: "Annual pricing below twelve monthly payments",
    statement: "Annual contract pricing is set below the equivalent of twelve monthly payments.",
    knowledgeType: "training_guidance",
    confidence: 0.55,
    status: "active",
    isInference: false,
    locator: { page: 42, section: "Estimating" },
    temporalScope: "historical_context",
    tags: ["historical-2020-2021", "estimates"],
    evidenceStatus: "confirmed_finding",
    ...overrides,
  };
}

function result(overrides: Partial<KnowledgeRetrievalResult> = {}): KnowledgeRetrievalResult {
  return {
    item: manualItem(),
    relevance: 0.95,
    retrievalMethod: "keyword",
    sourceClassification: "TRAINING_MANUAL",
    layer: "atlas_industry",
    provenance: {
      sourceId: TRAINING_MANUAL_SOURCE_ID,
      sourceName: TRAINING_MANUAL_SOURCE.sourceTitle,
      organization: TRAINING_MANUAL_SOURCE.organization,
      authorityTier: TRAINING_MANUAL_SOURCE.authorityTier,
      sourceType: TRAINING_MANUAL_SOURCE.sourceType,
      status: "active",
    },
    ...overrides,
  };
}

function rules(result_: GuardrailResult): string[] {
  return result_.violations.map((v) => v.rule);
}

function regulatoryResult(): KnowledgeRetrievalResult {
  return {
    item: {
      id: "kr_1",
      layer: "atlas_industry",
      sourceClassification: "REGULATORY",
      title: "Current building code requirement",
      statement: "The applicable code requires this work.",
      knowledgeType: "requirement",
      confidence: 0.9,
      status: "active",
      isInference: false,
    },
    relevance: 0.62,
    retrievalMethod: "keyword",
    sourceClassification: "REGULATORY",
    layer: "atlas_industry",
  };
}

// ---------------------------------------------------------------------------
// §1 Source identity and provenance
// ---------------------------------------------------------------------------

describe("training manual source registration", () => {
  it("registers the manual as a non-authoritative trade training source", () => {
    expect(TRAINING_MANUAL_SOURCE.sourceTitle).toBe(
      "Christian Construction Insurance Education Manual",
    );
    expect(TRAINING_MANUAL_SOURCE.documentType).toBe("insurance_restoration_training_manual");
    expect(TRAINING_MANUAL_SOURCE.approximatePageCount).toBe(114);
    expect(TRAINING_MANUAL_SOURCE.authorityTier).toBe("tier3_training_reference");
    expect(TRAINING_MANUAL_SOURCE.authoritativeAttribution).toBe(false);
  });

  it("never claims to be a current legal, coverage or carrier authority", () => {
    expect(TRAINING_MANUAL_SOURCE.currentStatusRule).toMatch(/never/i);
    expect(TRAINING_MANUAL_SOURCE.statisticalEra).toEqual({ from: 2020, to: 2021 });
    expect(TRAINING_MANUAL_SOURCE.defaultTemporalScope).toBe("historical_context");
  });

  it("registers the source as awaiting its document rather than ingested", () => {
    expect(CONTENT_INGESTED).toBe(false);
    expect(TRAINING_MANUAL_SOURCE.ingestionState).toBe("awaiting_document");
    expect(TRAINING_MANUAL_SOURCE.contentIngested).toBe(false);
    expect(MISSING_INPUT.reason).toMatch(/not present/i);
  });

  it("ships no invented knowledge: domains are structure, not claims", () => {
    for (const domain of TRAINING_MANUAL_DOMAINS) {
      expect(domain).not.toHaveProperty("statement");
      expect(domain).not.toHaveProperty("claims");
      expect(domain).not.toHaveProperty("content");
      // Every domain must carry a real boundary statement.
      expect(domain.boundary.length).toBeGreaterThan(20);
    }
  });

  it("identifies its own source", () => {
    expect(isTrainingManualSource(TRAINING_MANUAL_SOURCE_ID)).toBe(true);
    expect(isTrainingManualSource("src_other")).toBe(false);
    expect(isTrainingManualSource(undefined)).toBe(false);
    expect(isTrainingManualClassification("TRAINING_MANUAL")).toBe(true);
    expect(isTrainingManualClassification("REGULATORY")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §18 Tags
// ---------------------------------------------------------------------------

describe("training manual tag vocabulary", () => {
  it("carries every required searchable tag", () => {
    const required = [
      "insurance-restoration", "roofing", "wind", "hail", "storm-damage",
      "property-claims", "claim-inspection", "damage-documentation", "photography",
      "measurements", "estimates", "xactimate", "ACV", "RCV", "depreciation",
      "deductible", "supplements", "denials", "reinspection", "adjuster",
      "scope-of-work", "code-upgrades", "manufacturer-requirements",
      "homeowner-education", "contractor-ethics", "fraud-prevention", "storm-chasers",
      "retail-roofing", "public-adjuster", "appraisal", "claim-process",
      "roofing-safety", "historical-2020-2021", "source-training-manual",
    ];
    for (const tag of required) expect(TRAINING_MANUAL_TAGS).toContain(tag);
    expect(TRAINING_MANUAL_TAGS.length).toBe(required.length);
  });

  it("has no duplicate tags", () => {
    expect(new Set(TRAINING_MANUAL_TAGS).size).toBe(TRAINING_MANUAL_TAGS.length);
  });

  it("tags every domain with real, registered tags", () => {
    for (const domain of TRAINING_MANUAL_DOMAINS) {
      expect(domain.tags.length).toBeGreaterThan(0);
      for (const tag of domain.tags) expect(TRAINING_MANUAL_TAGS).toContain(tag);
    }
  });
});

// ---------------------------------------------------------------------------
// §2/§3/§4/§7/§11 Structure
// ---------------------------------------------------------------------------

describe("training manual knowledge structure", () => {
  it("models the full domain set with purposes and boundaries", () => {
    expect(TRAINING_MANUAL_DOMAINS.length).toBe(13);
    for (const id of [
      "industry", "ethics", "insurance-fundamentals", "claim-workflow", "inspection",
      "documentation", "estimating", "condition-classification", "adjuster-interaction",
      "approvals-and-supplements", "homeowner-education", "business-models",
      "legal-regulatory",
    ]) {
      expect(TRAINING_MANUAL_DOMAINS.some((d) => d.id === id)).toBe(true);
    }
  });

  it("keeps the four observation layers distinct and forbids collapsing them", () => {
    expect(OBSERVATION_LAYERS.map((l) => l.id)).toEqual([
      "observed_evidence",
      "interpretation",
      "claim_relevance",
      "coverage_determination",
    ]);
    for (const layer of OBSERVATION_LAYERS) {
      expect(layer.mustNotConclude.length).toBeGreaterThan(0);
    }
    const coverage = OBSERVATION_LAYERS.find((l) => l.id === "coverage_determination")!;
    expect(coverage.mayConclude).toMatch(/nothing on atlas/i);
  });

  it("treats unresolved as a legitimate terminal classification", () => {
    const ids = CONDITION_CLASSIFICATIONS.map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "storm_related", "pre_existing", "wear_and_tear", "maintenance",
        "workmanship", "code_related", "unresolved",
      ]),
    );
    const unresolved = CONDITION_CLASSIFICATIONS.find((c) => c.id === "unresolved")!;
    expect(unresolved.definition).toMatch(/legitimate terminal classification/i);
  });

  it("models the nine-step claim analysis sequence in order", () => {
    expect(CLAIM_ANALYSIS_SEQUENCE.map((s) => s.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(CLAIM_ANALYSIS_SEQUENCE[0].id).toBe("identify_reported_loss");
    expect(CLAIM_ANALYSIS_SEQUENCE[8].id).toBe("evidence_backed_recommendation");
  });

  it("keeps regulated roles separate from contractor activities", () => {
    const roles = REGULATED_ROLES.map((r) => r.role);
    expect(roles).toEqual(expect.arrayContaining(["insurer", "public adjuster", "attorney"]));
  });
});

// ---------------------------------------------------------------------------
// §15 Confirmed vs proposed
// ---------------------------------------------------------------------------

describe("confirmed vs proposed separation", () => {
  it("only a confirmed finding may be presented as fact", () => {
    expect(FACT_PRESENTING_STATUSES).toEqual(["confirmed_finding"]);
    for (const status of EVIDENCE_STATUSES) {
      if (status.id !== "confirmed_finding") {
        expect(status.mayBePresentedAs).not.toBe("fact");
      }
    }
  });

  it("includes the full step-8 classification vocabulary", () => {
    expect(EVIDENCE_STATUSES.map((s) => s.id)).toEqual(
      expect.arrayContaining([
        "confirmed_finding", "supported_potential", "documentation_gap",
        "unresolved", "not_supported",
      ]),
    );
  });

  it("rejects an unknown evidence status", () => {
    const r = validateTrainingManualItem(manualItem({ evidenceStatus: "looks_good_to_me" }));
    expect(r.valid).toBe(false);
    expect(rules(r)).toContain("invalid_evidence_status");
  });

  it("warns when no evidence status is set, because a discrepancy is not automatically a supplement", () => {
    const r = validateTrainingManualItem(manualItem({ evidenceStatus: undefined }));
    expect(r.valid).toBe(true);
    expect(rules(r)).toContain("proposed_presented_as_fact");
  });
});

// ---------------------------------------------------------------------------
// §1 Page-level provenance
// ---------------------------------------------------------------------------

describe("page-level provenance is mandatory", () => {
  it("rejects a manual item with no page or section", () => {
    const r = validateTrainingManualItem(manualItem({ locator: undefined }));
    expect(r.valid).toBe(false);
    expect(rules(r)).toContain("missing_locator");
  });

  it("rejects a blank section with no page", () => {
    const r = validateTrainingManualItem(manualItem({ locator: { section: "   " } }));
    expect(r.valid).toBe(false);
    expect(rules(r)).toContain("missing_locator");
  });

  it("accepts a section-only locator", () => {
    const r = validateTrainingManualItem(manualItem({ locator: { section: "Ethics" } }));
    expect(rules(r)).not.toContain("missing_locator");
  });

  it("accepts a page-only locator", () => {
    const r = validateTrainingManualItem(manualItem({ locator: { page: 17 } }));
    expect(rules(r)).not.toContain("missing_locator");
  });

  it("accepts a fully specified, valid item", () => {
    expect(validateTrainingManualItem(manualItem()).valid).toBe(true);
  });

  it("does not apply manual rules to items from another source", () => {
    const r = validateTrainingManualItem(
      manualItem({ sourceClassification: "REGULATORY", sourceId: "src_other", locator: undefined }),
    );
    expect(rules(r)).toEqual(["unknown_source"]);
  });

  it("treats sourceId alone as sufficient to apply the rules", () => {
    const r = validateTrainingManualItem(
      manualItem({ sourceClassification: "ATLAS_CURATED", sourceId: TRAINING_MANUAL_SOURCE_ID, locator: undefined }),
    );
    expect(r.valid).toBe(false);
    expect(rules(r)).toContain("missing_locator");
  });
});

// ---------------------------------------------------------------------------
// §13 Historical data rule
// ---------------------------------------------------------------------------

describe("historical data rule", () => {
  it("defaults an unmarked manual item to historical context", () => {
    const r = validateTrainingManualItem(manualItem({ temporalScope: undefined }));
    expect(r.valid).toBe(true);
    expect(rules(r)).toContain("missing_temporal_scope");
    expect(r.coerced?.temporalScope).toBe("historical_context");
  });

  it("coerces the historical tag onto historical items", () => {
    const r = validateTrainingManualItem(manualItem({ tags: ["estimates"] }));
    expect(rules(r)).toContain("historical_tag_missing");
    expect(r.coerced?.tags).toContain("historical-2020-2021");
  });

  it("rejects an unknown temporal scope", () => {
    const r = validateTrainingManualItem(
      manualItem({ temporalScope: "recent" as unknown as "current" }),
    );
    expect(r.valid).toBe(false);
    expect(rules(r)).toContain("missing_temporal_scope");
  });

  it("does not demand the historical tag on a current-scope item", () => {
    const r = validateTrainingManualItem(
      manualItem({ temporalScope: "current", tags: ["code-upgrades"] }),
    );
    expect(rules(r)).not.toContain("historical_tag_missing");
  });
});

// ---------------------------------------------------------------------------
// §19 / §9 Integrity
// ---------------------------------------------------------------------------

describe("prohibited practices are rejected, warnings are not", () => {
  const directives = [
    "Inflate the quantities on the estimate to raise the total.",
    "Add scope items to increase the claim value.",
    "Pad the estimate with line items the carrier did not request.",
    "Invent a measurement where none was taken.",
    "Fabricate evidence to support the code upgrade.",
    "Create a false damage narrative for the insurer.",
    "Hide the discrepancy between the two estimates.",
    "Misrepresent the condition of the decking.",
    "Pressure the adjuster into approving the change order.",
    "Charge the homeowner for the deductible and keep the difference.",
    "Submit different invoices to different insurers.",
    "Collect the insurance money before completing the work.",
    "Exaggerate the damage to strengthen the claim.",
  ];

  for (const text of directives) {
    it(`rejects: "${text.slice(0, 44)}..."`, () => {
      expect(isProhibitedPracticeText(text)).toBe(true);
      const r = validateTrainingManualItem(manualItem({ statement: text, title: "Scope" }));
      expect(r.valid).toBe(false);
      expect(rules(r)).toContain("prohibited_practice");
    });
  }

  const warnings = [
    "Never fabricate evidence; a fabricated photograph is insurance fraud.",
    "Contractors must not inflate the quantities on an estimate.",
    "Submitting different invoices to different parties is a violation of ethics.",
    "Claims padding is a common red flag for claim-fraud investigators.",
    "Storm chasers are warned against aggressive solicitation of homeowners.",
  ];

  for (const text of warnings) {
    it(`permits the integrity warning: "${text.slice(0, 44)}..."`, () => {
      expect(isProhibitedPracticeText(text)).toBe(false);
      const r = validateTrainingManualItem(manualItem({ statement: text, title: "Ethics" }));
      expect(r.valid).toBe(true);
    });
  }

  it("catalogues every prohibited practice from the operating charter", () => {
    for (const practice of [
      "manufacture claim value",
      "generate unsupported supplements",
      "encourage deductible manipulation",
      "fabricate evidence",
      "hide discrepancies",
      "circumvent policy exclusions",
      "mislead homeowners",
      "mislead adjusters",
    ]) {
      expect(PROHIBITED_PRACTICES).toContain(practice);
    }
  });

  it("states the operating principle and the non-maximization objective", () => {
    expect(OPERATIONAL_PRINCIPLE).toContain("Never fabricate or manipulate evidence.");
    expect(OPERATIONAL_PRINCIPLE).toContain("Respect policy and regulatory boundaries.");
    expect(OPERATIONAL_PRINCIPLE.length).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// §12 Legal and regulatory safety layer
// ---------------------------------------------------------------------------

describe("the manual is never the legal or coverage authority", () => {
  const authorityClaims = [
    "The law requires the deductible to be reimbursed.",
    "Under the current regulation, this work must be performed.",
    "The carrier requires a signed supplement for this scope.",
    "The insurer will pay for the code upgrade.",
    "The policy guarantees coverage for this damage.",
    "This loss is covered under the policy.",
  ];

  for (const text of authorityClaims) {
    it(`rejects the authority claim: "${text}"`, () => {
      const r = validateTrainingManualItem(manualItem({ statement: text, title: "Coverage" }));
      expect(r.valid).toBe(false);
      expect(rules(r)).toContain("legal_authority_claim");
    });
  }

  const coverageQuestions = [
    "Will the insurer cover the decking replacement?",
    "Is this claimable under the policy?",
    "What will the carrier approve for this scope?",
    "Should we report this as a water claim?",
  ];

  for (const text of coverageQuestions) {
    it(`rejects the coverage determination: "${text}"`, () => {
      const r = validateTrainingManualItem(manualItem({ statement: text, title: "Claim" }));
      expect(r.valid).toBe(false);
      expect(rules(r)).toContain("coverage_determination");
    });
  }

  it("flags regulated topics for verification against a current authority", () => {
    for (const topic of REGULATED_BOUNDARY_TOPICS) {
      expect(requiresCurrentAuthorityVerification(`Question about ${topic}`)).toBe(true);
    }
    expect(requiresCurrentAuthorityVerification("How do I document a damaged shingle?")).toBe(false);
  });

  it("detects coverage determination requests", () => {
    expect(isCoverageDeterminationRequest("Will the insurer cover this?")).toBe(true);
    expect(isCoverageDeterminationRequest("What documentation is needed?")).toBe(false);
  });

  it("defers coverage decisions and still offers legitimate assistance", () => {
    expect(COVERAGE_DETERMINATION_REFUSAL).toMatch(/applicable policy/i);
    expect(COVERAGE_DETERMINATION_HANDOFF.deferTo.length).toBeGreaterThan(0);
    expect(COVERAGE_DETERMINATION_HANDOFF.mayStillAssistWith).toContain(
      "identifying documentation gaps",
    );
  });

  it("requires attribution language that marks the source as training", () => {
    expect(ATTRIBUTION_FORMS).toContain("The manual states...");
    expect(ATTRIBUTION_FORMS).toContain("According to the manual...");
    expect(
      ATTRIBUTION_FORMS.some((a) => /training principle rather than a current legal requirement/i.test(a)),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §16 Authority floor at retrieval time
// ---------------------------------------------------------------------------

describe("authority floor", () => {
  it("places the manual second-to-last in retrieval priority", () => {
    expect(RETRIEVAL_PRIORITY).toHaveLength(8);
    expect(RETRIEVAL_PRIORITY[0].source).toMatch(/policy/i);
    const manualRank = RETRIEVAL_PRIORITY.find((r) => r.sourceId === TRAINING_MANUAL_SOURCE_ID)!;
    expect(manualRank.rank).toBe(TRAINING_MANUAL_MAX_PRIORITY_RANK);
    expect(manualRank.rank).toBe(7);
    expect(RETRIEVAL_PRIORITY[7].source).toMatch(/inference/i);
  });

  it("identifies manual-sourced results", () => {
    expect(isTrainingManualResult(result())).toBe(true);
    expect(isTrainingManualResult(regulatoryResult())).toBe(false);
  });

  it("caps manual relevance below the ceiling", () => {
    const r = result({ relevance: 0.98 });
    applyAuthorityFloor([r]);
    expect(r.relevance).toBe(TRAINING_MANUAL_RELEVANCE_CEILING);
  });

  it("never lets a highly relevant manual outrank a current regulatory source", () => {
    const manual = result({ relevance: 0.98 });
    const regulatory = regulatoryResult();
    const ranked = applyAuthorityFloor([manual, regulatory]);
    expect(ranked[0].sourceClassification).toBe("REGULATORY");
    expect(ranked[0].relevance).toBeGreaterThan(ranked[1].relevance);
  });

  it("stamps historical scope and evidence status onto unmarked manual items", () => {
    const unmarked = result();
    delete unmarked.item.temporalScope;
    delete unmarked.item.evidenceStatus;
    applyAuthorityFloor([unmarked]);
    expect(unmarked.temporalScope).toBe("historical_context");
    expect(unmarked.evidenceStatus).toBe("supported_potential");
  });

  it("carries the page locator through to the result", () => {
    const r = result();
    applyAuthorityFloor([r]);
    expect(r.locator?.page).toBe(42);
  });

  it("leaves non-manual results untouched", () => {
    const regulatory = regulatoryResult();
    applyAuthorityFloor([regulatory]);
    expect(regulatory.relevance).toBe(0.62);
    expect(regulatory.temporalScope).toBeUndefined();
  });

  it("keeps the enforced ceiling consistent with the documented ranking", () => {
    expect(AUTHORITY_FLOOR_CONSISTENT).toBe(true);
    expect(TRAINING_MANUAL_VOCABULARY.maxPriorityRank).toBe(7);
    expect(TRAINING_MANUAL_VOCABULARY.contentIngested).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §17 Rendering with provenance
// ---------------------------------------------------------------------------

describe("historical and provenance rendering", () => {
  it("marks historical context in the rendered statement", () => {
    const text = renderForReasoning(result());
    expect(text.startsWith(HISTORICAL_PREFIX)).toBe(true);
    expect(text).toMatch(/Historical context/);
  });

  it("includes source, page and section in the provenance suffix", () => {
    const suffix = formatProvenance(result());
    expect(suffix).toContain("source: Christian Construction Insurance Education Manual");
    expect(suffix).toContain("p. 42");
    expect(suffix).toContain("section: Estimating");
    expect(suffix).toMatch(/not a current legal or coverage authority/i);
  });

  it("marks historical scope but not current scope", () => {
    const current = result();
    current.temporalScope = "current";
    current.item.temporalScope = "current";
    const text = renderForReasoning(current);
    expect(text).not.toContain(HISTORICAL_PREFIX);
    expect(text).not.toMatch(/Historical context/);
  });

  it("omits a page marker when the source has no page locator", () => {
    const noPage = result();
    delete noPage.locator;
    delete noPage.item.locator;
    expect(formatProvenance(noPage)).not.toContain("p. ");
  });
});

// ---------------------------------------------------------------------------
// Vocabulary export
// ---------------------------------------------------------------------------

describe("exported vocabulary", () => {
  it("exposes the controlled vocabularies to the reasoning layer", () => {
    expect(TRAINING_MANUAL_VOCABULARY.observationLayers).toHaveLength(4);
    expect(TRAINING_MANUAL_VOCABULARY.conditionClassifications).toContain("unresolved");
    expect(TRAINING_MANUAL_VOCABULARY.evidenceStatuses).toHaveLength(5);
    expect(TRAINING_MANUAL_VOCABULARY.factPresentingStatuses).toEqual(["confirmed_finding"]);
    expect(TRAINING_MANUAL_VOCABULARY.prohibitedPractices.length).toBeGreaterThan(10);
    expect(TRAINING_MANUAL_VOCABULARY.relevanceCeiling).toBe(TRAINING_MANUAL_RELEVANCE_CEILING);
  });
});
