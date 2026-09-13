// ---------------------------------------------------------------------------
// Atlas Durable Job System — Type Definitions
//
// Every background operation in Atlas runs as a durable job persisted in
// Postgres. Jobs survive worker/process failure, support step-level restart,
// idempotency, and full execution audit trails.
//
// Design principles:
//   - Database is the source of truth (no in-memory state)
//   - Workers are stateless and horizontally scalable
//   - Every job has an idempotency key
//   - Steps are independently retryable
//   - Every state change emits an immutable event
//   - Tenant isolation enforced at every layer
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Status enums
// ---------------------------------------------------------------------------

export const JOB_STATUSES = [
  "pending",
  "queued",
  "processing",
  "completed",
  "failed",
  "retrying",
  "cancelled",
  "awaiting_review",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_STEP_STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed",
  "skipped",
  "cancelled",
] as const;
export type JobStepStatus = (typeof JOB_STEP_STATUSES)[number];

export const JOB_ATTEMPT_STATUSES = [
  "running",
  "completed",
  "failed",
  "timeout",
] as const;
export type JobAttemptStatus = (typeof JOB_ATTEMPT_STATUSES)[number];

export const JOB_EVENT_TYPES = [
  "job_created",
  "job_queued",
  "job_started",
  "job_completed",
  "job_failed",
  "job_retrying",
  "job_cancelled",
  "job_awaiting_review",
  "step_started",
  "step_completed",
  "step_failed",
  "step_skipped",
  "human_review_requested",
  "human_approval",
  "human_rejection",
] as const;
export type JobEventType = (typeof JOB_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Job types
//
// Platform-infrastructure job types (knowledge monitoring, content engine and
// document worker stages) are declared once in @/lib/platform/types and folded
// in here so there is exactly ONE canonical job vocabulary.
// ---------------------------------------------------------------------------

export const JOB_TYPES = [
  // Evidence pipeline
  "evidence_ingestion",
  "evidence_extraction",
  "evidence_classification",
  "evidence_entity_resolution",
  "evidence_claim_reconstruction",
  "evidence_requirements",
  "evidence_gap_intelligence",
  "evidence_contradiction_detection",
  "evidence_supplement_opportunity",
  "evidence_qa",

  // Agent tasks
  "agent_evidence",
  "agent_gap_intelligence",
  "agent_supplement_reasoning",
  "agent_qa",
  "agent_infrastructure",
  "agent_support",

  // Document processing
  "document_ingestion",
  "document_reprocessing",

  // Claim workflows
  "claim_discovery",
  "claim_analysis",
  "claim_reconstruction",

  // Archive processing
  "archive_processing",
  "archive_file_ingestion",

  // Recommendation workflows
  "recommendation_detection",

  // Orchestration
  "pipeline_orchestration",

  // System
  "system_maintenance",
  "system_cleanup",

  // Platform infrastructure — knowledge monitoring, source checking,
  // versioning, the content engine and document worker stages. Declared here
  // because this file is the single canonical job vocabulary.
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
] as const;
export type JobType = (typeof JOB_TYPES)[number];

// ---------------------------------------------------------------------------
// Priority levels
// ---------------------------------------------------------------------------

export const JOB_PRIORITIES = [
  1, // Critical user-facing
  2, // Active claim processing
  3, // Normal AI processing
  4, // Background analysis
  5, // Analytics/learning
] as const;
export type JobPriority = (typeof JOB_PRIORITIES)[number];

// ---------------------------------------------------------------------------
// Core interfaces
// ---------------------------------------------------------------------------

/** A durable background job. */
export interface AtlasJob {
  _id: string;
  _creationTime: number;

  tenant_id: string;
  user_id: string | null;

  job_type: JobType;
  status: JobStatus;
  priority: JobPriority;

  /** Idempotency key — duplicate submissions with the same key are deduplicated. */
  idempotency_key: string;

  /** Serialized input payload. Large documents are stored by reference, not inline. */
  payload: Record<string, unknown>;

  /** Serialized output result. */
  result: Record<string, unknown> | null;

  /** Structured error when the job fails. */
  error: JobError | null;

  attempt_count: number;
  max_attempts: number;

  /** ISO timestamp when the job is eligible for execution. */
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;

  /** Worker that currently owns this job (null when not processing). */
  locked_by: string | null;
  locked_at: string | null;

  /** ISO timestamp after which the lock expires (stuck-job detection). */
  lock_expires_at: string | null;

  /** Parent job id for sub-workflows. */
  parent_job_id: string | null;

  /** Current step id being executed. */
  current_step_id: string | null;

  /** Tags for filtering/routing. */
  tags: string[];

  /** Structured AI metadata when the job involves model calls. */
  ai_metadata: AIMetadata | null;

  created_at: string;
  updated_at: string;
}

/** A single step in a multi-step job workflow. */
export interface AtlasJobStep {
  _id: string;
  _creationTime: number;

  job_id: string;
  step_type: string;

  /** Execution order (0-indexed). */
  sequence: number;

  status: JobStepStatus;

  /** Input for this specific step (may reference parent step outputs). */
  input: Record<string, unknown>;

  /** Output produced by this step. */
  output: Record<string, unknown> | null;

  /** Error if this step failed. */
  error: JobError | null;

  attempt_count: number;
  max_attempts: number;

  started_at: string | null;
  completed_at: string | null;

  /** Step-level AI metadata. */
  ai_metadata: AIMetadata | null;

  created_at: string;
  updated_at: string;
}

/** A record of every execution attempt for a job or step. */
export interface AtlasJobAttempt {
  _id: string;
  _creationTime: number;

  job_id: string;
  step_id: string | null;

  attempt_number: number;

  /** Worker that executed this attempt. */
  worker_id: string;

  status: JobAttemptStatus;

  /** Duration in milliseconds. */
  duration_ms: number | null;

  error: JobError | null;

  /** Execution metadata: timing, model usage, tokens, etc. */
  execution_metadata: Record<string, unknown>;

  started_at: string;
  completed_at: string | null;
}

/** An immutable event in the job audit trail. */
export interface AtlasJobEvent {
  _id: string;
  _creationTime: number;

  job_id: string;
  step_id: string | null;

  event_type: JobEventType;

  /** Structured event payload. */
  payload: Record<string, unknown>;

  /** Who/what triggered this event (worker_id, user_id, "system"). */
  actor: string;

  created_at: string;
}

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

export interface JobError {
  code: string;
  message: string;
  /** Structured details (e.g., which model failed, which provider was down). */
  details: Record<string, unknown>;
  /** Whether this error is retryable. */
  retryable: boolean;
}

// ---------------------------------------------------------------------------
// AI metadata
// ---------------------------------------------------------------------------

export interface AIMetadata {
  provider: string | null;
  model: string | null;
  /** Total tokens consumed (prompt + completion). */
  tokens_used: number | null;
  /** Estimated cost in USD (where available). */
  estimated_cost_usd: number | null;
  /** Duration of the AI call in milliseconds. */
  latency_ms: number | null;
  /** AI confidence score (0..1). */
  confidence: number | null;
  /** Number of AI retries within this step. */
  retry_count: number;
}

// ---------------------------------------------------------------------------
// Agent types
// ---------------------------------------------------------------------------

export const AGENT_TYPES = [
  "evidence",
  "gap_intelligence",
  "supplement_reasoning",
  "qa",
  "infrastructure",
  "support",
] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export interface AgentTask {
  agent_type: AgentType;
  tenant_id: string;
  user_id: string | null;
  task_id: string;
  context: Record<string, unknown>;
  allowed_tools: string[];
  model_policy: ModelPolicy;
  max_attempts: number;
  timeout_ms: number;
  priority: JobPriority;
}

export interface AgentResult {
  status: JobStatus;
  output: Record<string, unknown>;
  confidence: number | null;
  evidence: string[];
  provenance: ProvenanceRecord[];
  model_used: string | null;
  token_usage: number;
  duration_ms: number;
  errors: JobError[];
  requires_human_review: boolean;
}

// ---------------------------------------------------------------------------
// Model routing
// ---------------------------------------------------------------------------

export interface ModelPolicy {
  /** Preferred provider (e.g., "openai", "anthropic", "google"). */
  preferred_provider?: string;
  /** Preferred model for this task type. */
  preferred_model?: string;
  /** Maximum model tier allowed (prevents cost escalation). */
  max_model_tier?: "fast" | "standard" | "strong";
  /** Maximum tokens per call. */
  max_tokens?: number;
  /** Maximum cost per call in USD. */
  max_cost_usd?: number;
  /** Whether to escalate to a stronger model on low confidence. */
  allow_escalation?: boolean;
}

// ---------------------------------------------------------------------------
// Tool system types
// ---------------------------------------------------------------------------

export interface AgentTool {
  id: string;
  name: string;
  description: string;
  /** read | write | high_risk_write */
  risk_level: "read" | "write" | "high_risk_write";
  /** Roles that can use this tool. */
  allowed_roles: string[];
  /** Input schema for validation. */
  input_schema: Record<string, unknown>;
  /** Whether this tool enforces tenant isolation internally. */
  tenant_isolated: boolean;
}

export interface ToolCallRecord {
  tool_id: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  duration_ms: number;
  success: boolean;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export interface ProvenanceRecord {
  /** Document or entity this provenance entry refers to. */
  source_id: string;
  source_type: "document" | "claim" | "evidence" | "estimate" | "external";
  source_title: string;
  /** What aspect of the source was used. */
  contribution: string;
  /** Confidence that this source supports the claim. */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Human review
// ---------------------------------------------------------------------------

export const REVIEW_DECISIONS = [
  "pending",
  "approved",
  "rejected",
  "needs_changes",
] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export interface HumanReviewRecord {
  _id: string;
  job_id: string;
  step_id: string | null;

  /** The AI recommendation being reviewed. */
  ai_recommendation: Record<string, unknown>;
  /** Confidence of the AI output. */
  ai_confidence: number;
  /** Supporting evidence/provenance. */
  evidence: ProvenanceRecord[];

  /** Who reviewed. */
  reviewer_id: string | null;
  decision: ReviewDecision;
  decision_reason: string | null;

  requested_at: string;
  decided_at: string | null;
}

// ---------------------------------------------------------------------------
// Worker types
// ---------------------------------------------------------------------------

export interface WorkerConfig {
  /** Unique worker identifier (hostname + pid or uuid). */
  worker_id: string;
  /** How often to poll for jobs (ms). */
  poll_interval_ms: number;
  /** Maximum concurrent jobs this worker can process. */
  max_concurrent_jobs: number;
  /** Job types this worker handles (empty = all). */
  job_types: JobType[];
  /** Lock timeout for stuck-job detection (ms). */
  lock_timeout_ms: number;
}

// ---------------------------------------------------------------------------
// Job creation helpers
// ---------------------------------------------------------------------------

export interface CreateJobInput {
  tenant_id: string;
  user_id?: string | null;
  job_type: JobType;
  priority?: JobPriority;
  idempotency_key: string;
  payload: Record<string, unknown>;
  max_attempts?: number;
  scheduled_at?: string | null;
  parent_job_id?: string | null;
  tags?: string[];
}

export interface EnqueueResult {
  job_id: string;
  /** True when an existing job with the same idempotency key was found. */
  deduplicated: boolean;
}

// ---------------------------------------------------------------------------
// Pipeline definition (for evidence pipeline conversion in Phase 4)
// ---------------------------------------------------------------------------

export interface PipelineStepDefinition {
  id: string;
  type: string;
  /** Input schema — references previous step outputs. */
  input_mapping: Record<string, string>;
  /** Maximum retries for this step. */
  max_attempts: number;
  /** Timeout for this step in ms. */
  timeout_ms: number;
  /** Whether this step requires human review. */
  requires_review: boolean;
  /** Step IDs that must complete before this step runs. */
  depends_on?: string[];
}

export interface PipelineDefinition {
  id: string;
  name: string;
  version?: string;
  steps: PipelineStepDefinition[];
  /** Maximum total execution time for the pipeline. */
  total_timeout_ms: number;
}

// ---------------------------------------------------------------------------
// Error classification (Phase 9)
// ---------------------------------------------------------------------------

export const ERROR_CATEGORIES = [
  "TRANSIENT",
  "PERMANENT",
  "AUTHORIZATION",
  "VALIDATION",
  "PROVIDER",
  "TIMEOUT",
  "NOT_FOUND",
  "UNKNOWN",
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/**
 * Classify a JobError into an error category.
 * Determines whether the error is retryable.
 */
export function classifyError(error: JobError): ErrorCategory {
  const code = (error.code ?? "").toUpperCase();
  const msg = (error.message ?? "").toLowerCase();

  // Provider-specific errors
  if (code.startsWith("AI_") || code.startsWith("TOOL_")) {
    if (code.includes("TIMEOUT")) return "TRANSIENT";
    if (code.includes("PROVIDER_ERROR") || code.includes("EXECUTION_FAILED")) return "TRANSIENT";
    if (code.includes("INPUT_INVALID")) return "VALIDATION";
    if (code.includes("LOW_CONFIDENCE") || code.includes("INVALID_OUTPUT")) return "PROVIDER";
    if (code.includes("AUTHORIZATION") || code.includes("NOT_FOUND")) return "AUTHORIZATION";
    return "PROVIDER";
  }

  // Explicit category codes
  if (code.includes("TIMEOUT")) return "TIMEOUT";
  if (code.includes("AUTHORIZATION") || code.includes("TENANT_ISOLATION")) return "AUTHORIZATION";
  if (code.includes("NOT_FOUND") || code.includes("DOCUMENT_NOT_FOUND") || code.includes("CLAIM_NOT_FOUND")) return "NOT_FOUND";
  if (code.includes("VALIDATION") || code.includes("INVALID")) return "VALIDATION";
  if (code.includes("DEPENDENCY_FAILED") || code.includes("NETWORK")) return "TRANSIENT";
  if (code === "HUMAN_REVIEW_REQUIRED") return "PERMANENT";
  if (code === "HANDLER_NOT_FOUND") return "PERMANENT";
  if (code === "UNKNOWN" || code === "") return "UNKNOWN";

  // Check message-based heuristics
  if (msg.includes("timeout") || msg.includes("timed out")) return "TIMEOUT";
  if (msg.includes("unauthorized") || msg.includes("forbidden")) return "AUTHORIZATION";
  if (msg.includes("not found") || msg.includes("missing")) return "NOT_FOUND";
  if (msg.includes("network") || msg.includes("econnrefused") || msg.includes("fetch failed")) return "TRANSIENT";

  return "UNKNOWN";
}

/** Whether an error category is retryable. */
export function isRetryableCategory(category: ErrorCategory): boolean {
  switch (category) {
    case "TRANSIENT":
    case "TIMEOUT":
    case "PROVIDER":
    case "UNKNOWN":
      return true;
    case "PERMANENT":
    case "AUTHORIZATION":
    case "VALIDATION":
    case "NOT_FOUND":
      return false;
  }
}

// ---------------------------------------------------------------------------
// Job handler types (Phase 3)
// ---------------------------------------------------------------------------

/** The result of executing a job handler. */
export interface HandlerResult {
  /** Whether the handler succeeded. */
  success: boolean;
  /** Output data to persist on the job. */
  result?: Record<string, unknown>;
  /** Error if the handler failed. */
  error?: JobError;
  /** AI metadata to record. */
  ai_metadata?: AIMetadata;
  /** Whether human review is required before proceeding. */
  requires_human_review?: boolean;
}

/**
 * A job handler function.
 * Receives a JobExecutionContext and returns a HandlerResult.
 */
export type JobHandler = (
  ctx: JobExecutionContext,
) => Promise<HandlerResult>;

// ---------------------------------------------------------------------------
// Execution context (Phase 6)
// ---------------------------------------------------------------------------

/** Structured logger for worker execution. */
export interface WorkerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

/** Context passed to job handlers during execution. */
export interface JobExecutionContext {
  /** The full job record. */
  job: AtlasJob;
  /** Current step being executed (null for simple jobs). */
  step: AtlasJobStep | null;
  /** All steps for multi-step jobs. */
  steps: AtlasJobStep[];
  /** The Supabase client (service_role for RPC access). */
  supabase: unknown; // SupabaseClient — avoid circular import
  /** Structured logger. */
  logger: WorkerLogger;
  /** Abort signal — true when the job is cancelled or timed out. */
  signal: AbortSignal;
  /** Worker identifier. */
  worker_id: string;
  /** Current attempt number. */
  attempt: number;
}

// ---------------------------------------------------------------------------
// Worker configuration (extended from existing WorkerConfig)
// ---------------------------------------------------------------------------

/** Configuration for the Atlas worker. */
export interface AtlasWorkerConfig {
  /** Unique worker identifier. */
  worker_id: string;
  /** How often to poll for jobs (ms). */
  poll_interval_ms: number;
  /** Maximum concurrent jobs this worker can process. */
  max_concurrent_jobs: number;
  /** Job types this worker handles (empty = all). */
  job_types: string[];
  /** Lock timeout for stuck-job detection (ms). */
  lock_timeout_ms: number;
  /** Execution timeout per job (ms). */
  job_timeout_ms: number;
  /** Whether to run the stuck-job sweeper. */
  enable_sweeper: boolean;
  /** How often to run the sweeper (ms). */
  sweeper_interval_ms: number;
  /** Supabase service-role URL. */
  supabase_url: string;
  /** Supabase service-role key. */
  supabase_service_role_key: string;
}

/** Default worker configuration. */
export const DEFAULT_WORKER_CONFIG: AtlasWorkerConfig = {
  worker_id: `worker-${typeof process !== "undefined" ? process.pid ?? "unknown" : "browser"}-${Date.now()}`,
  poll_interval_ms: 2_000,
  max_concurrent_jobs: 5,
  job_types: [],
  lock_timeout_ms: 300_000, // 5 minutes
  job_timeout_ms: 300_000, // 5 minutes
  enable_sweeper: true,
  sweeper_interval_ms: 60_000, // 1 minute
  supabase_url: "",
  supabase_service_role_key: "",
};
