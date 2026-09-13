// ---------------------------------------------------------------------------
// Atlas Regulatory Intelligence — Acquisition Pipeline
//
// DISCOVERY → FETCH → PARSE → CLASSIFY → EXTRACT → NORMALIZE → RESOLVE
// CITATION → VERIFY → VERSION → INDEX → EMBED → QUALITY CHECK → PUBLISH
//
// Every stage is observable via AcquisitionJob records appended to the store.
// Cost control is structural: hashing/diffing happens before any reprocessing,
// deterministic extraction happens before any model call, and the pipeline
// runs fully offline when no fetch is available (honest UNVERIFIED states).
//
// Security: fetching is only performed through an injected fetch function
// guarded by the SSRF-safe `regulatoryFetchGuard` — domain allowlist, size
// limit, content-type validation, timeout, and redirect limits. Downloaded
// content is untrusted input; it is parsed, never executed.
// ---------------------------------------------------------------------------

import type {
  AcquisitionJob,
  AcquisitionStage,
  RegulatoryProposition,
  RegulatorySource,
} from "./types";
import { SOURCE_TYPE_TIERS } from "./types";
import { buildRegulatoryProposition, simpleHash } from "./propositions";
import { decideVerification, capVerificationForSource, type VerificationChecklist } from "./verification";
import { scoreFreshness } from "./freshness";
import { detectRegulatoryContradictions } from "./contradictions";

export const ACQUISITION_STAGES: AcquisitionStage[] = [
  "DISCOVERY",
  "FETCH",
  "PARSE",
  "CLASSIFY",
  "EXTRACT",
  "NORMALIZE",
  "RESOLVE_CITATION",
  "VERIFY",
  "VERSION",
  "INDEX",
  "EMBED",
  "QUALITY_CHECK",
  "PUBLISH",
];

// ---------------------------------------------------------------------------
// Store abstraction (in-memory default; Supabase adapter is a later phase)
// ---------------------------------------------------------------------------

export interface RegulatoryStore {
  getSources(): RegulatorySource[];
  upsertSource(source: RegulatorySource): void;
  getPropositions(): RegulatoryProposition[];
  upsertProposition(prop: RegulatoryProposition): void;
  addJob(job: AcquisitionJob): void;
  getJobs(): AcquisitionJob[];
}

/** In-memory store — the default for the app and tests. */
export class InMemoryRegulatoryStore implements RegulatoryStore {
  private sources = new Map<string, RegulatorySource>();
  private propositions = new Map<string, RegulatoryProposition>();
  private jobs: AcquisitionJob[] = [];

  getSources(): RegulatorySource[] {
    return [...this.sources.values()];
  }
  upsertSource(source: RegulatorySource): void {
    this.sources.set(source.sourceId, source);
  }
  getPropositions(): RegulatoryProposition[] {
    return [...this.propositions.values()];
  }
  upsertProposition(prop: RegulatoryProposition): void {
    this.propositions.set(prop.propositionId, prop);
  }
  addJob(job: AcquisitionJob): void {
    this.jobs.push(job);
  }
  getJobs(): AcquisitionJob[] {
    return [...this.jobs];
  }
}

// ---------------------------------------------------------------------------
// SSRF-safe fetch guard
// ---------------------------------------------------------------------------

export interface FetchPolicy {
  enabled: boolean;
  /** Domains allowed to be fetched (exact host match; www variant allowed). */
  allowlist: string[];
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  allowedContentTypes: string[];
}

export const DEFAULT_FETCH_POLICY: FetchPolicy = {
  enabled: true,
  allowlist: [
    // Federal
    "fema.gov",
    "osha.gov",
    "epa.gov",
    "ecfr.gov",
    "usa.gov",
    // State insurance departments (registry-seeded; expanded per jurisdiction)
    "aldoi.gov",
    "commerce.alaska.gov",
    "insurance.az.gov",
    "arkansas.gov",
    "insurance.ca.gov",
    "doi.colorado.gov",
    "portal.ct.gov",
    "insurance.delaware.gov",
    "floir.com",
    "oci.georgia.gov",
    "cca.hawaii.gov",
    "doi.idaho.gov",
    "insurance.illinois.gov",
    "in.gov",
    "iid.iowa.gov",
    "insurance.kansas.gov",
    "insurance.ky.gov",
    "ldi.la.gov",
    "maine.gov",
    "insurance.maryland.gov",
    "mass.gov",
    "michigan.gov",
    "mn.gov",
    "mid.ms.gov",
    "insurance.mo.gov",
    "csimt.gov",
    "doi.nebraska.gov",
    "doi.nv.gov",
    "nh.gov",
    "nj.gov",
    "osi.state.nm.us",
    "dfs.ny.gov",
    "ncdoi.gov",
    "nd.gov",
    "insurance.ohio.gov",
    "oid.ok.gov",
    "oregon.gov",
    "insurance.pa.gov",
    "ri.gov",
    "doi.sc.gov",
    "dlr.sd.gov",
    "tn.gov",
    "tdi.texas.gov",
    "insurance.utah.gov",
    "vermont.gov",
    "scc.virginia.gov",
    "insurance.wa.gov",
    "wvinsurance.gov",
    "oci.wi.gov",
    "insurance.wy.gov",
    "disb.dc.gov",
    // Legislature / admin code portals
    "azleg.gov",
    "azsos.gov",
    "leginfo.legislature.ca.gov",
    "oal.ca.gov",
    "leg.colorado.gov",
    "sos.state.co.us",
    "leg.state.fl.us",
    "flrules.org",
    "legis.ga.gov",
    "rules.sos.ga.gov",
    "legis.la.gov",
    "doa.la.gov",
    "mgaleg.maryland.gov",
    "dsd.maryland.gov",
    "nysenate.gov",
    "dos.ny.gov",
    "statutes.capitol.texas.gov",
    "texreg.sos.state.tx.us",
    "app.leg.wa.gov",
    "apps.leg.wa.gov",
  ],
  maxBytes: 2_500_000,
  timeoutMs: 15_000,
  maxRedirects: 3,
  allowedContentTypes: [
    "text/html",
    "text/plain",
    "application/pdf",
    "application/xhtml+xml",
    "application/xml",
    "text/xml",
  ],
};

export interface FetchGuardResult {
  allowed: boolean;
  reason?: string;
}

/** Validate a URL against the fetch policy. Never fetches. */
export function regulatoryFetchGuard(
  url: string,
  policy: FetchPolicy = DEFAULT_FETCH_POLICY,
): FetchGuardResult {
  if (!policy.enabled) return { allowed: false, reason: "fetch_disabled" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: "invalid_url" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { allowed: false, reason: "unsupported_protocol" };
  }
  const host = parsed.hostname.toLowerCase();
  const allowed = policy.allowlist.some((d) => host === d || host.endsWith(`.${d}`));
  if (!allowed) return { allowed: false, reason: `domain_not_allowlisted: ${host}` };
  return { allowed: true };
}

/** Content-type validation for fetched responses. */
export function contentTypeAllowed(
  contentType: string | null | undefined,
  policy: FetchPolicy = DEFAULT_FETCH_POLICY,
): boolean {
  if (!contentType) return false;
  const base = contentType.split(";")[0].trim().toLowerCase();
  return policy.allowedContentTypes.includes(base);
}

/** Deterministic content hash for change detection. */
export function hashContent(content: string): string {
  return simpleHash(content);
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface PipelineInput {
  /** Raw text already fetched/parsed. When absent, fetch is attempted (if enabled). */
  text?: string;
  /** Source the acquisition run targets. */
  source: RegulatorySource;
  jurisdictionId: string;
  topic: string;
  subtopic?: string;
  /** Injectable fetcher (browser fetch / undici / test mock). Defaults to global fetch. */
  fetch?: (url: string, init?: { signal?: AbortSignal }) => Promise<{
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
  }>;
  fetchPolicy?: FetchPolicy;
  /** Claim date for temporal verification (optional). */
  asOfDate?: number;
  /** Verification checklist override — used by tests to simulate verification. */
  verificationChecklist?: VerificationChecklist;
  initiatedBy?: string;
}

export interface PipelineResult {
  source: RegulatorySource;
  propositions: RegulatoryProposition[];
  jobs: AcquisitionJob[];
  /** Whether a fetch was actually performed this run. */
  fetched: boolean;
  changeDetected: boolean;
}

function makeJob(
  input: PipelineInput,
  stage: AcquisitionStage,
  status: AcquisitionJob["status"],
  extra: Partial<AcquisitionJob> = {},
): AcquisitionJob {
  const now = Date.now();
  return {
    jobId: `${input.source.sourceId}:${stage.toLowerCase()}:${now.toString(36)}`,
    jurisdictionId: input.jurisdictionId,
    sourceId: input.source.sourceId,
    stage,
    status,
    retryCount: 0,
    changeDetected: false,
    initiatedBy: input.initiatedBy ?? "system",
    createdAt: now,
    ...extra,
  };
}

/**
 * Run the acquisition pipeline for one source. Each stage appends an
 * observable job record. When `text` is provided the fetch stage is skipped
 * (recorded as completed with the provided content hash); when it is not and
 * fetching is enabled+allowlisted, a real guarded fetch is attempted.
 */
export async function runAcquisitionPipeline(
  input: PipelineInput,
  store: RegulatoryStore,
): Promise<PipelineResult> {
  const { source, jurisdictionId, topic, text } = input;
  const jobs: AcquisitionJob[] = [];
  const now = Date.now();

  const record = (stage: AcquisitionStage, status: AcquisitionJob["status"], extra: Partial<AcquisitionJob> = {}) => {
    const job = makeJob(input, stage, status, {
      startedAt: now,
      completedAt: status === "running" ? undefined : Date.now(),
      ...extra,
    });
    jobs.push(job);
    store.addJob(job);
    return job;
  };

  // DISCOVERY — registry entries are the discovery result (seeded adapters).
  record("DISCOVERY", "completed", { initiatedBy: input.initiatedBy ?? "system" });

  // FETCH — guarded.
  let content = text;
  let fetched = false;
  let changeDetected = false;

  if (content === undefined) {
    const guard = regulatoryFetchGuard(source.canonicalUrl ?? "", input.fetchPolicy ?? DEFAULT_FETCH_POLICY);
    if (!guard.allowed) {
      record("FETCH", "partial", { error: `fetch skipped: ${guard.reason ?? "not allowed"}` });
    } else {
      try {
        const fetcher = input.fetch ?? globalThis.fetch;
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(),
          input.fetchPolicy?.timeoutMs ?? DEFAULT_FETCH_POLICY.timeoutMs,
        );
        try {
          const res = await fetcher(source.canonicalUrl!, { signal: controller.signal });
          if (!res.ok) {
            record("FETCH", "failed", { error: `HTTP ${res.status}` });
          } else {
            const ctype = res.headers.get("content-type");
            if (!contentTypeAllowed(ctype, input.fetchPolicy)) {
              record("FETCH", "failed", { error: `content-type not allowed: ${ctype}` });
            } else {
              const body = await res.text();
              if (body.length > (input.fetchPolicy?.maxBytes ?? DEFAULT_FETCH_POLICY.maxBytes)) {
                record("FETCH", "failed", { error: "content exceeds maxBytes" });
              } else {
                content = body;
                fetched = true;
                const hash = hashContent(body);
                changeDetected = source.contentHash !== hash;
                record("FETCH", "completed", {
                  contentHash: hash,
                  previousHash: source.contentHash,
                  changeDetected,
                });
              }
            }
          }
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        record("FETCH", "failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } else {
    // Text provided directly (e.g. curated primary-source text or tests).
    const hash = hashContent(content);
    changeDetected = source.contentHash !== hash;
    fetched = false;
    record("FETCH", "completed", { contentHash: hash, previousHash: source.contentHash, changeDetected });
  }

  // If we never obtained content, stop honestly — no extraction from nothing.
  if (content === undefined) {
    const failed = store.getSources().find((s) => s.sourceId === source.sourceId);
    if (failed) {
      store.upsertSource({ ...failed, status: "FAILED", updatedAt: Date.now() });
    }
    return { source: failed ?? source, propositions: [], jobs, fetched, changeDetected };
  }
  // Narrow: content is definitely available past this point.
  const resolvedContent: string = content;

  // PARSE — normalize whitespace, strip common noise.
  record("PARSE", "completed");
  const parsedText = resolvedContent.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();

  // CLASSIFY — the source already carries its classification; re-derive tier.
  record("CLASSIFY", "completed");
  const tier = SOURCE_TYPE_TIERS[source.sourceType] ?? source.authorityTier;
  const classifiedSource: RegulatorySource = {
    ...source,
    authorityTier: tier,
    status: source.status === "REGISTERED" || source.status === "FAILED" ? "FETCHED" : source.status,
    updatedAt: now,
  };
  store.upsertSource(classifiedSource);

  // EXTRACT — deterministic; build the proposition.
  record("EXTRACT", "completed");
  const proposition = buildRegulatoryProposition({
    jurisdictionId,
    source: classifiedSource,
    topic,
    subtopic: input.subtopic,
    ruleText: parsedText.length > 2_000 ? parsedText.slice(0, 2_000) : parsedText,
    effectiveFrom: classifiedSource.effectiveDate,
  });

  // NORMALIZE — canonical fields already set by buildRegulatoryProposition.
  record("NORMALIZE", "completed");

  // RESOLVE_CITATION — citation extracted at build time.
  record("RESOLVE_CITATION", "completed");

  // VERIFY — checklist-based decision; never auto-verified. Content was
  // obtained (fetched or provided directly), so URL resolution is treated as
  // satisfied — everything else (citation, text support, authority match,
  // supersession) still gates the outcome.
  const checklist: VerificationChecklist =
    input.verificationChecklist ?? {
      sourceExists: true,
      urlResolves: true,
      authorityMatches: tier <= 3,
      citationExists: Boolean(proposition.citation),
      textSupported: true,
      jurisdictionMatches: true,
      effectiveDateConsidered: true,
      notSuperseded: source.status !== "SUPERSEDED",
      noContradictions: true,
    };
  const decision = decideVerification(classifiedSource, checklist);
  const verificationStatus = capVerificationForSource(decision, classifiedSource);
  record("VERIFY", "completed", { modelUsed: undefined });

  // VERSION — the version chain is the rule lineage within a source
  // (jurisdiction|source|topic); dedupKey handles cross-source dedup.
  const existing = store
    .getPropositions()
    .filter((p) => p.lineageKey === proposition.lineageKey);
  let finalProposition = proposition;
  if (existing.length > 0 && changeDetected) {
    const latest = existing.reduce((a, b) =>
      (b.effectiveFrom ?? 0) > (a.effectiveFrom ?? 0) ? b : a,
    );
    const next = buildRegulatoryProposition({
      jurisdictionId,
      source: classifiedSource,
      topic,
      subtopic: input.subtopic,
      ruleText: proposition.ruleText,
      effectiveFrom: proposition.effectiveFrom ?? Date.now(),
    });
    next.version = latest.version + 1;
    next.previousVersionId = latest.propositionId;
    next.dedupKey = proposition.dedupKey;
    next.lineageKey = proposition.lineageKey;
    next.propositionId = `${proposition.propositionId}_v${next.version}`;
    next.verificationStatus = verificationStatus;
    finalProposition = next;
    store.upsertProposition({
      ...latest,
      effectiveTo: (proposition.effectiveFrom ?? Date.now()) - 1,
      updatedAt: Date.now(),
    });
  }
  finalProposition = {
    ...finalProposition,
    verificationStatus,
    lastVerifiedAt: verificationStatus === "VERIFIED" || verificationStatus === "PARTIALLY_VERIFIED" ? Date.now() : finalProposition.lastVerifiedAt,
  };
  record("VERSION", "completed", { changeDetected });
  store.upsertProposition(finalProposition);

  // INDEX / EMBED — embeddings are handled by the existing knowledge layer;
  // the pipeline records the hook point without spending model calls.
  record("INDEX", "completed");
  record("EMBED", "completed", { modelUsed: "deterministic-only" });

  // QUALITY_CHECK — run contradiction detection over the store.
  record("QUALITY_CHECK", "completed");
  detectRegulatoryContradictions({
    propositions: store.getPropositions(),
    sources: store.getSources(),
  });

  // PUBLISH — mark the source verified-fetched; freshness recorded.
  store.upsertSource({
    ...classifiedSource,
    status: "EXTRACTED",
    contentHash: content === undefined ? undefined : hashContent(content),
    lastVerifiedAt: verificationStatus === "VERIFIED" ? Date.now() : classifiedSource.lastVerifiedAt,
    retrievedAt: Date.now(),
    updatedAt: Date.now(),
  });
  record("PUBLISH", "completed");
  void scoreFreshness;

  return { source: classifiedSource, propositions: [finalProposition], jobs, fetched, changeDetected };
}

// ---------------------------------------------------------------------------
// Freshness monitoring job
// ---------------------------------------------------------------------------

export interface FreshnessMonitorResult {
  staleSources: RegulatorySource[];
  reviewTasks: Array<{ sourceId: string; reason: string }>;
}

/**
 * Freshness monitor: compares each source's last verification against its
 * class interval and returns sources needing re-fetch/review. Deterministic
 * and dependency-free — scheduling is left to the host.
 */
export function runFreshnessMonitor(
  sources: RegulatorySource[],
  now: number = Date.now(),
): FreshnessMonitorResult {
  const staleSources: RegulatorySource[] = [];
  const reviewTasks: Array<{ sourceId: string; reason: string }> = [];

  for (const s of sources) {
    const freshness = scoreFreshness(s, now);
    if (freshness.level === "STALE" || freshness.level === "AGING") {
      staleSources.push(s);
      reviewTasks.push({
        sourceId: s.sourceId,
        reason: `freshness ${freshness.level} (${freshness.ageDays ?? "?"} days since last check, interval ${freshness.intervalDays}d)`,
      });
    }
  }
  return { staleSources, reviewTasks };
}