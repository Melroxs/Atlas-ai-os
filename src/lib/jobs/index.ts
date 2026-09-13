// ---------------------------------------------------------------------------
// Atlas Job System — Barrel Export
//
// Import from "@/lib/jobs" to access the job system.
// ---------------------------------------------------------------------------

export * from "./types";
export * from "./engine";
export {
  createJob,
  enqueueEvidencePipeline,
  enqueueAgentTask,
  createJobStep,
  completeStep,
  failStep,
  retryStep,
  completeJob,
  failJob,
  cancelJob,
  awaitingReview,
  resumeFromReview,
  getJob,
  listJobs,
  getJobEvents,
  getJobStats,
} from "./rpc";
export {
  registerJobHandler,
  registerJobHandlers,
  getJobHandler,
  hasJobHandler,
  listRegisteredHandlers,
  clearHandlers,
} from "./handler-registry";
export { PIPELINE_CONFIG, isEvidencePipelineEnabled } from "./pipeline-config";
export { AtlasWorker } from "./worker";
export type { WorkerRPC, WorkerStatus } from "./worker";
export {
  getEvidencePipelineDefinition,
  getStepDependencies,
  getDownstreamSteps,
  generateCorrelationId,
  buildEvidencePipelinePayload,
  EVIDENCE_PIPELINE_STEPS,
  type EvidencePipelinePayload,
  type EvidencePipelineStepType,
} from "./evidence-pipeline";
export {
  EVIDENCE_PIPELINE_HANDLERS,
  registerEvidencePipelineHandlers,
} from "./evidence-handlers";
export {
  loadEvidenceData,
  loadClaimPackage,
  loadTenantDocuments,
  toClaimSnapshot,
  type EvidenceData,
  type ClaimPackageData,
  type AtlasDocument,
} from "./evidence-data-loader";
export {
  triggerOnDocumentUploaded,
  triggerOnClaimCreated,
  triggerManual,
  type TriggerResult,
} from "./pipeline-trigger";
export {
  getPipelineConfig,
  setPipelineConfig,
  resetPipelineConfig,
  type PipelineConfig,
} from "./pipeline-config";
export {
  AGENT_PIPELINE_STEPS,
  getAgentPipelineSteps,
  registerAgentPipeline,
  registerAgentPipelineHandlers,
  AGENT_PIPELINE_HANDLERS,
  handleEvidenceAgentStep,
  handleGapIntelligenceStep,
  handleSupplementReasoningStep,
  handleQAValidationStep,
  type AgentPipelineStepType,
  type EvidenceAgentStepResult,
  type GapAgentStepResult,
  type SupplementAgentStepResult,
  type QAStepResult,
} from "./agent-pipeline";
export {
  getFullPipelineDefinition,
  getAllStepTypes,
  isAgentStep,
  isDeterministicStep,
  getReadySteps,
  isPipelineComplete,
  getPipelineSummary,
} from "./pipeline-orchestrator";
export {
  createReview,
  getReview,
  listReviews,
  listJobReviews,
  approveReviewRPC,
  rejectReviewRPC,
  requestChangesRPC,
  countPendingReviews,
} from "./review-rpc";

// Claim Review Handler
export {
  CLAIM_REVIEW_JOB_TYPES,
  handleClaimReviewJob,
  handleSupplementPrepJob,
  handleDailyScanJob,
} from "./claim-review-handler";
export { registerClaimReviewHandlers } from "./claim-review-registration";

// Scalability (Milestone 9)
export {
  getBackpressureLevel,
  getMaxClaimForLevel,
  evaluateBackpressure,
  checkTenantQuota,
  DEFAULT_BACKPRESSURE,
  DEFAULT_TENANT_QUOTA,
  SCALE_PROFILES,
  DEFAULT_PRIORITY_BANDS,
  type BackpressureLevel,
  type BackpressureThresholds,
  type TenantQuota,
  type ScaleProfile,
  type PriorityBand,
  type BackpressureDecision,
  type QuotaCheckResult,
} from "./scale-config";
export {
  AIConcurrencyLimiter,
  DEFAULT_AI_CONFIG,
  type AIConcurrencyConfig,
  type AICallRequest,
  type AICallResult,
  type AILimiterStats,
} from "./ai-concurrency";
export {
  MetricsCollector,
  type MetricsSnapshot,
  type QueueMetrics,
  type JobMetrics,
  type WorkerMetrics,
  type AgentMetrics,
  type AIMetrics,
  type ReviewMetrics,
  type TenantMetrics,
} from "./metrics";
export {
  runLoadTest,
  createSimJob,
  SimJobQueue,
  SimWorker,
  resetJobCounter,
  type SimJob,
  type SimWorkerConfig,
  type SimJobResult,
  type LoadTestConfig,
  type LoadTestResult,
} from "./load-test";

// Capacity Benchmark (Milestone 10)
export {
  runScalingBenchmark,
  measureThroughput,
  createBenchmarkJob,
  resetBenchmarkJobCounter,
  BenchmarkQueue,
  BenchmarkWorker,
  type BenchmarkJob,
  type WorkerBenchmarkConfig,
  type WorkerScalingResult,
  type ScalingBenchmarkConfig,
  type ScalingBenchmarkResult,
} from "./capacity-benchmark";

// AI Workload Benchmark (Milestone 10)
export {
  runAIBenchmark,
  DEFAULT_AGENT_PROFILES,
  type AIAgentProfile,
  type AIBenchmarkConfig,
  type AIBenchmarkResult,
  type AICallRecord,
  type AIEconomicsModel,
  type AgentBreakdown,
} from "./ai-benchmark";

// Adaptive Backpressure (Milestone 10)
export {
  AdaptiveBackpressureController,
  DEFAULT_ADAPTIVE_CONFIG,
  type AdaptiveConfig,
  type SystemObservation,
  type AdaptiveDecision,
  type AdaptiveSeverity,
} from "./adaptive-backpressure";

// Enhanced Observability (Milestone 10)
export {
  ObservabilityCollector,
  ATLAS_METRICS,
  type MetricPoint,
  type TenantContext,
  type PipelineContext,
  type ObservabilitySnapshot,
  type TenantSummary,
  type GlobalSummary,
  type TenantDiagnosis,
} from "./observability";

// Capacity Report (Milestone 10)
export {
  generateCapacityReport,
  computeSystemCapacity,
  findBottleneck,
  formatCapacityReport,
  generateRecommendedConfig,
  type CapacityReport,
  type CapacityModelInput,
  type TargetConfig,
  type ObservedMetrics,
  type SustainableCapacity,
  type RecommendedConfig,
} from "./capacity-report";
