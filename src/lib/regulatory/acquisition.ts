import { WAVE_1_JURISDICTIONS, sourceCandidatesFor } from "./catalog";
import { DEFAULT_FETCH_POLICY, fetchRegulatorySource } from "./fetcher";
import { extractPropositions, normalizeProposition } from "./extraction";
import { InMemoryRegulatoryStore } from "./store";
import { applyVerification, detectContradiction, verifyProposition } from "./verification";
import type {
  AcquiredSource,
  CoverageReport,
  DiscoverySourceAdapter,
  FetchPolicy,
  HumanReviewItem,
  JurisdictionRecord,
  RegulatoryStore,
  SourceCandidate,
} from "./types";

export interface AcquisitionJob {
  id: string;
  jurisdictionCode: string;
  source: SourceCandidate;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: number;
}

export interface AcquisitionOptions {
  policy?: FetchPolicy;
  maxAttempts?: number;
  baseBackoffMs?: number;
  now?: () => string;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

export interface AcquisitionResult {
  jurisdiction: JurisdictionRecord;
  sources: AcquiredSource[];
  propositions: number;
  verified: number;
  reviewItems: HumanReviewItem[];
  contradictions: number;
  coverage: CoverageReport;
}

export class CatalogDiscoveryAdapter implements DiscoverySourceAdapter {
  async discover(jurisdiction: JurisdictionRecord): Promise<SourceCandidate[]> {
    return sourceCandidatesFor(jurisdiction);
  }
}

export class RegulatoryAcquisitionWorker {
  private readonly store: RegulatoryStore;
  private readonly discovery: DiscoverySourceAdapter;
  private readonly policy: FetchPolicy;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly now: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchImpl: typeof fetch;

  constructor(
    store: RegulatoryStore,
    discovery: DiscoverySourceAdapter = new CatalogDiscoveryAdapter(),
    options: AcquisitionOptions = {},
  ) {
    this.store = store;
    this.discovery = discovery;
    this.policy = options.policy ?? DEFAULT_FETCH_POLICY;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseBackoffMs = options.baseBackoffMs ?? 500;
    this.now = options.now ?? (() => new Date().toISOString());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async acquire(jurisdiction: JurisdictionRecord): Promise<AcquisitionResult> {
    await this.store.upsertJurisdiction(jurisdiction);
    const discovered = await this.discovery.discover(jurisdiction);
    const queue: AcquisitionJob[] = discovered.map((source, index) => ({
      id: `${jurisdiction.code}_${index}_${source.url}`,
      jurisdictionCode: jurisdiction.code,
      source,
      attempts: 0,
      maxAttempts: this.maxAttempts,
      nextAttemptAt: Date.now(),
    }));
    const sources: AcquiredSource[] = [];
    const reviewItems: HumanReviewItem[] = [];
    let propositionCount = 0;
    let verifiedCount = 0;
    let contradictionCount = 0;
    const existingHashes = new Set<string>();

    while (queue.length > 0) {
      queue.sort((left, right) => left.nextAttemptAt - right.nextAttemptAt);
      const job = queue.shift();
      if (!job) break;
      const wait = job.nextAttemptAt - Date.now();
      if (wait > 0) await this.sleep(wait);
      job.attempts += 1;
      const acquired = await fetchRegulatorySource(job.source, this.policy, existingHashes, this.fetchImpl);
      if (acquired.status === "FAILED" && acquired.fetchError?.retryable && job.attempts < job.maxAttempts) {
        job.nextAttemptAt = Date.now() + this.baseBackoffMs * 2 ** (job.attempts - 1);
        queue.push(job);
        continue;
      }
      const persisted = await this.store.upsertSource(acquired);
      sources.push(persisted);
      if (persisted.contentHash) existingHashes.add(persisted.contentHash);
      if (persisted.status === "BLOCKED" || persisted.status === "FAILED") {
        reviewItems.push(await this.store.addReviewItem({
          jurisdictionCode: jurisdiction.code,
          reason: persisted.fetchError?.code === "SSRF_BLOCKED" || persisted.fetchError?.code === "DOMAIN_NOT_ALLOWED" ? "INACCESSIBLE_PRIMARY_SOURCE" : "EXTRACTION_UNCERTAINTY",
          sourceId: persisted.id,
          summary: persisted.fetchError?.message ?? "Source could not be acquired.",
          status: "OPEN",
        }));
        continue;
      }
      if (persisted.status === "UNCHANGED" || !persisted.rawContent) continue;
      const extracted = extractPropositions(persisted);
      for (const candidate of extracted) {
        const normalized = normalizeProposition({
          ...candidate,
          effectiveFrom: persisted.effectiveFrom,
          effectiveTo: persisted.effectiveTo,
          enactedAt: persisted.effectiveFrom,
        });
        const existing = await this.store.listPropositions({ jurisdictionCode: jurisdiction.code, topic: normalized.topic });
        const priorContradictions = await this.store.listContradictions(jurisdiction.code);
        const verification = verifyProposition(normalized, persisted, this.now(), priorContradictions);
        let finalProposition = await this.store.upsertProposition(applyVerification(normalized, verification));
        propositionCount += 1;
        if (finalProposition.verificationState === "VERIFIED") verifiedCount += 1;
        let requiresContradictionReview = false;
        for (const prior of existing) {
          const contradiction = detectContradiction(prior, { ...normalized, id: finalProposition.id });
          if (contradiction) {
            const saved = await this.store.addContradiction(contradiction);
            contradictionCount += 1;
            requiresContradictionReview = requiresContradictionReview || saved.resolutionStatus === "NEEDS_HUMAN_REVIEW";
          }
        }
        if (requiresContradictionReview && finalProposition.verificationState !== "CONTRADICTED") {
          finalProposition = await this.store.upsertProposition({ ...finalProposition, verificationState: "CONTRADICTED", requiresHumanReview: true });
        }
        if (finalProposition.verificationState === "NEEDS_HUMAN_REVIEW" || finalProposition.verificationState === "CONTRADICTED" || finalProposition.verificationState === "INSUFFICIENT_EVIDENCE") {
          reviewItems.push(await this.store.addReviewItem({
            jurisdictionCode: jurisdiction.code,
            reason: finalProposition.verificationState === "CONTRADICTED" ? "CONFLICTING_AUTHORITIES" : finalProposition.effectiveFrom ? "EXTRACTION_UNCERTAINTY" : "UNCLEAR_EFFECTIVE_DATE",
            sourceId: finalProposition.sourceId,
            propositionId: finalProposition.id,
            summary: verification.reasons.join("; ") || "Proposition requires review.",
            status: "OPEN",
          }));
        }
      }
    }
    const propositions = await this.store.listPropositions({ jurisdictionCode: jurisdiction.code });
    const contradictions = await this.store.listContradictions(jurisdiction.code);
    const topicsCovered = [...new Set(propositions.map((proposition) => proposition.topic))];
    const allTopics = new Set(discovered.flatMap((source) => source.topics));
    const topicsIncomplete = [...allTopics].filter((topic) => !topicsCovered.includes(topic));
    const coverage: CoverageReport = {
      jurisdictionCode: jurisdiction.code,
      sourcesDiscovered: discovered.length,
      primarySources: discovered.filter((source) => source.kind !== "secondary").length,
      secondarySources: discovered.filter((source) => source.kind === "secondary").length,
      sourcesFetched: sources.filter((source) => source.status === "FETCHED" || source.status === "UNCHANGED").length,
      propositionsExtracted: propositionCount,
      propositionsVerified: verifiedCount,
      propositionsRequiringReview: reviewItems.length,
      contradictions: contradictions.length,
      staleSources: sources.filter((source) => source.status === "UNCHANGED").length,
      topicsCovered,
      topicsIncomplete,
      sourceFreshness: sources.length ? "measured_at_acquisition" : "no_sources_acquired",
      coverageScore: discovered.length === 0 ? 0 : Math.round(((sources.filter((source) => source.status === "FETCHED").length / discovered.length) * 0.4 + (topicsCovered.length / Math.max(1, allTopics.size)) * 0.6) * 100) / 100,
      lastAcquisition: this.now(),
      lastVerification: verifiedCount > 0 ? this.now() : undefined,
    };
    await this.store.saveCoverage(coverage);
    return { jurisdiction, sources, propositions: propositionCount, verified: verifiedCount, reviewItems, contradictions: contradictionCount, coverage };
  }

  async acquireWave1(codes: readonly string[] = WAVE_1_JURISDICTIONS.map((jurisdiction) => jurisdiction.code)): Promise<AcquisitionResult[]> {
    const results: AcquisitionResult[] = [];
    for (const code of codes) {
      const jurisdiction = WAVE_1_JURISDICTIONS.find((candidate) => candidate.code === code);
      if (!jurisdiction) throw new Error(`Unknown Wave 1 jurisdiction: ${code}`);
      results.push(await this.acquire(jurisdiction));
    }
    return results;
  }
}

export function createInMemoryAcquisitionWorker(options?: AcquisitionOptions): { worker: RegulatoryAcquisitionWorker; store: InMemoryRegulatoryStore } {
  const store = new InMemoryRegulatoryStore();
  return { store, worker: new RegulatoryAcquisitionWorker(store, new CatalogDiscoveryAdapter(), options) };
}
