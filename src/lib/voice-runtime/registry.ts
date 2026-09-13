// ---------------------------------------------------------------------------
// Atlas Voice Runtime — Provider Registry
//
// Manages the set of available voice providers. Handles registration,
// provider selection, and fallback chain construction.
// ---------------------------------------------------------------------------

import type {
  VoiceProviderAdapter,
  VoiceProviderId,
  VoiceProviderConfig,
} from "./types";
import { loadVoiceProviderConfigs } from "./config";

// ---------------------------------------------------------------------------
// Registry singleton
// ---------------------------------------------------------------------------

const _providers: Map<VoiceProviderId, VoiceProviderAdapter> = new Map();
let _initialized = false;

/**
 * Initialize the voice provider registry from environment configuration.
 * Safe to call multiple times — only initializes once.
 */
export async function initializeVoiceRegistry(): Promise<void> {
  if (_initialized) return;

  const configs = loadVoiceProviderConfigs();
  for (const config of configs) {
    if (config.id === "browser") {
      const { BrowserVoiceProvider } = await import("./providers/browser-voice");
      _providers.set("browser", new BrowserVoiceProvider(config));
    } else if (config.id === "elevenlabs") {
      const { ElevenLabsVoiceProvider } = await import("./providers/elevenlabs-voice");
      _providers.set("elevenlabs", new ElevenLabsVoiceProvider(config));
    } else if (config.id === "nvidia-nim-voice") {
      const { NvidiaNimVoiceProvider } = await import("./providers/nvidia-nim-voice");
      _providers.set("nvidia-nim-voice", new NvidiaNimVoiceProvider(config));
    }
  }

  _initialized = true;
}

/**
 * Register a voice provider adapter directly (for testing or custom providers).
 */
export function registerVoiceProvider(adapter: VoiceProviderAdapter): void {
  _providers.set(adapter.id, adapter);
  _initialized = true;
}

/**
 * Get a specific voice provider adapter.
 */
export function getVoiceProvider(id: VoiceProviderId): VoiceProviderAdapter | undefined {
  return _providers.get(id);
}

/**
 * Get all registered providers, sorted by priority.
 */
export function getAllVoiceProviders(): VoiceProviderAdapter[] {
  return Array.from(_providers.values());
}

/**
 * Get all available (enabled + has credentials) providers.
 */
export function getAvailableVoiceProviders(): VoiceProviderAdapter[] {
  return Array.from(_providers.values()).filter((p) => p.isAvailable());
}

/**
 * Check if a specific provider is available.
 */
export function isVoiceProviderAvailable(id: VoiceProviderId): boolean {
  const provider = _providers.get(id);
  return provider?.isAvailable() ?? false;
}

/**
 * Build a fallback chain for voice providers.
 * Returns providers in priority order, starting with the requested provider.
 */
export function buildVoiceFallbackChain(
  preferredProvider?: VoiceProviderId,
): VoiceProviderAdapter[] {
  const available = getAvailableVoiceProviders();

  if (preferredProvider) {
    const preferred = available.find((p) => p.id === preferredProvider);
    if (preferred) {
      const others = available.filter((p) => p.id !== preferredProvider);
      return [preferred, ...others];
    }
  }

  return available;
}

/**
 * Reset the registry (for testing).
 */
export function resetVoiceRegistry(): void {
  _providers.clear();
  _initialized = false;
}
