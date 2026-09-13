// ---------------------------------------------------------------------------
// Atlas Platform Infrastructure — Public API
//
// Extends the existing job + Everest knowledge systems with:
//   - canonical scheduling
//   - source checking / change detection
//   - knowledge versioning (historical as-of resolution)
//   - the content engine foundation
// ---------------------------------------------------------------------------

export * from "./types";
export {
  MAX_BACKOFF_EXPONENT,
  scheduleBackoffSeconds,
  computeNextRunAt,
  isScheduleDue,
  selectDueSchedules,
  scheduleOccurrenceKey,
  validateScheduleDraft,
  describeCadence,
  describeScheduleHealth,
} from "./scheduler";
export {
  normalizeSourceContent,
  contentFingerprint,
  compareFingerprints,
  outcomeFromFetch,
  classifyFetchFailure,
  shouldProcessChange,
  planFollowOnWork,
  isSourceDue,
} from "./change-detection";
export {
  isAllowedSourceUrl,
  classifyHttpStatus,
  createHttpSourceFetcher,
} from "./fetcher";
export {
  sortVersionChain,
  latestVersion,
  nextVersionNumber,
  isVerifiableVersion,
  validateNewVersion,
  selectVersionAsOf,
  describeAsOf,
  planSupersession,
  summarizeVersionChain,
} from "./versions";
export {
  nextContentStatuses,
  canTransition,
  validateTransition,
  requiresHumanApproval,
  validateContentDraft,
  slugify,
  buildSeoMetadata,
  deriveKeywords,
  buildLinkedInDraft,
  buildProvenanceChain,
  hasCompleteProvenance,
  groupProvenanceByContent,
} from "./content";
export {
  createPlatformHandlers,
  registerPlatformHandlers,
  handleKnowledgeSourceCheck,
  handleKnowledgeDetectChange,
  handleKnowledgeFreshnessSweep,
  handlePlatformFailedJobSweep,
  handleContentDetectOpportunity,
  handleContentResearch,
  handleContentWriteBlog,
  handleContentReview,
  handleContentWriteLinkedin,
  handleContentPublishBlog,
  handleContentPublishLinkedin,
} from "./handlers";
export type {
  PlatformServices,
  SourceRegistryPort,
  KnowledgePort,
  ContentPort,
  JobsPort,
} from "./handlers";
export {
  listSchedules,
  upsertSchedule,
  setScheduleEnabled,
  fireDueSchedules,
  recordScheduleResult,
  listDueSources,
  getSource,
  listSourceChecks,
  recordSourceCheck,
  setSourceCheckFrequency,
  listKnowledgeVersions,
  knowledgeAsOf,
  createKnowledgeVersion,
  verifyKnowledge,
  createContent,
  transitionContent,
  listContent,
  getContent,
  listContentProvenance,
  publicContentList,
  listFailedJobs,
} from "./rpc";
export {
  createSupabasePlatformServices,
  type PlatformServiceOptions,
} from "./services";
export {
  createSupabaseWorkerRPC,
  createPlatformRuntime,
  runPlatformTick,
  reportScheduleResult,
  type PlatformRuntime,
  type PlatformRuntimeOptions,
  type PlatformTickResult,
} from "./runtime";
