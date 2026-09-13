// ---------------------------------------------------------------------------
// useAtlasVoice — React binding for the centralized Atlas voice session.
//
// Reads the single module-level session store via useSyncExternalStore, so
// every consumer (global control, contextual buttons) shares ONE microphone,
// ONE conversation and ONE brain. No provider needed, no duplicate sessions.
// ---------------------------------------------------------------------------

import { useCallback, useSyncExternalStore } from "react";
import {
  cancelAtlasVoiceListening,
  clearAtlasVoiceError,
  getAtlasVoiceState,
  processAtlasVoiceTranscript,
  setAtlasVoiceAutoSpeak,
  startAtlasVoiceListening,
  stopAtlasVoiceListening,
  stopAtlasVoiceSpeaking,
  subscribeToAtlasVoice,
  type AtlasVoiceState,
  type AtlasVoiceStatus,
} from "@/lib/atlas-voice/session";

export interface UseAtlasVoiceResult extends AtlasVoiceState {
  /** Begin recording. */
  start: () => Promise<void>;
  /** Stop recording and run the transcript through Atlas. */
  stop: () => Promise<void>;
  /** Start/stop recording in one gesture (push-to-talk). */
  toggle: () => Promise<void>;
  /** Discard the current recording. */
  cancel: () => void;
  /** Interrupt Atlas mid-sentence. */
  interrupt: () => void;
  /** Speak an arbitrary line (used by replay/confirmations). */
  dismissError: () => void;
  setAutoSpeak: (value: boolean) => void;
  /** True while Atlas is doing anything visible. */
  busy: boolean;
}

export function useAtlasVoice(): UseAtlasVoiceResult {
  const state = useSyncExternalStore(
    subscribeToAtlasVoice,
    getAtlasVoiceState,
    getAtlasVoiceState,
  );

  const start = useCallback(() => startAtlasVoiceListening(), []);
  const stop = useCallback(() => stopAtlasVoiceListening(), []);
  const cancel = useCallback(() => cancelAtlasVoiceListening(), []);
  const interrupt = useCallback(() => stopAtlasVoiceSpeaking(), []);
  const dismissError = useCallback(() => clearAtlasVoiceError(), []);
  const setAutoSpeak = useCallback((value: boolean) => setAtlasVoiceAutoSpeak(value), []);

  const toggle = useCallback(async () => {
    if (getAtlasVoiceState().status === "listening") {
      await stopAtlasVoiceListening();
      return;
    }
    await startAtlasVoiceListening();
  }, []);

  const status: AtlasVoiceStatus = state.status;
  const busy =
    status === "listening" ||
    status === "processing" ||
    status === "executing" ||
    status === "speaking";

  return {
    ...state,
    start,
    stop,
    toggle,
    cancel,
    interrupt,
    dismissError,
    setAutoSpeak,
    busy,
  };
}

/**
 * Programmatic entry point for non-React callers (including contextual
 * buttons and tests). Uses the SAME session and the SAME brain.
 */
export { processAtlasVoiceTranscript };
