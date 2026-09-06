/* Supabase table rows are untyped at this repository boundary; conversions are centralized below. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AcquiredSource,
  Contradiction,
  CoverageReport,
  HumanReviewItem,
  JurisdictionRecord,
  RegulatoryProposition,
  RegulatoryStore,
} from "./types";

function sourceRow(source: AcquiredSource): Record<string, unknown> {
  return {
    id: source.id,
    jurisdiction_code: source.jurisdictionCode,
    url: source.url,
    canonical_url: source.canonicalUrl,
    title: source.title ?? null,
    publisher: source.publisher ?? null,
    kind: source.kind,
    authority_tier: source.authorityTier,
    relationship: source.relationship,
    discovery_source_id: source.discoverySourceId ?? null,
    citation: source.citation ?? null,
    topics: source.topics,
    content_type: source.contentType,
    content_hash: source.contentHash,
    byte_length: source.byteLength,
    status: source.status,
    http_status: source.httpStatus ?? null,
    raw_content: source.rawContent ?? null,
    fetch_error: source.fetchError ?? null,
    version: source.version,
    effective_from: source.effectiveFrom ?? null,
    effective_to: source.effectiveTo ?? null,
    last_fetched_at: source.lastFetchedAt ?? null,
  };
}

function propositionRow(proposition: RegulatoryProposition): Record<string, unknown> {
  return {
    id: proposition.id,
    jurisdiction_code: proposition.jurisdictionCode,
    topic: proposition.topic,
    actor: proposition.actor ?? null,
    claim_type: proposition.claimType ?? null,
    activity: proposition.activity ?? null,
    statement: proposition.statement,
    normalized_value: proposition.normalizedValue ?? null,
    citation: proposition.citation,
    source_id: proposition.sourceId,
    discovery_source_id: proposition.discoverySourceId ?? null,
    authority_tier: proposition.authorityTier,
    verification_state: proposition.verificationState,
    supplement_finding: proposition.supplementFinding ?? null,
    effective_from: proposition.effectiveFrom ?? null,
    effective_to: proposition.effectiveTo ?? null,
    enacted_at: proposition.enactedAt ?? null,
    amended_at: proposition.amendedAt ?? null,
    repealed_at: proposition.repealedAt ?? null,
    superseded_by: proposition.supersededBy ?? null,
    previous_version_id: proposition.previousVersionId ?? null,
    verified_at: proposition.verifiedAt ?? null,
    evidence_text: proposition.evidenceText ?? null,
    evidence_location: proposition.evidenceLocation ?? null,
    confidence: proposition.confidence ?? null,
    requires_human_review: proposition.requiresHumanReview ?? false,
  };
}

function sourceFromRow(row: Record<string, any>): AcquiredSource {
  return {
    id: row.id,
    jurisdictionCode: row.jurisdiction_code,
    url: row.url,
    canonicalUrl: row.canonical_url ?? row.url,
    title: row.title ?? undefined,
    publisher: row.publisher ?? undefined,
    kind: row.kind,
    authorityTier: row.authority_tier,
    relationship: row.relationship,
    discoverySourceId: row.discovery_source_id ?? undefined,
    citation: row.citation ?? undefined,
    topics: row.topics ?? [],
    contentType: row.content_type ?? "",
    contentHash: row.content_hash ?? "",
    byteLength: row.byte_length ?? 0,
    status: row.status,
    httpStatus: row.http_status ?? undefined,
    rawContent: row.raw_content ?? undefined,
    fetchError: row.fetch_error ?? undefined,
    version: row.version ?? 1,
    effectiveFrom: row.effective_from ?? undefined,
    effectiveTo: row.effective_to ?? undefined,
    lastFetchedAt: row.last_fetched_at ?? undefined,
  };
}

function propositionFromRow(row: Record<string, any>): RegulatoryProposition {
  return {
    id: row.id,
    jurisdictionCode: row.jurisdiction_code,
    topic: row.topic,
    actor: row.actor ?? undefined,
    claimType: row.claim_type ?? undefined,
    activity: row.activity ?? undefined,
    statement: row.statement,
    normalizedValue: row.normalized_value ?? undefined,
    citation: row.citation ?? {},
    sourceId: row.source_id,
    discoverySourceId: row.discovery_source_id ?? undefined,
    authorityTier: row.authority_tier,
    verificationState: row.verification_state,
    supplementFinding: row.supplement_finding ?? undefined,
    effectiveFrom: row.effective_from ?? undefined,
    effectiveTo: row.effective_to ?? undefined,
    enactedAt: row.enacted_at ?? undefined,
    amendedAt: row.amended_at ?? undefined,
    repealedAt: row.repealed_at ?? undefined,
    supersededBy: row.superseded_by ?? undefined,
    previousVersionId: row.previous_version_id ?? undefined,
    verifiedAt: row.verified_at ?? undefined,
    evidenceText: row.evidence_text ?? undefined,
    evidenceLocation: row.evidence_location ?? undefined,
    confidence: row.confidence ?? undefined,
    requiresHumanReview: row.requires_human_review ?? false,
  };
}

export class InMemoryRegulatoryStore implements RegulatoryStore {
  readonly jurisdictions = new Map<string, JurisdictionRecord>();
  readonly sources = new Map<string, AcquiredSource>();
  readonly propositions = new Map<string, RegulatoryProposition>();
  readonly contradictions = new Map<string, Contradiction>();
  readonly reviews = new Map<string, HumanReviewItem>();
  readonly coverage = new Map<string, CoverageReport>();

  async upsertJurisdiction(jurisdiction: JurisdictionRecord): Promise<void> {
    this.jurisdictions.set(jurisdiction.code, jurisdiction);
  }

  async upsertSource(source: AcquiredSource): Promise<AcquiredSource> {
    const previous = this.sources.get(source.id);
    const next = { ...previous, ...source, version: previous && previous.contentHash !== source.contentHash ? previous.version + 1 : source.version };
    this.sources.set(source.id, next);
    return next;
  }

  async findSourceByHash(contentHash: string): Promise<AcquiredSource | undefined> {
    return [...this.sources.values()].find((source) => source.contentHash === contentHash && contentHash.length > 0);
  }

  async getSource(id: string): Promise<AcquiredSource | undefined> {
    return this.sources.get(id);
  }

  async upsertProposition(proposition: RegulatoryProposition): Promise<RegulatoryProposition> {
    let id = proposition.id ?? `${proposition.sourceId}_${proposition.topic}_${this.propositions.size}`;
    const previous = this.propositions.get(id);
    if (previous && (previous.statement !== proposition.statement || previous.evidenceText !== proposition.evidenceText || previous.effectiveFrom !== proposition.effectiveFrom || previous.effectiveTo !== proposition.effectiveTo)) {
      id = `${id}_v${this.propositions.size + 1}`;
      proposition = { ...proposition, previousVersionId: previous.id };
    }
    const next = { ...proposition, id };
    this.propositions.set(id, next);
    return next;
  }

  async listPropositions(filter: Partial<Pick<RegulatoryProposition, "jurisdictionCode" | "topic" | "verificationState">> = {}): Promise<RegulatoryProposition[]> {
    return [...this.propositions.values()].filter((item) => Object.entries(filter).every(([key, value]) => item[key as keyof typeof item] === value));
  }

  async addContradiction(contradiction: Contradiction): Promise<Contradiction> {
    const id = contradiction.id ?? `contradiction_${this.contradictions.size + 1}`;
    const next = { ...contradiction, id };
    this.contradictions.set(id, next);
    return next;
  }

  async listContradictions(jurisdictionCode?: string): Promise<Contradiction[]> {
    return [...this.contradictions.values()].filter((item) => !jurisdictionCode || item.jurisdictionCode === jurisdictionCode);
  }

  async addReviewItem(item: HumanReviewItem): Promise<HumanReviewItem> {
    const id = item.id ?? `review_${this.reviews.size + 1}`;
    const next = { ...item, id, createdAt: item.createdAt ?? new Date().toISOString() };
    this.reviews.set(id, next);
    return next;
  }

  async listReviewItems(jurisdictionCode?: string): Promise<HumanReviewItem[]> {
    return [...this.reviews.values()].filter((item) => !jurisdictionCode || item.jurisdictionCode === jurisdictionCode);
  }

  async saveCoverage(report: CoverageReport): Promise<void> {
    this.coverage.set(report.jurisdictionCode, report);
  }

  async getCoverage(jurisdictionCode?: string): Promise<CoverageReport[]> {
    return [...this.coverage.values()].filter((item) => !jurisdictionCode || item.jurisdictionCode === jurisdictionCode);
  }
}

export class SupabaseRegulatoryStore implements RegulatoryStore {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async upsertJurisdiction(jurisdiction: JurisdictionRecord): Promise<void> {
    const { error } = await this.client.from("atlas_regulatory_jurisdictions").upsert({
      code: jurisdiction.code,
      name: jurisdiction.name,
      country: jurisdiction.country,
      regulator: jurisdiction.regulator ?? null,
      insurance_department_url: jurisdiction.insuranceDepartmentUrl ?? null,
      legislature_url: jurisdiction.legislatureUrl ?? null,
      administrative_code_url: jurisdiction.administrativeCodeUrl ?? null,
      wave: jurisdiction.wave ?? null,
      wave_group: jurisdiction.waveGroup ?? null,
    });
    if (error) throw new Error(`Failed to persist jurisdiction: ${error.message}`);
  }

  async upsertSource(source: AcquiredSource): Promise<AcquiredSource> {
    const { data, error } = await this.client.from("atlas_regulatory_sources").upsert(sourceRow(source), { onConflict: "id" }).select("*").single();
    if (error) throw new Error(`Failed to persist source: ${error.message}`);
    const persisted = sourceFromRow(data as Record<string, any>);
    if (persisted.contentHash) {
      const versionResult = await this.client.from("atlas_regulatory_source_versions").upsert({ source_id: persisted.id, version: persisted.version, content_hash: persisted.contentHash, content_type: persisted.contentType, byte_length: persisted.byteLength, raw_content: persisted.rawContent ?? null, effective_from: persisted.effectiveFrom ?? null, effective_to: persisted.effectiveTo ?? null, fetched_at: persisted.lastFetchedAt ?? null }, { onConflict: "source_id,version" });
      if (versionResult.error) throw new Error(`Failed to persist source version: ${versionResult.error.message}`);
    }
    return persisted;
  }

  async findSourceByHash(contentHash: string): Promise<AcquiredSource | undefined> {
    if (!contentHash) return undefined;
    const { data, error } = await this.client.from("atlas_regulatory_sources").select("*").eq("content_hash", contentHash).maybeSingle();
    if (error) throw new Error(`Failed to find source hash: ${error.message}`);
    return data ? sourceFromRow(data as Record<string, any>) : undefined;
  }

  async getSource(id: string): Promise<AcquiredSource | undefined> {
    const { data, error } = await this.client.from("atlas_regulatory_sources").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`Failed to load source: ${error.message}`);
    return data ? sourceFromRow(data as Record<string, any>) : undefined;
  }

  async upsertProposition(proposition: RegulatoryProposition): Promise<RegulatoryProposition> {
    let nextProposition = proposition;
    if (proposition.id) {
      const previousResult = await this.client.from("atlas_regulatory_propositions").select("*").eq("id", proposition.id).maybeSingle();
      if (previousResult.error) throw new Error(`Failed to inspect proposition version: ${previousResult.error.message}`);
      const previous = previousResult.data ? propositionFromRow(previousResult.data as Record<string, any>) : undefined;
      if (previous && (previous.statement !== proposition.statement || previous.evidenceText !== proposition.evidenceText || previous.effectiveFrom !== proposition.effectiveFrom || previous.effectiveTo !== proposition.effectiveTo)) {
        const versionResult = await this.client.from("atlas_regulatory_proposition_versions").select("version").eq("proposition_id", proposition.id).order("version", { ascending: false }).limit(1).maybeSingle();
        if (versionResult.error) throw new Error(`Failed to inspect proposition version history: ${versionResult.error.message}`);
        const nextVersion = Number((versionResult.data as { version?: number } | null)?.version ?? 1) + 1;
        nextProposition = { ...proposition, id: `${proposition.id}_v${nextVersion}`, previousVersionId: previous.id };
      }
    }
    const { data, error } = await this.client.from("atlas_regulatory_propositions").upsert(propositionRow(nextProposition), { onConflict: "id" }).select("*").single();
    if (error) throw new Error(`Failed to persist proposition: ${error.message}`);
    const persisted = propositionFromRow(data as Record<string, any>);
    const versionResult = await this.client.from("atlas_regulatory_proposition_versions").upsert({ proposition_id: persisted.id, version: 1, statement: persisted.statement, normalized_value: persisted.normalizedValue ?? null, verification_state: persisted.verificationState, effective_from: persisted.effectiveFrom ?? null, effective_to: persisted.effectiveTo ?? null, source_id: persisted.sourceId, evidence_text: persisted.evidenceText ?? null, evidence_location: persisted.evidenceLocation ?? null }, { onConflict: "proposition_id,version" });
    if (versionResult.error) throw new Error(`Failed to persist proposition version: ${versionResult.error.message}`);
    return persisted;
  }

  async listPropositions(filter: Partial<Pick<RegulatoryProposition, "jurisdictionCode" | "topic" | "verificationState">> = {}): Promise<RegulatoryProposition[]> {
    let query = this.client.from("atlas_regulatory_propositions").select("*");
    if (filter.jurisdictionCode) query = query.eq("jurisdiction_code", filter.jurisdictionCode);
    if (filter.topic) query = query.eq("topic", filter.topic);
    if (filter.verificationState) query = query.eq("verification_state", filter.verificationState);
    const { data, error } = await query;
    if (error) throw new Error(`Failed to list propositions: ${error.message}`);
    return ((data ?? []) as Record<string, any>[]).map(propositionFromRow);
  }

  async addContradiction(contradiction: Contradiction): Promise<Contradiction> {
    const { data, error } = await this.client.from("atlas_regulatory_contradictions").insert({ jurisdiction_code: contradiction.jurisdictionCode, source_a_id: contradiction.sourceAId, source_b_id: contradiction.sourceBId, proposition_a_id: contradiction.propositionAId ?? null, proposition_b_id: contradiction.propositionBId ?? null, authority_tier_a: contradiction.authorityTierA, authority_tier_b: contradiction.authorityTierB, conflict_type: contradiction.conflictType, description: contradiction.description, resolution_status: contradiction.resolutionStatus }).select("*").single();
    if (error) throw new Error(`Failed to persist contradiction: ${error.message}`);
    return { ...contradiction, id: (data as any).id };
  }

  async listContradictions(jurisdictionCode?: string): Promise<Contradiction[]> {
    let query = this.client.from("atlas_regulatory_contradictions").select("*");
    if (jurisdictionCode) query = query.eq("jurisdiction_code", jurisdictionCode);
    const { data, error } = await query;
    if (error) throw new Error(`Failed to list contradictions: ${error.message}`);
    return ((data ?? []) as any[]).map((row) => ({ ...row, jurisdictionCode: row.jurisdiction_code, sourceAId: row.source_a_id, sourceBId: row.source_b_id, propositionAId: row.proposition_a_id, propositionBId: row.proposition_b_id, authorityTierA: row.authority_tier_a, authorityTierB: row.authority_tier_b, conflictType: row.conflict_type, resolutionStatus: row.resolution_status }));
  }

  async addReviewItem(item: HumanReviewItem): Promise<HumanReviewItem> {
    const { data, error } = await this.client.from("atlas_regulatory_review_queue").insert({ jurisdiction_code: item.jurisdictionCode, reason: item.reason, source_id: item.sourceId ?? null, proposition_id: item.propositionId ?? null, contradiction_id: item.contradictionId ?? null, summary: item.summary, status: item.status, reviewer_id: item.reviewerId ?? null, reviewer_notes: item.reviewerNotes ?? null }).select("*").single();
    if (error) throw new Error(`Failed to persist review item: ${error.message}`);
    return { ...item, id: (data as any).id, createdAt: (data as any).created_at };
  }

  async listReviewItems(jurisdictionCode?: string): Promise<HumanReviewItem[]> {
    let query = this.client.from("atlas_regulatory_review_queue").select("*");
    if (jurisdictionCode) query = query.eq("jurisdiction_code", jurisdictionCode);
    const { data, error } = await query;
    if (error) throw new Error(`Failed to list review items: ${error.message}`);
    return ((data ?? []) as any[]).map((row) => ({ ...row, jurisdictionCode: row.jurisdiction_code, sourceId: row.source_id, propositionId: row.proposition_id, contradictionId: row.contradiction_id, reviewerId: row.reviewer_id, reviewerNotes: row.reviewer_notes, createdAt: row.created_at, resolvedAt: row.resolved_at }));
  }

  async saveCoverage(report: CoverageReport): Promise<void> {
    const { error } = await this.client.from("atlas_regulatory_coverage").upsert({ jurisdiction_code: report.jurisdictionCode, sources_discovered: report.sourcesDiscovered, primary_sources: report.primarySources, secondary_sources: report.secondarySources, sources_fetched: report.sourcesFetched, propositions_extracted: report.propositionsExtracted, propositions_verified: report.propositionsVerified, propositions_requiring_review: report.propositionsRequiringReview, contradictions: report.contradictions, stale_sources: report.staleSources, topics_covered: report.topicsCovered, topics_incomplete: report.topicsIncomplete, source_freshness: report.sourceFreshness ?? null, coverage_score: report.coverageScore, last_acquisition: report.lastAcquisition ?? null, last_verification: report.lastVerification ?? null }, { onConflict: "jurisdiction_code" });
    if (error) throw new Error(`Failed to persist coverage: ${error.message}`);
  }

  async getCoverage(jurisdictionCode?: string): Promise<CoverageReport[]> {
    let query = this.client.from("atlas_regulatory_coverage").select("*");
    if (jurisdictionCode) query = query.eq("jurisdiction_code", jurisdictionCode);
    const { data, error } = await query;
    if (error) throw new Error(`Failed to list coverage: ${error.message}`);
    return ((data ?? []) as any[]).map((row) => ({ ...row, jurisdictionCode: row.jurisdiction_code, sourcesDiscovered: row.sources_discovered, primarySources: row.primary_sources, secondarySources: row.secondary_sources, sourcesFetched: row.sources_fetched, propositionsExtracted: row.propositions_extracted, propositionsVerified: row.propositions_verified, propositionsRequiringReview: row.propositions_requiring_review, staleSources: row.stale_sources, topicsCovered: row.topics_covered, topicsIncomplete: row.topics_incomplete, sourceFreshness: row.source_freshness, coverageScore: row.coverage_score, lastAcquisition: row.last_acquisition, lastVerification: row.last_verification }));
  }
}
