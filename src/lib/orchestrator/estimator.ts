// ---------------------------------------------------------------------------
// Atlas Estimator / Xactimate Capability
//
// Produces structured line-item recommendations for insurance estimates.
// Since Atlas does NOT have direct Xactimate API access, it produces
// review-ready data that a human can input into Xactimate.
//
// The UI must clearly state:
//   "Atlas prepared this estimate data for review/input into Xactimate."
// ---------------------------------------------------------------------------

import type { ClaimSnapshot } from "../insurance/logic";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LineItemCategory =
  | "roofing"
  | "siding"
  | "gutters"
  | "windows"
  | "doors"
  | "interior"
  | "exterior"
  | "water"
  | "fire"
  | "mold"
  | "structural"
  | "contents"
  | "debris_removal"
  | "board_up"
  | "tarping"
  | "emergency"
  | "other";

export type LineItemStatus =
  | "identified"
  | "supported"
  | "partially_supported"
  | "unsupported"
  | "disputed";

export interface EstimateLineItem {
  id: string;
  category: LineItemCategory;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  totalPrice: number;
  source: string;
  evidence: string[];
  rationale: string;
  confidence: number;
  status: LineItemStatus;
  requiredHumanAction: boolean;
  humanNote: string;
}

export interface EstimateSummary {
  claimId: string;
  claimNumber: string | null;
  generatedAt: number;
  disclaimer: string;
  totalLineItems: number;
  supportedItems: number;
  disputedItems: number;
  unsupportedItems: number;
  identifiedItems: number;
  totalEstimatedValue: number;
  confidence: number;
  categories: Array<{
    category: LineItemCategory;
    itemCount: number;
    totalValue: number;
  }>;
}

// ---------------------------------------------------------------------------
// Estimator Engine
// ---------------------------------------------------------------------------

/**
 * Generate structured estimate line items from claim data.
 * This is deterministic — no AI calls, no fabrication.
 *
 * Produces items that represent:
 *   - Known scope from the claim
 *   - Missing scope that should be investigated
 *   - Discrepancies between documented and expected scope
 */
export function generateEstimateLineItems(
  claim: ClaimSnapshot,
  options: {
    documents?: Array<Record<string, unknown>>;
    findings?: Array<Record<string, unknown>>;
  } = {},
): EstimateLineItem[] {
  const items: EstimateLineItem[] = [];
  const ts = Date.now();

  // 1. Extract known scope from claim
  const knownScope = extractKnownScope(claim);
  items.push(...knownScope);

  // 2. Extract missing scope based on claim type / damage indicators
  const missingScope = extractMissingScope(claim);
  items.push(...missingScope);

  // 3. Cross-reference with findings
  if (options.findings && options.findings.length > 0) {
    const findingItems = extractFromFindings(
      options.findings,
      claim._id ? String(claim._id) : "",
    );
    items.push(...findingItems);
  }

  // 4. Estimate missing quantities where possible
  for (const item of items) {
    if (item.quantity === 0 && item.confidence > 0.3) {
      item.humanNote = "Quantity requires on-site verification";
      item.requiredHumanAction = true;
    }
    if (item.unitPrice === 0 && item.confidence > 0.3) {
      item.humanNote = "Pricing requires current market rates";
      item.requiredHumanAction = true;
    }
    item.totalPrice = item.quantity * item.unitPrice;
  }

  return items;
}

/**
 * Build estimate summary from line items.
 */
export function buildEstimateSummary(
  claimId: string,
  claimNumber: string | null,
  items: EstimateLineItem[],
): EstimateSummary {
  const supported = items.filter((i) => i.status === "supported");
  const disputed = items.filter((i) => i.status === "disputed");
  const unsupported = items.filter((i) => i.status === "unsupported");
  const identified = items.filter((i) => i.status === "identified");

  const categories: Record<string, { itemCount: number; totalValue: number }> =
    {};
  for (const item of items) {
    if (!categories[item.category]) {
      categories[item.category] = { itemCount: 0, totalValue: 0 };
    }
    categories[item.category].itemCount += 1;
    categories[item.category].totalValue += item.totalPrice;
  }

  const avgConfidence =
    items.length > 0
      ? items.reduce((sum, i) => sum + i.confidence, 0) / items.length
      : 0;

  return {
    claimId,
    claimNumber,
    generatedAt: Date.now(),
    disclaimer:
      "Atlas prepared this estimate data for review/input into Xactimate. " +
      "All quantities and pricing require verification by a qualified estimator.",
    totalLineItems: items.length,
    supportedItems: supported.length,
    disputedItems: disputed.length,
    unsupportedItems: unsupported.length,
    identifiedItems: identified.length,
    totalEstimatedValue: items.reduce((sum, i) => sum + i.totalPrice, 0),
    confidence: avgConfidence,
    categories: Object.entries(categories).map(([category, data]) => ({
      category: category as LineItemCategory,
      ...data,
    })),
  };
}

// ---------------------------------------------------------------------------
// Scope extraction (deterministic)
// ---------------------------------------------------------------------------

function extractKnownScope(claim: ClaimSnapshot): EstimateLineItem[] {
  const items: EstimateLineItem[] = [];
  const claimId = String(claim._id ?? "");

  // Use claim type / damage type to infer known scope
  const damageType = String(
    (claim as Record<string, unknown>).damageType ??
      (claim as Record<string, unknown>).damage_type ??
      "",
  ).toLowerCase();

  const description = String(
    (claim as Record<string, unknown>).description ?? "",
  ).toLowerCase();

  const amount =
    typeof (claim as Record<string, unknown>).estimatedAmount === "number"
      ? ((claim as Record<string, unknown>).estimatedAmount as number)
      : typeof (claim as Record<string, unknown>).approvedAmount === "number"
        ? ((claim as Record<string, unknown>).approvedAmount as number)
        : 0;

  // Water damage scope
  if (
    damageType.includes("water") ||
    damageType.includes("flood") ||
    description.includes("water") ||
    description.includes("leak") ||
    description.includes("flood")
  ) {
    items.push({
      id: `est:${claimId}:water:mitigation`,
      category: "water",
      description: "Water damage mitigation and drying",
      quantity: 1,
      unit: "ls",
      unitPrice: 0,
      totalPrice: 0,
      source: "claim_type_inference",
      evidence: ["claim.damageType"],
      rationale: "Water damage claim requires mitigation/drying scope",
      confidence: 0.8,
      status: "supported",
      requiredHumanAction: false,
      humanNote: "",
    });

    items.push({
      id: `est:${claimId}:water:recovery`,
      category: "water",
      description: "Water damage recovery and restoration",
      quantity: 0,
      unit: "sf",
      unitPrice: 0,
      totalPrice: 0,
      source: "claim_type_inference",
      evidence: ["claim.damageType"],
      rationale: "Water claims typically require restoration work",
      confidence: 0.7,
      status: "identified",
      requiredHumanAction: true,
      humanNote: "Square footage of affected area required",
    });
  }

  // Fire damage scope
  if (
    damageType.includes("fire") ||
    damageType.includes("smoke") ||
    description.includes("fire") ||
    description.includes("smoke")
  ) {
    items.push({
      id: `est:${claimId}:fire:board_up`,
      category: "board_up",
      description: "Emergency board-up and securing",
      quantity: 1,
      unit: "ls",
      unitPrice: 0,
      totalPrice: 0,
      source: "claim_type_inference",
      evidence: ["claim.damageType"],
      rationale: "Fire damage claims typically require emergency securing",
      confidence: 0.75,
      status: "supported",
      requiredHumanAction: false,
      humanNote: "",
    });

    items.push({
      id: `est:${claimId}:fire:debris`,
      category: "debris_removal",
      description: "Fire debris removal and cleanup",
      quantity: 0,
      unit: "cy",
      unitPrice: 0,
      totalPrice: 0,
      source: "claim_type_inference",
      evidence: ["claim.damageType"],
      rationale: "Fire damage claims typically require debris removal",
      confidence: 0.7,
      status: "identified",
      requiredHumanAction: true,
      humanNote: "Volume of debris requires on-site measurement",
    });
  }

  // Roof damage
  if (
    damageType.includes("roof") ||
    damageType.includes("hail") ||
    damageType.includes("wind") ||
    description.includes("roof") ||
    description.includes("hail")
  ) {
    items.push({
      id: `est:${claimId}:roof:replacement`,
      category: "roofing",
      description: "Roof replacement — shingles, underlayment, flashing",
      quantity: 0,
      unit: " squares",
      unitPrice: 0,
      totalPrice: 0,
      source: "claim_type_inference",
      evidence: ["claim.damageType"],
      rationale: "Roof damage claims require roof scope estimation",
      confidence: 0.8,
      status: "identified",
      requiredHumanAction: true,
      humanNote: "Roof measurements and material selection required",
    });

    items.push({
      id: `est:${claimId}:gutters:replacement`,
      category: "gutters",
      description: "Gutter and downspout replacement",
      quantity: 0,
      unit: "lf",
      unitPrice: 0,
      totalPrice: 0,
      source: "claim_type_inference",
      evidence: ["claim.damageType"],
      rationale: "Roof damage frequently includes gutter damage",
      confidence: 0.5,
      status: "identified",
      requiredHumanAction: true,
      humanNote: "Linear footage of gutters requires measurement",
    });
  }

  // Storm/wind damage
  if (
    damageType.includes("storm") ||
    damageType.includes("wind") ||
    description.includes("storm") ||
    description.includes("wind")
  ) {
    items.push({
      id: `est:${claimId}:siding:repair`,
      category: "siding",
      description: "Siding repair or replacement",
      quantity: 0,
      unit: "sf",
      unitPrice: 0,
      totalPrice: 0,
      source: "claim_type_inference",
      evidence: ["claim.damageType"],
      rationale: "Wind/storm damage often affects siding",
      confidence: 0.5,
      status: "identified",
      requiredHumanAction: true,
      humanNote: "Affected area measurement and material matching required",
    });
  }

  // If there is an approved amount, note it as context
  if (amount > 0) {
    items.push({
      id: `est:${claimId}:context:approved`,
      category: "other",
      description: `Carrier approved amount: $${amount.toLocaleString()}`,
      quantity: 1,
      unit: "ls",
      unitPrice: amount,
      totalPrice: amount,
      source: "claim_data",
      evidence: ["claim.approvedAmount"],
      rationale: "Reference: carrier-approved scope value",
      confidence: 1.0,
      status: "supported",
      requiredHumanAction: false,
      humanNote: "",
    });
  }

  return items;
}

function extractMissingScope(claim: ClaimSnapshot): EstimateLineItem[] {
  const items: EstimateLineItem[] = [];
  const claimId = String(claim._id ?? "");

  // Always include cleanup/general scope
  items.push({
    id: `est:${claimId}:general:cleanup`,
    category: "debris_removal",
    description: "General cleanup and debris removal",
    quantity: 0,
    unit: "ls",
    unitPrice: 0,
    totalPrice: 0,
    source: "universal_scope",
    evidence: [],
    rationale: "All property claims require cleanup scope assessment",
    confidence: 0.6,
    status: "identified",
    requiredHumanAction: true,
    humanNote: "Cleanup scope requires visual inspection",
  });

  // Contents inventory
  items.push({
    id: `est:${claimId}:contents:inventory`,
    category: "contents",
    description: "Contents inventory and pack-out",
    quantity: 0,
    unit: "ls",
    unitPrice: 0,
    totalPrice: 0,
    source: "universal_scope",
    evidence: [],
    rationale: "Contents may be affected — inventory required for coverage assessment",
    confidence: 0.4,
    status: "identified",
    requiredHumanAction: true,
    humanNote: "On-site contents inventory required if items were affected",
  });

  return items;
}

function extractFromFindings(
  findings: Array<Record<string, unknown>>,
  claimId: string,
): EstimateLineItem[] {
  const items: EstimateLineItem[] = [];

  for (const finding of findings) {
    const title = String(finding.title ?? finding.findingKey ?? "");
    const confidence =
      typeof finding.confidence === "number" ? finding.confidence : 0.5;
    const estimatedAmount =
      typeof finding.estimatedAmount === "number" ? finding.estimatedAmount : 0;

    if (confidence >= 0.5 && title) {
      items.push({
        id: `est:${claimId}:finding:${finding.findingKey ?? title.slice(0, 30)}`,
        category: "other",
        description: `Supplement opportunity: ${title}`,
        quantity: 1,
        unit: "ls",
        unitPrice: estimatedAmount,
        totalPrice: estimatedAmount,
        source: "finding_analysis",
        evidence: Array.isArray(finding.evidence) ? (finding.evidence as string[]) : [],
        rationale: String(finding.description ?? title),
        confidence,
        status: estimatedAmount > 0 ? "identified" : "unsupported",
        requiredHumanAction: true,
        humanNote: "Requires estimator review and Xactimate input",
      });
    }
  }

  return items;
}
