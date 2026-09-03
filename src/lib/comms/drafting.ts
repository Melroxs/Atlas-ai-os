// ---------------------------------------------------------------------------
// Atlas Communication Drafting Engine
//
// Generates structured drafts for:
//   - Carrier/supplement correspondence
//   - Customer status updates
//   - Internal notes and escalation messages
//   - Adjuster communications
//   - Follow-up reminders
//
// CRITICAL: Every draft is assembled from actual claim/company context.
// Atlas must never fabricate:
//   - claim facts, amounts, or dates
//   - policy provisions
//   - conversations or approvals
//   - actions supposedly taken
//
// All drafts require human review before sending.
// ---------------------------------------------------------------------------

import type { ClaimSnapshot, SupplementDocument } from "../insurance/logic";

// ---------------------------------------------------------------------------
// Draft types
// ---------------------------------------------------------------------------

export type DraftType =
  | "supplement_narrative"
  | "carrier_correspondence"
  | "customer_status_update"
  | "adjuster_followup"
  | "internal_note"
  | "escalation_message"
  | "payment_followup"
  | "document_request";

export type DraftTone = "formal" | "professional" | "friendly" | "urgent";

export interface DraftRecipient {
  name?: string;
  role: string; // "carrier", "adjuster", "customer", "internal", "manager"
  email?: string;
}

export interface DraftContext {
  claim: ClaimSnapshot;
  supplement?: SupplementDocument;
  supplements?: Array<Record<string, unknown>>;
  findings?: Array<Record<string, unknown>>;
  reconciliation?: {
    estimate?: number;
    invoiced?: number;
    paid: number;
    outstanding: number;
    notes: string[];
    hasDiscrepancy: boolean;
  };
  completeness?: {
    score: number;
    summary: string;
  };
  additionalContext?: Record<string, unknown>;
}

export interface CommunicationDraft {
  draftType: DraftType;
  subject: string;
  body: string;
  recipient: DraftRecipient;
  tone: DraftTone;
  evidenceUsed: string[];
  disclaimers: string[];
  requiresHumanReview: true; // Always true
  readyToSend: false; // Always false — human must review
  generatedAt: number;
}

// ---------------------------------------------------------------------------
// Main drafting function
// ---------------------------------------------------------------------------

export function generateDraft(
  draftType: DraftType,
  ctx: DraftContext,
  options: { tone?: DraftTone; recipient?: DraftRecipient } = {},
): CommunicationDraft {
  const tone = options.tone ?? "professional";
  const recipient = options.recipient ?? inferRecipient(draftType, ctx);

  switch (draftType) {
    case "supplement_narrative":
      return generateSupplementNarrative(ctx, tone, recipient);
    case "carrier_correspondence":
      return generateCarrierCorrespondence(ctx, tone, recipient);
    case "customer_status_update":
      return generateCustomerStatusUpdate(ctx, tone, recipient);
    case "adjuster_followup":
      return generateAdjusterFollowup(ctx, tone, recipient);
    case "internal_note":
      return generateInternalNote(ctx, tone, recipient);
    case "escalation_message":
      return generateEscalationMessage(ctx, tone, recipient);
    case "payment_followup":
      return generatePaymentFollowup(ctx, tone, recipient);
    case "document_request":
      return generateDocumentRequest(ctx, tone, recipient);
  }
}

// ---------------------------------------------------------------------------
// Supplement narrative
// ---------------------------------------------------------------------------

function generateSupplementNarrative(
  ctx: DraftContext,
  tone: DraftTone,
  recipient: DraftRecipient,
): CommunicationDraft {
  const { claim, supplement, findings } = ctx;
  const evidenceUsed: string[] = [];
  const lines: string[] = [];

  lines.push(`RE: Supplement Request — Claim ${claim.claimNumber ?? "N/A"}`);
  lines.push("");
  lines.push(`Date of Loss: ${formatDate(claim.dateOfLoss)}`);
  lines.push(`Property: ${claim.property ?? "N/A"}`);
  lines.push(`Insured: ${claim.customer ?? "N/A"}`);
  lines.push(`Carrier: ${claim.carrier ?? "N/A"}`);
  lines.push(`Policy: ${claim.policy ?? "N/A"}`);
  if (claim.adjuster) {
    lines.push(`Adjuster: ${claim.adjuster}`);
  }
  lines.push("");
  lines.push("Dear " + (recipient.name ?? "To Whom It May Concern") + ",");
  lines.push("");

  // Reason
  if (supplement?.reason) {
    lines.push(`We are writing to request a supplement for the above-referenced claim. ${supplement.reason}`);
    evidenceUsed.push("supplement.reason");
  } else {
    lines.push("We are writing to request a supplement for the above-referenced claim based on scope items identified during the course of restoration work.");
  }

  // Original estimate
  if (typeof claim.estimateAmount === "number") {
    lines.push("");
    lines.push(`The original insurance estimate was $${claim.estimateAmount.toLocaleString()}.`);
    evidenceUsed.push("claim.estimateAmount");
  }

  // Findings
  if (findings && findings.length > 0) {
    lines.push("");
    lines.push("During our review, we identified the following items that were not adequately addressed in the original scope:");

    for (const f of findings) {
      const title = (f.title as string) ?? "Item";
      const description = (f.description as string) ?? "";
      const amount = f.estimatedAmount as number | undefined;
      lines.push(`  • ${title}${amount ? ` ($${amount.toLocaleString()})` : ""}`);
      if (description) {
        lines.push(`    ${description}`);
      }
      evidenceUsed.push(`finding:${f._id ?? title}`);
    }
  }

  // Evidence
  if (supplement?.sections) {
    for (const section of supplement.sections) {
      if (section.title === "Supporting evidence" && section.body.length > 0) {
        lines.push("");
        lines.push("Supporting documentation includes:");
        for (const item of section.body) {
          if (item && !item.startsWith("No supporting")) {
            lines.push(`  • ${item}`);
          }
        }
      }
    }
  }

  // Requested amount
  if (supplement?.requestedAmount) {
    lines.push("");
    lines.push(`The total amount requested for this supplement is $${supplement.requestedAmount.toLocaleString()}.`);
    evidenceUsed.push("supplement.requestedAmount");
  }

  // Closing
  lines.push("");
  lines.push("We respectfully request review and approval of this supplement. Please do not hesitate to contact us if additional documentation is required.");
  lines.push("");
  lines.push("Sincerely,");
  lines.push("[Your Name / Company Name]");

  return {
    draftType: "supplement_narrative",
    subject: `Supplement Request — Claim ${claim.claimNumber ?? "N/A"}`,
    body: lines.join("\n"),
    recipient,
    tone,
    evidenceUsed,
    disclaimers: [
      "This draft is assembled from available claim records and requires human review before sending.",
      "All dollar amounts are sourced from claim data — verify against the actual estimate and supporting documents.",
      "Coverage terms, policy provisions, and carrier requirements are NOT asserted — confirm against the actual policy.",
    ],
    requiresHumanReview: true,
    readyToSend: false,
    generatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Carrier correspondence
// ---------------------------------------------------------------------------

function generateCarrierCorrespondence(
  ctx: DraftContext,
  tone: DraftTone,
  recipient: DraftRecipient,
): CommunicationDraft {
  const { claim, reconciliation } = ctx;
  const evidenceUsed: string[] = [];
  const lines: string[] = [];

  lines.push(`RE: Claim ${claim.claimNumber ?? "N/A"} — ${claim.property ?? "Property"}`);
  lines.push("");
  lines.push(`Date of Loss: ${formatDate(claim.dateOfLoss)}`);
  lines.push(`Insured: ${claim.customer ?? "N/A"}`);
  lines.push(`Carrier: ${claim.carrier ?? "N/A"}`);
  lines.push("");
  lines.push(`Dear ${recipient.name ?? "Claims Department"},`);
  lines.push("");

  if (reconciliation?.hasDiscrepancy && reconciliation.notes.length > 0) {
    lines.push("We are writing regarding the above-referenced claim and have identified discrepancies in the current records:");
    lines.push("");
    for (const note of reconciliation.notes) {
      lines.push(`  • ${note}`);
    }
    evidenceUsed.push("reconciliation");
  } else {
    lines.push("We are writing to follow up on the above-referenced claim and request an update on its current status.");
  }

  if (typeof claim.estimateAmount === "number" && typeof claim.paymentAmount === "number") {
    const outstanding = claim.estimateAmount - claim.paymentAmount;
    if (outstanding > 0) {
      lines.push("");
      lines.push(`Based on our records, there is an outstanding balance of $${outstanding.toLocaleString()} (estimate: $${claim.estimateAmount.toLocaleString()}, payments received: $${claim.paymentAmount.toLocaleString()}).`);
      evidenceUsed.push("claim.estimateAmount", "claim.paymentAmount");
    }
  }

  lines.push("");
  lines.push("Please advise on the next steps required to resolve this matter.");
  lines.push("");
  lines.push("Sincerely,");
  lines.push("[Your Name / Company Name]");

  return {
    draftType: "carrier_correspondence",
    subject: `Claim ${claim.claimNumber ?? "N/A"} — Follow-Up`,
    body: lines.join("\n"),
    recipient,
    tone,
    evidenceUsed,
    disclaimers: [
      "This draft is assembled from available claim records and requires human review.",
      "Verify all financial figures against the actual carrier statement before sending.",
    ],
    requiresHumanReview: true,
    readyToSend: false,
    generatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Customer status update
// ---------------------------------------------------------------------------

function generateCustomerStatusUpdate(
  ctx: DraftContext,
  tone: DraftTone,
  recipient: DraftRecipient,
): CommunicationDraft {
  const { claim, completeness, reconciliation } = ctx;
  const evidenceUsed: string[] = [];
  const lines: string[] = [];

  lines.push(`Dear ${recipient.name ?? claim.customer ?? "Valued Customer"},`);
  lines.push("");
  lines.push(`We wanted to provide you with an update on your insurance claim (Claim #${claim.claimNumber ?? "N/A"}).`);
  lines.push("");

  // Status
  if (claim.status) {
    lines.push(`Current status: ${claim.status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}`);
    evidenceUsed.push("claim.status");
  }

  // Completeness
  if (completeness) {
    lines.push(`Claim readiness: ${Math.round(completeness.score * 100)}% complete`);
    evidenceUsed.push("completeness");
  }

  // Outstanding items
  if (reconciliation?.hasDiscrepancy) {
    lines.push("");
    lines.push("There are some items that need your attention:");
    for (const note of reconciliation.notes.slice(0, 3)) {
      lines.push(`  • ${note}`);
    }
  }

  // Next steps
  lines.push("");
  lines.push("What happens next:");
  lines.push("  • We continue to work with your insurance carrier on your behalf");
  lines.push("  • We will notify you immediately of any updates or decisions");
  lines.push("  • If you have any questions, please don't hesitate to reach out");

  lines.push("");
  lines.push("Thank you for your patience.");
  lines.push("");
  lines.push("Best regards,");
  lines.push("[Your Name / Company Name]");

  return {
    draftType: "customer_status_update",
    subject: `Claim Update — ${claim.claimNumber ?? "N/A"}`,
    body: lines.join("\n"),
    recipient,
    tone: "friendly",
    evidenceUsed,
    disclaimers: [
      "This draft is assembled from available claim records and requires human review.",
      "Do not share internal financial analysis or carrier negotiations with the customer without approval.",
    ],
    requiresHumanReview: true,
    readyToSend: false,
    generatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Adjuster followup
// ---------------------------------------------------------------------------

function generateAdjusterFollowup(
  ctx: DraftContext,
  tone: DraftTone,
  recipient: DraftRecipient,
): CommunicationDraft {
  const { claim } = ctx;
  const evidenceUsed: string[] = [];
  const lines: string[] = [];

  lines.push(`Dear ${claim.adjuster ?? recipient.name ?? "Adjuster"},`);
  lines.push("");
  lines.push(`I hope this message finds you well. I'm writing regarding Claim ${claim.claimNumber ?? "N/A"} for the property at ${claim.property ?? "the insured property"}.`);
  lines.push("");
  lines.push("We would like to schedule a time to discuss the following items:");
  lines.push("");

  if (typeof claim.estimateAmount === "number") {
    lines.push(`  • Current estimate review ($${claim.estimateAmount.toLocaleString()})`);
    evidenceUsed.push("claim.estimateAmount");
  }

  lines.push("  • Scope items that may require additional coverage");
  lines.push("  • Any outstanding documentation requirements");

  lines.push("");
  lines.push("Please let me know your availability for a brief call or meeting.");
  lines.push("");
  lines.push("Thank you,");
  lines.push("[Your Name / Company Name]");

  return {
    draftType: "adjuster_followup",
    subject: `Follow-Up — Claim ${claim.claimNumber ?? "N/A"}`,
    body: lines.join("\n"),
    recipient,
    tone,
    evidenceUsed,
    disclaimers: [
      "This draft is assembled from available claim records and requires human review.",
      "Adjust the tone and content based on your relationship with this adjuster.",
    ],
    requiresHumanReview: true,
    readyToSend: false,
    generatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Internal note
// ---------------------------------------------------------------------------

function generateInternalNote(
  ctx: DraftContext,
  _tone: DraftTone,
  _recipient: DraftRecipient,
): CommunicationDraft {
  const { claim, findings, reconciliation, completeness } = ctx;
  const evidenceUsed: string[] = [];
  const lines: string[] = [];

  lines.push(`INTERNAL NOTE — Claim ${claim.claimNumber ?? "N/A"}`);
  lines.push(`Property: ${claim.property ?? "N/A"}`);
  lines.push(`Customer: ${claim.customer ?? "N/A"}`);
  lines.push(`Status: ${claim.status ?? "N/A"}`);
  lines.push(`Generated: ${new Date().toLocaleDateString()}`);
  lines.push("");

  // Completeness
  if (completeness) {
    lines.push(`Completeness: ${Math.round(completeness.score * 100)}% — ${completeness.summary}`);
    evidenceUsed.push("completeness");
  }

  // Findings
  if (findings && findings.length > 0) {
    lines.push("");
    lines.push(`Findings (${findings.length}):`);
    for (const f of findings) {
      const title = (f.title as string) ?? "Finding";
      const amount = f.estimatedAmount as number | undefined;
      const confidence = f.confidence as number | undefined;
      lines.push(`  • ${title}${amount ? ` — $${amount.toLocaleString()}` : ""}${confidence ? ` (${Math.round(confidence * 100)}% confidence)` : ""}`);
    }
    evidenceUsed.push("findings");
  }

  // Reconciliation
  if (reconciliation) {
    lines.push("");
    lines.push("Financial reconciliation:");
    if (typeof reconciliation.estimate === "number") lines.push(`  Estimate: $${reconciliation.estimate.toLocaleString()}`);
    if (typeof reconciliation.invoiced === "number") lines.push(`  Invoiced: $${reconciliation.invoiced.toLocaleString()}`);
    lines.push(`  Paid: $${reconciliation.paid.toLocaleString()}`);
    lines.push(`  Outstanding: $${reconciliation.outstanding.toLocaleString()}`);
    if (reconciliation.hasDiscrepancy) {
      lines.push("  ⚠ DISCREPANCY DETECTED");
      for (const note of reconciliation.notes) {
        lines.push(`    ${note}`);
      }
    }
    evidenceUsed.push("reconciliation");
  }

  // Recommended actions
  lines.push("");
  lines.push("Recommended actions:");
  if (reconciliation?.hasDiscrepancy) {
    lines.push("  1. Review financial discrepancy");
  }
  if (findings && findings.length > 0) {
    lines.push("  2. Review findings for supplement potential");
  }
  if (completeness && completeness.score < 0.8) {
    lines.push("  3. Address missing evidence categories");
  }
  lines.push("  4. Confirm next steps with team");

  return {
    draftType: "internal_note",
    subject: `Internal Note — Claim ${claim.claimNumber ?? "N/A"}`,
    body: lines.join("\n"),
    recipient: { role: "internal" },
    tone: "professional",
    evidenceUsed,
    disclaimers: [
      "This is an internal note assembled from available claim records.",
      "All figures are sourced from claim data — verify against source documents.",
    ],
    requiresHumanReview: true,
    readyToSend: false,
    generatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Escalation message
// ---------------------------------------------------------------------------

function generateEscalationMessage(
  ctx: DraftContext,
  _tone: DraftTone,
  _recipient: DraftRecipient,
): CommunicationDraft {
  const { claim, reconciliation, findings, completeness } = ctx;
  const evidenceUsed: string[] = [];
  const lines: string[] = [];

  lines.push("ESCALATION — Claim requires management attention");
  lines.push("");
  lines.push(`Claim: ${claim.claimNumber ?? "N/A"}`);
  lines.push(`Property: ${claim.property ?? "N/A"}`);
  lines.push(`Customer: ${claim.customer ?? "N/A"}`);
  lines.push(`Carrier: ${claim.carrier ?? "N/A"}`);
  lines.push(`Status: ${claim.status ?? "N/A"}`);
  lines.push("");

  // Reasons for escalation
  lines.push("Escalation reasons:");

  if (reconciliation?.hasDiscrepancy) {
    lines.push("  • Financial discrepancy detected in claim records");
    evidenceUsed.push("reconciliation");
  }

  if (findings && findings.length > 0) {
    const highValue = findings.filter((f) => ((f.estimatedAmount as number | undefined) ?? 0) > 5000);
    if (highValue.length > 0) {
      lines.push(`  • ${highValue.length} high-value finding(s) exceeding $5,000`);
    }
  }

  if (completeness && completeness.score < 0.5) {
    lines.push(`  • Claim completeness critically low (${Math.round(completeness.score * 100)}%)`);
    evidenceUsed.push("completeness");
  }

  // Outstanding balance
  if (reconciliation && reconciliation.outstanding > 10000) {
    lines.push(`  • Outstanding balance of $${reconciliation.outstanding.toLocaleString()}`);
  }

  lines.push("");
  lines.push("Recommended management actions:");
  lines.push("  1. Review claim status and financial position");
  lines.push("  2. Determine if additional resources are needed");
  lines.push("  3. Decide on escalation path (carrier management, legal, etc.)");

  return {
    draftType: "escalation_message",
    subject: `ESCALATION — Claim ${claim.claimNumber ?? "N/A"}`,
    body: lines.join("\n"),
    recipient: { role: "manager" },
    tone: "urgent",
    evidenceUsed,
    disclaimers: [
      "This escalation is generated from available claim data and requires management review.",
      "Verify all financial figures before acting on this escalation.",
    ],
    requiresHumanReview: true,
    readyToSend: false,
    generatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Payment followup
// ---------------------------------------------------------------------------

function generatePaymentFollowup(
  ctx: DraftContext,
  tone: DraftTone,
  recipient: DraftRecipient,
): CommunicationDraft {
  const { claim, reconciliation } = ctx;
  const evidenceUsed: string[] = [];
  const lines: string[] = [];

  lines.push(`RE: Payment Follow-Up — Claim ${claim.claimNumber ?? "N/A"}`);
  lines.push("");
  lines.push(`Dear ${recipient.name ?? claim.carrier ?? "Claims Department"},`);
  lines.push("");
  lines.push(`We are writing to follow up on payment status for the above-referenced claim.`);

  if (reconciliation) {
    lines.push("");
    lines.push("Current financial summary:");
    if (typeof reconciliation.estimate === "number") lines.push(`  Estimate: $${reconciliation.estimate.toLocaleString()}`);
    if (typeof reconciliation.invoiced === "number") lines.push(`  Invoiced: $${reconciliation.invoiced.toLocaleString()}`);
    lines.push(`  Paid to date: $${reconciliation.paid.toLocaleString()}`);
    lines.push(`  Outstanding: $${reconciliation.outstanding.toLocaleString()}`);
    evidenceUsed.push("reconciliation");
  }

  lines.push("");
  lines.push("We respectfully request an update on the payment status and an estimated timeline for resolution.");
  lines.push("");
  lines.push("Sincerely,");
  lines.push("[Your Name / Company Name]");

  return {
    draftType: "payment_followup",
    subject: `Payment Follow-Up — Claim ${claim.claimNumber ?? "N/A"}`,
    body: lines.join("\n"),
    recipient,
    tone,
    evidenceUsed,
    disclaimers: [
      "This draft is assembled from available claim records and requires human review.",
      "Verify payment figures against the actual carrier statement.",
    ],
    requiresHumanReview: true,
    readyToSend: false,
    generatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Document request
// ---------------------------------------------------------------------------

function generateDocumentRequest(
  ctx: DraftContext,
  tone: DraftTone,
  recipient: DraftRecipient,
): CommunicationDraft {
  const { claim, completeness } = ctx;
  const evidenceUsed: string[] = [];
  const lines: string[] = [];

  lines.push(`RE: Document Request — Claim ${claim.claimNumber ?? "N/A"}`);
  lines.push("");
  lines.push(`Dear ${recipient.name ?? claim.customer ?? "Valued Customer"},`);
  lines.push("");
  lines.push("To help us process your claim more effectively, we need the following documents:");

  // Missing evidence from completeness
  if (completeness) {
    lines.push("");
    lines.push("Required documents:");
    lines.push("  • Photos of all damaged areas (dated if possible)");
    lines.push("  • Contractor estimate or scope of work");
    lines.push("  • Any receipts for emergency repairs or temporary fixes");
    lines.push("  • Insurance policy declaration page (if available)");
    evidenceUsed.push("completeness");
  } else {
    lines.push("");
    lines.push("  • Photos of all damaged areas");
    lines.push("  • Contractor estimate or scope of work");
    lines.push("  • Any relevant receipts or invoices");
  }

  lines.push("");
  lines.push("Please send these at your earliest convenience. If you have any questions about what's needed, please don't hesitate to reach out.");
  lines.push("");
  lines.push("Thank you,");
  lines.push("[Your Name / Company Name]");

  return {
    draftType: "document_request",
    subject: `Document Request — Claim ${claim.claimNumber ?? "N/A"}`,
    body: lines.join("\n"),
    recipient,
    tone: "friendly",
    evidenceUsed,
    disclaimers: [
      "This draft is assembled from available claim records and requires human review.",
      "Customize the document list based on the specific claim requirements.",
    ],
    requiresHumanReview: true,
    readyToSend: false,
    generatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inferRecipient(draftType: DraftType, ctx: DraftContext): DraftRecipient {
  switch (draftType) {
    case "carrier_correspondence":
    case "payment_followup":
      return { role: "carrier", name: ctx.claim.carrier ?? undefined };
    case "adjuster_followup":
      return { role: "adjuster", name: ctx.claim.adjuster ?? undefined };
    case "customer_status_update":
    case "document_request":
      return { role: "customer", name: ctx.claim.customer ?? undefined };
    case "internal_note":
    case "escalation_message":
      return { role: "internal" };
    case "supplement_narrative":
      return { role: "carrier", name: ctx.claim.carrier ?? undefined };
    default:
      return { role: "internal" };
  }
}

function formatDate(ts?: number | null): string {
  if (typeof ts !== "number") return "N/A";
  return new Date(ts).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
