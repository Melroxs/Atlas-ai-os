// ---------------------------------------------------------------------------
// Atlas Voice Runtime — Configuration
//
// Loads voice provider configuration from environment variables. Supports:
//   - ElevenLabs Speech Engine: preferred speech layer (no browser secret)
//   - Browser (existing): no API key needed
//   - NVIDIA NIM VoiceChat: NVIDIA_NIM_API_KEY, NVIDIA_NIM_VOICE_MODEL
//
// Reuses NVIDIA_NIM_API_KEY from the existing AI Runtime config.
//
// ELEVENLABS_API_KEY is intentionally NOT read here. It is a server-only
// secret held by the `voice-transcribe` / `voice-synthesize` Edge Functions;
// the browser never sees it and never needs it.
// ---------------------------------------------------------------------------

import type { VoiceProviderConfig, VoiceProviderCapabilities, VoiceRuntimeConfig } from "./types";
import { DEFAULT_VOICE_RUNTIME_CONFIG } from "./types";

// ---------------------------------------------------------------------------
// Environment helper
// ---------------------------------------------------------------------------

function env(key: string): string | undefined {
  if (typeof process !== "undefined") {
    return (process.env as Record<string, string | undefined>)[key];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Browser voice provider config (always available in browser environments)
// ---------------------------------------------------------------------------

function loadBrowserVoiceConfig(): VoiceProviderConfig {
  return {
    id: "browser",
    name: "Browser Voice (Web Speech API)",
    baseUrl: "",
    apiKey: "",
    defaultModel: "browser-native",
    priority: 10, // lowest priority — used as fallback
    enabled: true,
    capabilities: {
      stt: true,
      tts: true,
      speechToSpeech: false,
      streamingInput: false,
      streamingOutput: false,
      interruption: false,
      voiceControl: false,
      realtime: false,
    },
  };
}

// ---------------------------------------------------------------------------
// NVIDIA NIM VoiceChat configuration
// ---------------------------------------------------------------------------

const NIM_VOICE_CAPABILITIES: VoiceProviderCapabilities = {
  stt: true,
  tts: true,
  speechToSpeech: true,
  streamingInput: true,
  streamingOutput: true,
  interruption: true,
  voiceControl: true,
  realtime: true,
};

function loadNvidiaNimVoiceConfig(): VoiceProviderConfig | null {
  // Reuse the existing NVIDIA NIM API key from the AI Runtime
  const apiKey = (env("NVIDIA_NIM_API_KEY") ?? "").trim();
  if (!apiKey) return null;

  const baseUrl = (env("NVIDIA_NIM_BASE_URL") ?? "https://integrate.api.nvidia.com/v1").trim();
  const defaultModel = (env("NVIDIA_NIM_VOICE_MODEL") ?? "nvidia/nemotron-3-voicechat-12b").trim();

  return {
    id: "nvidia-nim-voice",
    name: "NVIDIA NIM VoiceChat (Nemotron)",
    baseUrl,
    apiKey,
    defaultModel,
    priority: 1, // highest priority — preferred provider when available
    enabled: true,
    capabilities: NIM_VOICE_CAPABILITIES,
  };
}

// ---------------------------------------------------------------------------
// ElevenLabs Speech Engine configuration
// ---------------------------------------------------------------------------

const ELEVENLABS_VOICE_CAPABILITIES: VoiceProviderCapabilities = {
  stt: true,
  tts: true,
  // Atlas's own conversation engine is the responder, never ElevenLabs.
  speechToSpeech: false,
  streamingInput: false,
  streamingOutput: false,
  interruption: true,
  voiceControl: true,
  realtime: false,
};

/**
 * ElevenLabs is the preferred speech layer whenever the app runs in a browser
 * that can capture/play audio and the operator has not forced browser voice.
 *
 * `apiKey` is deliberately empty: the credential lives only in the Edge
 * Functions. Whether the server actually holds a key is discovered on first
 * use — a clear "not configured" error triggers the existing fallback chain
 * instead of a silent failure.
 */
function loadElevenLabsVoiceConfig(): VoiceProviderConfig | null {
  const forced = (env("ATLAS_VOICE_PROVIDER") ?? env("VITE_ATLAS_VOICE_PROVIDER") ?? "")
    .trim()
    .toLowerCase();
  if (forced === "browser") return null;

  return {
    id: "elevenlabs",
    name: "ElevenLabs Speech Engine",
    baseUrl: (env("ELEVENLABS_BASE_URL") ?? "https://api.elevenlabs.io").trim(),
    apiKey: "",
    defaultModel: (env("ELEVENLABS_MODEL_ID") ?? "eleven_multilingual_v2").trim(),
    priority: 0, // highest — ElevenLabs is Atlas's speech layer
    enabled: true,
    capabilities: ELEVENLABS_VOICE_CAPABILITIES,
  };
}

/** True unless the operator explicitly forced browser-only voice. */
export function isElevenLabsVoiceConfigured(): boolean {
  return loadElevenLabsVoiceConfig() !== null;
}

// ---------------------------------------------------------------------------
// Configuration cache
// ---------------------------------------------------------------------------

let _configCache: VoiceProviderConfig[] | null = null;

/**
 * Load all configured voice providers from environment.
 * Browser voice is always included as a fallback.
 */
export function loadVoiceProviderConfigs(): VoiceProviderConfig[] {
  if (_configCache) return _configCache;

  const configs: VoiceProviderConfig[] = [];

  // ElevenLabs Speech Engine (preferred speech layer)
  const elevenlabs = loadElevenLabsVoiceConfig();
  if (elevenlabs) configs.push(elevenlabs);

  // NVIDIA NIM VoiceChat (used when configured and ElevenLabs is unavailable)
  const nvidia = loadNvidiaNimVoiceConfig();
  if (nvidia) configs.push(nvidia);

  // Browser voice (always available as fallback)
  configs.push(loadBrowserVoiceConfig());

  // Sort by priority (lower = higher priority)
  configs.sort((a, b) => a.priority - b.priority);

  _configCache = configs;
  return configs;
}

/** Reset config cache (for testing). */
export function resetVoiceConfigCache(): void {
  _configCache = null;
}

/**
 * Check if NVIDIA NIM voice credentials are configured.
 */
export function isNvidiaNimVoiceConfigured(): boolean {
  const key = (env("NVIDIA_NIM_API_KEY") ?? "").trim();
  return key.length > 0;
}

/**
 * Get the voice runtime config from environment with sensible defaults.
 */
export function getVoiceRuntimeConfig(): Partial<VoiceRuntimeConfig> {
  const config: Partial<VoiceRuntimeConfig> = {};

  const defaultProvider = (env("ATLAS_VOICE_PROVIDER") ?? "").trim();
  if (defaultProvider) config.defaultProvider = defaultProvider;

  const defaultVoice = (env("ATLAS_VOICE_DEFAULT_VOICE") ?? "").trim();
  if (defaultVoice) config.defaultVoice = defaultVoice;

  return config;
}

/**
 * Check if the NVIDIA NIM Nemotron voice model is explicitly configured.
 */
export function getNvidiaVoiceModel(): string {
  return (env("NVIDIA_NIM_VOICE_MODEL") ?? "nvidia/nemotron-3-voicechat-12b").trim();
}
