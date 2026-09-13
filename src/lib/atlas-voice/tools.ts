// ---------------------------------------------------------------------------
// Atlas Voice — Atlas tools
//
// These are ATLAS tools, not ElevenLabs tools. They read Atlas data through
// the SAME registry (`src/lib/api.ts`) and the SAME normalization the pages
// use, and they navigate the SAME router. ElevenLabs only carries the audio.
//
// Tenant isolation: every read goes through a Postgres RPC that runs under the
// caller's Supabase session, so RLS scopes results to the caller's
// organization. No tool ever accepts an organization id from the client.
//
// Honesty rules enforced here:
//   - Never fabricate claim, evidence, finding, or financial data.
//   - Never report a navigation success that did not run.
//   - Ask a short clarifying question when a claim reference is ambiguous.
// ---------------------------------------------------------------------------

import { api, type ApiFn } from "@/lib/api";
import { normalizeRpcArgs } from "@/lib/actions/rpc";
import { getSupabaseClient } from "@/lib/supabase";
import {
  ATLAS_DESTINATIONS,
  navigateAtlas,
  resolveDestinationId,
  type AtlasNavigationResult,
} from "./navigation";

// ---------------------------------------------------------------------------
// Result contract
// ---------------------------------------------------------------------------

export interface AtlasToolResult<T = Record<string, unknown>> {
  success: boolean;
  /** Spoken/displayable sentence. Always the honest outcome. */
  message: string;
  data?: T;
  /** Set when Atlas needs the user to answer a short question first. */
  clarification?: string;
}

export type AtlasToolName =
  | "navigate_atlas"
  | "search_claims"
  | "get_claim"
  | "get_claim_findings"
  | "get_missing_evidence";

export class AtlasToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AtlasToolError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Registry invocation (non-hook; mirrors useQuery/useAction semantics)
// ---------------------------------------------------------------------------

async function callRegistryFn<T>(
  fn: ApiFn<T>,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (fn.kind === "client" && fn.clientImpl) {
    return (await fn.clientImpl(args)) as T;
  }
  const supabase = getSupabaseClient();
  if (!supabase) {
    throw new AtlasToolError("unavailable", "Atlas data is unavailable right now.");
  }
  const { data, error } = await supabase.rpc(fn.name, normalizeRpcArgs(args));
  if (error) throw error;
  return (fn.transform ? fn.transform(data) : data) as T;
}

// ---------------------------------------------------------------------------
// Claim shape
// ---------------------------------------------------------------------------

export interface ClaimSummary {
  id: string;
  claimNumber: string | null;
  customer: string | null;
  status: string | null;
  carrier: string | null;
  property: string | null;
  completeness: number | null;
  completenessTotal: number | null;
  openFindings: number;
  needsAttention: boolean;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toClaimSummary(row: Record<string, unknown>): ClaimSummary | null {
  const id = text(row._id);
  if (!id) return null;
  return {
    id,
    claimNumber: text(row.claimNumber) ?? text(row.claim_number),
    customer: text(row.customer) ?? text(row.customerName),
    status: text(row.status),
    carrier: text(row.carrier),
    property: text(row.property),
    completeness: num(row.completeness),
    completenessTotal: num(row.completenessTotal),
    openFindings: num(row.openFindings) ?? 0,
    needsAttention: row.needsAttention === true,
  };
}

/** Human label for a claim — never invented when the data is absent. */
export function claimLabel(claim: ClaimSummary): string {
  return (
    claim.customer ??
    claim.claimNumber ??
    claim.property ??
    `claim ${claim.id.slice(0, 8)}`
  );
}

// ---------------------------------------------------------------------------
// search_claims
// ---------------------------------------------------------------------------

export interface SearchClaimsOptions {
  query?: string;
  /** Only claims Atlas already flags as needing attention. */
  needsAttention?: boolean;
  limit?: number;
}

export interface SearchClaimsData {
  claims: ClaimSummary[];
  total: number;
}

/**
 * Score a claim against a free-text query. Deterministic and never fuzzy in a
 * way that invents a match: an unmatched query returns no claims.
 */
function scoreClaim(claim: ClaimSummary, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const fields = [
    claim.claimNumber?.toLowerCase(),
    claim.customer?.toLowerCase(),
    claim.property?.toLowerCase(),
    claim.carrier?.toLowerCase(),
    claim.status?.toLowerCase(),
  ].filter((v): v is string => Boolean(v));

  let best = 0;
  for (const field of fields) {
    if (field === q) best = Math.max(best, 100);
    else if (field.startsWith(q)) best = Math.max(best, 70);
    else if (field.includes(q)) best = Math.max(best, 50);
  }
  // Token overlap so "carter water loss" still finds "Carter Residence".
  const tokens = q.split(/\s+/).filter((t) => t.length > 2);
  if (tokens.length > 1) {
    const matched = tokens.filter((t) => fields.some((f) => f.includes(t))).length;
    if (matched > 0) best = Math.max(best, 30 + matched * 5);
  }
  return best;
}

export async function searchClaims(
  options: SearchClaimsOptions = {},
): Promise<AtlasToolResult<SearchClaimsData>> {
  const rows = await callRegistryFn<Array<Record<string, unknown>>>(
    api.insurance.claims.listClaims,
    {},
  );

  const claims = (Array.isArray(rows) ? rows : [])
    .map(toClaimSummary)
    .filter((c): c is ClaimSummary => c !== null);

  let matched = claims;
  if (options.needsAttention) {
    matched = matched.filter((c) => c.needsAttention || c.openFindings > 0);
  }

  const query = (options.query ?? "").trim();
  if (query) {
    matched = matched
      .map((claim) => ({ claim, score: scoreClaim(claim, query) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.claim);
  }

  const limit = options.limit ?? 5;
  const limited = matched.slice(0, limit);

  if (limited.length === 0) {
    const message = query
      ? `I couldn't find a claim matching "${query}" in your organization.`
      : options.needsAttention
        ? "Nothing in your organization is currently flagged as needing attention."
        : "I couldn't find any claims in your organization.";
    return { success: true, message, data: { claims: [], total: 0 } };
  }

  const names = limited.map(claimLabel).join(", ");
  const message =
    limited.length === 1
      ? `I found ${names}.`
      : `I found ${limited.length} claims: ${names}.`;

  return {
    success: true,
    message,
    data: { claims: limited, total: matched.length },
  };
}

// ---------------------------------------------------------------------------
// Claim reference resolution
// ---------------------------------------------------------------------------

type ClaimResolution =
  | { ok: true; claim: ClaimSummary; direct: boolean }
  | { ok: false; message: string; ambiguous?: ClaimSummary[] };

/** True when the reference looks like a claim id rather than a spoken name. */
function looksLikeClaimId(ref: string): boolean {
  return !ref.includes(" ") && ref.length >= 16;
}

/**
 * Resolve a spoken claim reference ("Carter", "CLM-1042", an id) to exactly
 * one claim. Ambiguity is surfaced as a question — Atlas never guesses.
 */
export async function resolveClaim(claimRef: string): Promise<ClaimResolution> {
  const ref = (claimRef ?? "").trim();
  if (!ref) {
    return { ok: false, message: "Which claim do you mean?" };
  }

  if (looksLikeClaimId(ref)) {
    const pkg = await callRegistryFn<{ claim: Record<string, unknown> } | null>(
      api.insurance.claims.getClaimPackage,
      { claimId: ref },
    );
    const summary = pkg?.claim ? toClaimSummary(pkg.claim) : null;
    if (summary) return { ok: true, claim: summary, direct: true };
    // Fall through: the id may not exist, so try it as free text.
  }

  const result = await searchClaims({ query: ref, limit: 5 });
  const claims = result.data?.claims ?? [];

  if (claims.length === 0) {
    return {
      ok: false,
      message: `I couldn't find a claim matching "${ref}" in your organization.`,
    };
  }
  if (claims.length === 1) {
    return { ok: true, claim: claims[0], direct: false };
  }

  const names = claims.map(claimLabel).join(", ");
  return {
    ok: false,
    ambiguous: claims,
    message: `I found ${claims.length} claims matching "${ref}": ${names}. Which one?`,
  };
}

// ---------------------------------------------------------------------------
// navigate_atlas
// ---------------------------------------------------------------------------

export interface NavigateAtlasArgs {
  destination: string;
  /** Claim id, claim number, or customer name ("Carter"). */
  claimRef?: string;
}

/**
 * Open an Atlas page by voice.
 *
 * When the destination is a claim page, the claim reference is resolved
 * FIRST (asking for clarification if ambiguous) and navigation is only
 * reported as successful when the router actually moved.
 */
export async function navigateAtlasTool(
  args: NavigateAtlasArgs,
): Promise<AtlasToolResult<AtlasNavigationResult & { claim?: ClaimSummary }>> {
  const destinationId = resolveDestinationId(args.destination ?? "");
  if (!destinationId) {
    return {
      success: false,
      message: (args.destination ?? "").trim()
        ? `I don't know a page called "${args.destination}" in Atlas.`
        : "I didn't catch which Atlas page you want.",
    };
  }

  const destination = ATLAS_DESTINATIONS[destinationId];

  // Claim pages (claim / evidence / supplements) need a real claim first.
  if (destination.requiresClaimId) {
    if (!(args.claimRef ?? "").trim()) {
      return {
        success: false,
        message: "Which claim? Tell me the claim number or customer name.",
        clarification: "Which claim?",
      };
    }

    const resolution = await resolveClaim(args.claimRef as string);
    if (!resolution.ok) {
      return {
        success: false,
        message: resolution.message,
        ...(resolution.ambiguous ? { clarification: resolution.message } : {}),
      };
    }

    const result = navigateAtlas({
      destination: destinationId,
      entityId: resolution.claim.id,
    });
    return {
      success: result.success,
      message: result.success
        ? `Opened the ${claimLabel(resolution.claim)} claim.`
        : result.message,
      data: { ...result, claim: resolution.claim },
    };
  }

  const result = navigateAtlas({ destination: destinationId });
  return { success: result.success, message: result.message, data: result };
}

// ---------------------------------------------------------------------------
// get_claim
// ---------------------------------------------------------------------------

type ClaimPackage = {
  claim: Record<string, unknown>;
  supplements: Array<Record<string, unknown>>;
  findings: Array<Record<string, unknown>>;
  evidenceDocs: Array<Record<string, unknown>>;
  completeness: { complete: number; total: number; score: number; summary: string };
} | null;

async function loadClaimPackage(claimId: string): Promise<ClaimPackage> {
  return callRegistryFn<ClaimPackage>(api.insurance.claims.getClaimPackage, {
    claimId,
  });
}

export interface GetClaimData {
  claim: ClaimSummary;
  completeness: { complete: number; total: number; summary: string } | null;
  findingCount: number;
  supplementCount: number;
  evidenceCount: number;
}

/** Summarize one claim from real Atlas data. */
export async function getClaim(
  claimRef: string,
): Promise<AtlasToolResult<GetClaimData>> {
  const resolution = await resolveClaim(claimRef);
  if (!resolution.ok) {
    return { success: false, message: resolution.message };
  }

  const pkg = await loadClaimPackage(resolution.claim.id);
  if (!pkg?.claim) {
    return {
      success: false,
      message: `I couldn't load the ${claimLabel(resolution.claim)} claim.`,
    };
  }

  const summary = toClaimSummary(pkg.claim) ?? resolution.claim;
  const parts: string[] = [`${claimLabel(summary)}`];
  if (summary.status) parts.push(`status ${summary.status}`);
  if (summary.carrier) parts.push(`carrier ${summary.carrier}`);
  if (pkg.completeness) parts.push(pkg.completeness.summary);

  return {
    success: true,
    message: parts.join(" — ") + ".",
    data: {
      claim: summary,
      completeness: pkg.completeness
        ? {
            complete: pkg.completeness.complete,
            total: pkg.completeness.total,
            summary: pkg.completeness.summary,
          }
        : null,
      findingCount: pkg.findings.length,
      supplementCount: pkg.supplements.length,
      evidenceCount: pkg.evidenceDocs.length,
    },
  };
}

// ---------------------------------------------------------------------------
// get_claim_findings
// ---------------------------------------------------------------------------

export interface ClaimFinding {
  title: string;
  status: string | null;
  description: string | null;
}

export interface GetClaimFindingsData {
  claim: ClaimSummary;
  findings: ClaimFinding[];
}

/** List the claim's real findings. Never invents one. */
export async function getClaimFindings(
  claimRef: string,
): Promise<AtlasToolResult<GetClaimFindingsData>> {
  const resolution = await resolveClaim(claimRef);
  if (!resolution.ok) {
    return { success: false, message: resolution.message };
  }

  const pkg = await loadClaimPackage(resolution.claim.id);
  if (!pkg?.claim) {
    return {
      success: false,
      message: `I couldn't load the ${claimLabel(resolution.claim)} claim.`,
    };
  }

  const findings: ClaimFinding[] = pkg.findings
    .map((row) => ({
      title: text(row.title) ?? text(row.findingKey) ?? "Finding",
      status: text(row.status),
      description: text(row.description),
    }))
    .filter((f) => f.title);

  if (findings.length === 0) {
    return {
      success: true,
      message: `${claimLabel(resolution.claim)} has no recorded findings yet.`,
      data: { claim: resolution.claim, findings: [] },
    };
  }

  const open = findings.filter((f) => (f.status ?? "").toLowerCase() === "open");
  const message =
    open.length > 0
      ? `${claimLabel(resolution.claim)} has ${findings.length} finding${findings.length === 1 ? "" : "s"}, ${open.length} still open: ${open.map((f) => f.title).slice(0, 3).join(", ")}.`
      : `${claimLabel(resolution.claim)} has ${findings.length} finding${findings.length === 1 ? "" : "s"}, none currently open.`;

  return {
    success: true,
    message,
    data: { claim: resolution.claim, findings },
  };
}

// ---------------------------------------------------------------------------
// get_missing_evidence
// ---------------------------------------------------------------------------

export interface MissingEvidenceItem {
  key: string;
  label: string;
  status: string;
  note: string;
}

export interface GetMissingEvidenceData {
  claim: ClaimSummary;
  missing: MissingEvidenceItem[];
  evidenceCount: number;
  summary: string;
}

/**
 * What is actually missing on a claim, derived from Atlas's own completeness
 * rules. If Atlas has no gaps recorded, it says so rather than inventing one.
 */
export async function getMissingEvidence(
  claimRef: string,
): Promise<AtlasToolResult<GetMissingEvidenceData>> {
  const resolution = await resolveClaim(claimRef);
  if (!resolution.ok) {
    return { success: false, message: resolution.message };
  }

  const pkg = await callRegistryFn<
    (ClaimPackage & { completeness?: { categories?: MissingEvidenceItem[] } }) | null
  >(api.insurance.claims.getClaimPackage, { claimId: resolution.claim.id });

  if (!pkg?.claim) {
    return {
      success: false,
      message: `I couldn't load the ${claimLabel(resolution.claim)} claim.`,
    };
  }

  const categories = pkg.completeness?.categories ?? [];
  const missing = categories.filter((c) =>
    ["missing", "needs_review", "conflicted", "stale"].includes(c.status),
  );

  const summary = pkg.completeness?.summary ?? "";
  if (missing.length === 0) {
    return {
      success: true,
      message: `${claimLabel(resolution.claim)} has no outstanding evidence gaps. ${summary}`.trim(),
      data: {
        claim: resolution.claim,
        missing: [],
        evidenceCount: pkg.evidenceDocs.length,
        summary,
      },
    };
  }

  const labels = missing.map((c) => c.label).join(", ");
  return {
    success: true,
    message: `${claimLabel(resolution.claim)} is missing ${missing.length} item${missing.length === 1 ? "" : "s"}: ${labels}.`,
    data: {
      claim: resolution.claim,
      missing,
      evidenceCount: pkg.evidenceDocs.length,
      summary,
    },
  };
}

// ---------------------------------------------------------------------------
// Tool table
// ---------------------------------------------------------------------------

/** The Atlas tools available to voice. Deterministic dispatch, no guessing. */
export const ATLAS_VOICE_TOOLS: Record<
  AtlasToolName,
  { description: string; requiresConfirmation: boolean }
> = {
  navigate_atlas: {
    description: "Open an Atlas page or claim",
    requiresConfirmation: false,
  },
  search_claims: {
    description: "Search claims in the caller's organization",
    requiresConfirmation: false,
  },
  get_claim: {
    description: "Summarize a claim using Atlas data",
    requiresConfirmation: false,
  },
  get_claim_findings: {
    description: "List a claim's findings",
    requiresConfirmation: false,
  },
  get_missing_evidence: {
    description: "List a claim's outstanding evidence gaps",
    requiresConfirmation: false,
  },
};
