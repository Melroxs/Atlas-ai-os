// ---------------------------------------------------------------------------
// Atlas Voice Runtime — Barrel Export
//
// Import from "@/lib/voice-runtime" to access the provider-agnostic voice runtime.
// ---------------------------------------------------------------------------

// Runtime API
export {
  initVoiceRuntime,
  resetVoiceRuntime,
  isVoiceRuntimeInitialized,
  startVoiceSession,
  getCurrentSession,
  closeCurrentSession,
  sendVoiceText,
  interruptVoice,
  runVoiceAction,
  getVoiceRuntimeStatus,
} from "./runtime";

// Provider registry
export {
  initializeVoiceRegistry,
  registerVoiceProvider,
  getVoiceProvider,
  getAllVoiceProviders,
  getAvailableVoiceProviders,
  isVoiceProviderAvailable,
  buildVoiceFallbackChain,
  resetVoiceRegistry,
} from "./registry";

// Providers (for direct registration)
export { BrowserVoiceProvider } from "./providers/browser-voice";
export { ElevenLabsVoiceProvider } from "./providers/elevenlabs-voice";
export { NvidiaNimVoiceProvider } from "./providers/nvidia-nim-voice";
export type {
  ElevenLabsVoiceTransport,
  VoicePlayback,
  PlaybackFactory,
} from "./providers/elevenlabs-voice";

// Configuration
export {
  loadVoiceProviderConfigs,
  resetVoiceConfigCache,
  isElevenLabsVoiceConfigured,
  isNvidiaNimVoiceConfigured,
  getVoiceRuntimeConfig,
  getNvidiaVoiceModel,
} from "./config";

// Session management
export {
  getActiveSession,
  getActiveSessions,
  getActiveSessionCount,
  closeAllSessions,
  resetSessionManager,
} from "./session";

// Events
export {
  subscribeToVoiceEvents,
  emitVoiceEvent,
  getVoiceEventHistory,
  resetVoiceEvents,
  createVoiceEvent,
} from "./events";

// Telemetry
export {
  recordVoiceSession,
  getVoiceTelemetryRecords,
  getVoiceTelemetryByProvider,
  getVoiceTotalCost,
  getVoiceErrorRateByProvider,
  resetVoiceTelemetry,
} from "./telemetry";

// Actions
export {
  registerVoiceAction,
  registerVoiceActions,
  getVoiceAction,
  getAllVoiceActions,
  getVoiceActionsByCategory,
  getVoiceActionsByRisk,
  executeVoiceAction,
  clearVoiceActions,
  registerDefaultVoiceActions,
} from "./actions";

// Intent Router
export {
  classifyVoiceIntent,
  intentRequiresConfirmation,
  getAllIntentPatterns,
} from "./intent-router";

// Safety Gates
export {
  initSafetyGate,
  resetSafetyGate,
  checkConfirmationRequired,
  confirmAction,
  confirmLatestPending,
  rejectAction,
  getPendingConfirmations,
  getSafetyAuditLog,
  getConfirmationStats,
} from "./safety";

// Voice-AI Bridge
export {
  initVoiceBridge,
  resetVoiceBridge,
  setEntityContext,
  setPageContext,
  processVoiceTranscript,
  handleAiResponse,
  getConversationHistory,
  getCurrentPendingConfirmations,
} from "./voice-bridge";

// Errors
export {
  createVoiceError,
  isRetryableCode as isVoiceRetryableCode,
  httpStatusToVoiceError,
  sanitizeVoiceErrorMessage,
} from "./errors";

// Types
export type {
  VoiceProviderId,
  VoiceProviderConfig,
  VoiceProviderCapabilities,
  VoiceSessionConfig,
  VoiceSession,
  VoiceSessionState,
  VoiceSessionHandle,
  VoiceEventType,
  VoiceEvent,
  VoiceEventHandler,
  VoiceActionDefinition,
  VoiceActionParameter,
  VoiceActionContext,
  VoiceActionResult,
  VoiceActionRiskLevel,
  VoiceProviderAdapter,
  VoiceTelemetryRecord,
  VoiceRuntimeConfig,
} from "./types";

export type {
  VoiceErrorCode,
  VoiceError,
} from "./errors";

export type {
  VoiceIntent,
  VoiceIntentCategory,
  VoiceIntentEntity,
} from "./intent-router";

export type {
  SafetyGateConfig,
  PendingConfirmation,
  SafetyAuditEntry,
  ConfirmationStatus,
} from "./safety";

export type {
  VoiceBridgeConfig,
  VoiceBridgeTurn,
  VoiceBridgeResult,
  VoiceBridgeResponse,
} from "./voice-bridge";
