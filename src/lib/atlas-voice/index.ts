// ---------------------------------------------------------------------------
// Atlas Voice — barrel export
//
// The voice TOOL layer: real Atlas navigation and real Atlas data access for
// spoken commands, plus the ElevenLabs speech transport. Import from
// "@/lib/atlas-voice".
// ---------------------------------------------------------------------------

// Speech transport (ElevenLabs via authenticated Edge Functions)
export {
  ELEVENLABS_PROVIDER_ID,
  SpeechEngineError,
  audioRecordingSupported,
  base64ToBytes,
  blobToBase64,
  bytesToBase64,
  elevenLabsSpeak,
  elevenLabsTranscribe,
  startAudioRecording,
} from "./elevenlabs";
export type { AudioRecorder, SpeechEngine, SpokenAudio } from "./elevenlabs";

// Navigation bridge (the app's real router)
export {
  ATLAS_DESTINATIONS,
  isAtlasNavigatorRegistered,
  navigateAtlas,
  registerAtlasNavigator,
  resetAtlasNavigator,
  resolveAtlasTarget,
  resolveDestinationId,
} from "./navigation";
export type {
  AtlasDestination,
  AtlasNavigationResult,
  AtlasNavigationTarget,
  AtlasTargetResolution,
} from "./navigation";

// Atlas tools (navigate_atlas, search_claims, get_claim, …)
export {
  ATLAS_VOICE_TOOLS,
  AtlasToolError,
  claimLabel,
  getClaim,
  getClaimFindings,
  getMissingEvidence,
  navigateAtlasTool,
  resolveClaim,
  searchClaims,
} from "./tools";
export type {
  AtlasToolName,
  AtlasToolResult,
  ClaimFinding,
  ClaimSummary,
  GetClaimData,
  GetClaimFindingsData,
  GetMissingEvidenceData,
  MissingEvidenceItem,
  NavigateAtlasArgs,
  SearchClaimsData,
} from "./tools";
