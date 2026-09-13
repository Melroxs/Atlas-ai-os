// ---------------------------------------------------------------------------
// Atlas Platform Infrastructure — Types
//
// This module deliberately does NOT redefine concepts that already exist:
//   - job types / statuses          -> @/lib/jobs/types
//   - authority tiers & provenance  -> @/lib/atlas-data/authority
//   - freshness states              -> @/lib/atlas-data/excellence
//
// It adds only the platform layer: scheduling, source checking, knowledge
// versioning, and the content-engine foundation.
// ---------------------------------------------------------------------------

import type { FreshnessState } from "@/lib/atlas-data/excellence";
import type { JobType } from "@/lib/jobs/types";

export type { FreshnessState };

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/** A recurring Atlas task. A schedule never runs work — it enqueues a job. */
export interface ScheduleDefinition {
  id: string;
  name: string;
  job_type: string;
  payload: Record<string, unknown>;
  priority: number;
  interval_seconds: number;
  max_attempts: number;
  enabled: boolean;
  /** null = platform-scope (global knowledge work). */
  tenant_id: string | null;
  tags: string[];
  next_run_at: string;
  last_run_at: string | null;
  last_job_id: string | null;
  consecutive_failures: number;
  description?: string | null;
}

export interface ScheduleDraft {
  name: string;
  jobType: string;
  intervalSeconds: number;
  payload?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  tenantId?: string | null;
  tags?: string[];
  enabled?: boolean;
  description?: string | null;
}

export const MIN_SCHEDULE_INTERVAL_SECONDS = 30;
/** Failures back off exponentially, capped at one day. */
export const MAX_SCHEDULE_BACKOFF_SECONDS = 86_400;

// ---------------------------------------------------------------------------
// Source checking / change detection
// ---------------------------------------------------------------------------

export const SOURCE_CHECK_STATUSES = [
  "unchanged",
  "changed",
  "failed",
  "unavailable",
  "skipped",
] as const;
export type SourceCheckStatus = (typeof SOURCE_CHECK_STATUSES)[number];

export interface SourceCheckOutcome {
  status: SourceCheckStatus;
  contentHash: string | null;
  previousHash: string | null;
  changeType: string | null;
  httpStatus: number | null;
  latencyMs: number | null;
  normalizedLength: number | null;
  error: string | null;
  retryable: boolean;
}

export interface SourceCheckRecord extends SourceCheckOutcome {
  _id: string;
  sourceId: string;
  checkedAt: number;
  jobId: string | null;
  checker: string | null;
}

/** A registered authoritative source (Everest registry row, trimmed). */
export interface RegisteredSource {
  sourceId: string;
  name: string;
  organization: string;
  authorityTier: string;
  sourceType: string;
  canonicalUrl?: string | null;
  retrievalMethod?: string | null;
  updateFrequency?: string | null;
  checkFrequencySeconds?: number | null;
  lastCheckedAt?: number | null;
  lastChangedAt?: number | null;
  contentHash?: string | null;
  lastKnownVersion?: string | null;
  freshness?: FreshnessState | string | null;
  nextCheckAt?: number | null;
  consecutiveFailures?: number | null;
  lastFetchError?: string | null;
  enabled?: boolean | null;
}

/** Injectable fetcher so the change-detection pipeline is testable offline. */
export interface SourceFetcher {
  fetch(url: string): Promise<FetchedSource>;
}

export interface FetchedSource {
  ok: boolean;
  httpStatus: number | null;
  body: string | null;
  error: string | null;
  /** Network/timeout failures are retryable; 404/410 are not. */
  retryable: boolean;
  latencyMs: number;
}

/** The comparison decision for one source check. */
export type ChangeDecision = "unchanged" | "changed";

export interface ComparisonResult {
  decision: ChangeDecision;
  fingerprint: string;
  previousFingerprint: string | null;
  normalizedLength: number;
}

// ---------------------------------------------------------------------------
// Knowledge versioning
// ---------------------------------------------------------------------------

export const KNOWLEDGE_VERSION_STATUSES = [
  "active",
  "superseded",
  "draft",
  "rejected",
  "archived",
] as const;
export type KnowledgeVersionStatus = (typeof KNOWLEDGE_VERSION_STATUSES)[number];

export interface KnowledgeVersion {
  knowledgeId: string;
  versionGroup: string;
  versionNumber: number;
  title: string;
  statement: string;
  interpretation?: string | null;
  sourceId: string;
  status: KnowledgeVersionStatus | string;
  reviewStatus?: string | null;
  version?: string | null;
  effectiveDate?: number | null;
  effectiveTo?: number | null;
  contentHash?: string | null;
  freshness?: FreshnessState | string | null;
  supersedesId?: string | null;
  supersededById?: string | null;
  confidence?: number | null;
}

export interface AsOfQuery {
  /** Epoch ms of the point in time being asked about (e.g. date of loss). */
  asOf: number;
  jurisdiction?: string | null;
  industry?: string | null;
}

// ---------------------------------------------------------------------------
// Content engine
// ---------------------------------------------------------------------------

export const CONTENT_TYPES = ["blog", "linkedin_post"] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export const CONTENT_STATUSES = [
  "opportunity",
  "researching",
  "drafted",
  "in_review",
  "approved",
  "published",
  "failed",
  "archived",
] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export const CONTENT_APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "needs_changes",
] as const;
export type ContentApprovalStatus = (typeof CONTENT_APPROVAL_STATUSES)[number];

/** SEO contract for the future public blog. */
export interface ContentSeo {
  title?: string;
  slug?: string;
  description?: string;
  canonicalUrl?: string;
  publishedDate?: string;
  updatedDate?: string;
  topic?: string;
  jurisdiction?: string;
  keywords?: string[];
}

export interface ContentItem {
  _id: string;
  contentType: ContentType;
  status: ContentStatus;
  slug?: string | null;
  title: string;
  summary?: string | null;
  body?: string | null;
  seo?: ContentSeo | null;
  jurisdiction?: string | null;
  industry?: string | null;
  effectiveDate?: number | null;
  knowledgeIds?: string[];
  knowledgeVersionIds?: string[];
  sourceIds?: string[];
  researchJobId?: string | null;
  draftJobId?: string | null;
  parentContentId?: string | null;
  approvalStatus: ContentApprovalStatus;
  approvedBy?: string | null;
  approvedAt?: number | null;
  publishedAt?: number | null;
  publishTarget?: string | null;
  failureReason?: string | null;
  updatedAt?: number | null;
}

/** One edge of the provenance chain: content -> knowledge version -> source. */
export interface ContentProvenanceEdge {
  contentId: string;
  knowledgeId: string;
  sourceId?: string | null;
  version?: string | null;
  effectiveDate?: number | null;
  contribution?: string | null;
  confidence?: number | null;
}

export interface ContentDraftInput {
  contentType: ContentType;
  title: string;
  summary?: string | null;
  body?: string | null;
  seo?: ContentSeo | null;
  jurisdiction?: string | null;
  industry?: string | null;
  effectiveDate?: number | null;
  knowledgeIds?: string[];
  sourceIds?: string[];
  parentContentId?: string | null;
  researchJobId?: string | null;
}

// ---------------------------------------------------------------------------
// Platform job types
//
// The canonical job vocabulary lives in @/lib/jobs/types (single source of
// truth). This is a type-only narrowing of the platform-owned subset — no
// runtime cross-import, so the job module stays independently loadable.
// ---------------------------------------------------------------------------

export type PlatformJobType = Extract<
  JobType,
  | "knowledge_source_check"
  | "knowledge_freshness_sweep"
  | "knowledge_detect_change"
  | "knowledge_extract"
  | "knowledge_verify"
  | "knowledge_version"
  | "knowledge_refresh"
  | "knowledge_index_maintenance"
  | "content_detect_opportunity"
  | "content_research"
  | "content_write_blog"
  | "content_write_linkedin"
  | "content_review"
  | "content_publish_blog"
  | "content_publish_linkedin"
  | "document_ingest"
  | "document_extract"
  | "document_ocr"
  | "document_embed"
  | "document_index"
  | "platform_failed_job_sweep"
>;

/**
 * Runtime list of the platform-owned job types, for filtering a worker's
 * claim set. Kept as a value (not derived by reflection) so the type and the
 * runtime list cannot drift silently — a `const` assertion below ties them.
 */
export const PLATFORM_JOB_TYPES = [
  "knowledge_source_check",
  "knowledge_freshness_sweep",
  "knowledge_detect_change",
  "knowledge_extract",
  "knowledge_verify",
  "knowledge_version",
  "knowledge_refresh",
  "knowledge_index_maintenance",
  "content_detect_opportunity",
  "content_research",
  "content_write_blog",
  "content_write_linkedin",
  "content_review",
  "content_publish_blog",
  "content_publish_linkedin",
  "document_ingest",
  "document_extract",
  "document_ocr",
  "document_embed",
  "document_index",
  "platform_failed_job_sweep",
] as const satisfies readonly PlatformJobType[];
