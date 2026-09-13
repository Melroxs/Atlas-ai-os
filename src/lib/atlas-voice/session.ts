// ---------------------------------------------------------------------------
// Atlas Voice — centralized session
//
// ONE voice session for the whole app (global control + contextual use), so
// there is never a second microphone or a second brain. Deliberately a plain
// module-level store (not a React provider) so it can be driven from anywhere
// — including outside React — and unit-tested without a renderer.
//
// The pipeline is exactly the Atlas architecture:
//
//   mic → ElevenLabs STT (through an Edge Function)
//       → Atlas intent router (deterministic, Atlas-owned)
//       → Atlas tool (navigate_atlas / search_claims / get_claim / …)
//         or  the EXISTING Atlas conversation engine (conversation-converse)
//       → Atlas answer
//       → ElevenLabs TTS (through an Edge Function)
//
// ElevenLabs never talks to the model and never holds the tools.
// ---------------------------------------------------------------------------

import { speakText, stopBrowserSpeaking } from "@/lib/voice";
import type { ApiFn } from "@/lib/api";
import { api } from "@/lib/api";
import { normalizeRpcArgs } from "@/lib/actions/rpc";
import { getSupabaseClient } from "@/lib/supabase";
import {
  SpeechEngineError,
  elevenLabsSpeak,
  elevenLabsTranscribe,
  startAudioRecording,
  type AudioRecorder,
  type SpeechEngine,
} from "./elevenlabs";
import { claimIdFromPath, pageLabelFromPath } from "./navigation";
import { isInterruptPhrase, routeAtlasIntent } from "./intent";
import {
  getClaim,
  getClaimFindings,
  getMissingEvidence,
  navigateAtlasTool,
  searchClaims,
} from "./tools";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type AtlasVoiceStatus =
  | "idle"
  | "listening"
  | "processing"
  | "executing"
  | "speaking"
  | "interrupted"
  | "error";

export interface AtlasVoiceState {
  status: AtlasVoiceStatus;
  /** Last user transcript. */
  transcript: string;
  /** Last Atlas answer (also what was spoken). */
  response: string;
  /** Which engine actually handled the most recent turn. */
  engine: SpeechEngine;
  /** Which engine should be attempted next. */
  preferredEngine: SpeechEngine;
  error: string | null;
  /** Human label for a running tool, e.g. "Opening the Carter claim…". */
  toolLabel: string | null;
  autoSpeak: boolean;
  /** True when the environment can capture audio at all. */
  supported: boolean;
}

const initialState: AtlasVoiceState = {
  status: "idle",
  transcript: "",
  response: "",
  engine: "elevenlabs",
  preferredEngine: "elevenlabs",
  error: null,
  toolLabel: null,
  autoSpeak: true,
  supported: true,
};

let _state: AtlasVoiceState = initialState;
const _listeners = new Set<() => void>();

function setState(patch: Partial<AtlasVoiceState>): void {
  _state = { ..._state, ...patch };
  for (const listener of _listeners.values()) {
    try {
      listener();
    } catch {
      // Subscriber errors never break voice.
    }
  }
}

export function getAtlasVoiceState(): AtlasVoiceState {
  return _state;
}

export function subscribeToAtlasVoice(listener: () => void): () => void {
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}

/** Test-only reset. */
export function resetAtlasVoiceSession(): void {
  _recorder = null;
  _ttsAbort?.abort();
  _ttsAbort = null;
  _currentAudio?.pause();
  _currentAudio = null;
  instanceTag += 1;
  _state = initialState;
}

// ---------------------------------------------------------------------------
// Current page context (so "what's missing?" knows the open claim)
// ---------------------------------------------------------------------------

export interface AtlasVoiceContext {
  claimId: string | null;
  page: string | null;
}

export function currentAtlasVoiceContext(): AtlasVoiceContext {
  if (typeof window === "undefined") return { claimId: null, page: null };
  const path = window.location.pathname;
  return { claimId: claimIdFromPath(path), page: pageLabelFromPath(path) };
}

// ---------------------------------------------------------------------------
// Runtime handles
// ---------------------------------------------------------------------------

let _recorder: AudioRecorder | null = null;
let _ttsAbort: AbortController | null = null;
let _currentAudio: HTMLAudioElement | null = null;
let instanceTag = 0;

// ---------------------------------------------------------------------------
// Conversation engine bridge (same brain as typed Atlas)
// ---------------------------------------------------------------------------

interface ConverseResult {
  answer?: unknown;
  message?: unknown;
  text?: unknown;
  response?: unknown;
}

/**
 * Send a transcript to the EXISTING Atlas conversation engine. Voice and
 * typing share this exact path, so both use the same identity, tenant,
 * retrieval, tools and permissions.
 */
export async function askAtlasConversation(
  transcript: string,
  context: AtlasVoiceContext,
): Promise<string> {
  const fn = api.conversation.converse as ApiFn<unknown>;
  const args: Record<string, unknown> = { transcript };
  if (context.claimId) args.claimId = context.claimId;
  if (context.page) args.pageContext = context.page;

  let raw: unknown;
  if (fn.kind === "client" && fn.clientImpl) {
    raw = await fn.clientImpl(args);
  } else {
    const supabase = getSupabaseClient();
    if (!supabase) throw new Error("Supabase is not configured.");
    const { data, error } = await supabase.rpc(fn.name, normalizeRpcArgs(args));
    if (error) throw error;
    raw = data;
  }

  const result = (raw ?? {}) as ConverseResult;
  const answer = [result.answer, result.message, result.text, result.response].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (!answer) {
    throw new Error("Atlas returned an empty response.");
  }
  return answer.trim();
}

// ---------------------------------------------------------------------------
// Speech output
// ---------------------------------------------------------------------------

/** Speak `text`, preferring ElevenLabs and falling back to browser speech. */
async function speakAnswer(text: string): Promise<SpeechEngine> {
  const clean = text.trim();
  if (!clean) return _state.engine;

  _ttsAbort?.abort();
  const controller = new AbortController();
  _ttsAbort = controller;

  if (_state.preferredEngine === "elevenlabs") {
    try {
      const spoken = await elevenLabsSpeak(clean, { signal: controller.signal });
      if (controller.signal.aborted) {
        spoken.revoke();
        setState({ status: "interrupted" });
        return "elevenlabs";
      }
      setState({ status: "speaking", engine: "elevenlabs" });
      await playUrl(spoken.url);
      spoken.revoke();
      if (!controller.signal.aborted && _state.status === "speaking") {
        setState({ status: "idle" });
      }
      return "elevenlabs";
    } catch (error) {
      if (controller.signal.aborted) {
        setState({ status: "interrupted" });
        return "elevenlabs";
      }
      // Fall through to browser speech — voice must never dead-end.
      const code = error instanceof SpeechEngineError ? error.code : "unavailable";
      if (code === "not_configured" || code === "unavailable") {
        console.info("[atlas-voice] ElevenLabs TTS unavailable — using browser speech.");
        setState({ preferredEngine: "browser" });
      }
    } finally {
      if (_ttsAbort === controller) _ttsAbort = null;
    }
  }

  setState({ status: "speaking", engine: "browser" });
  const started = speakText(clean, {
    onEnd: () => {
      if (_state.status === "speaking") setState({ status: "idle" });
    },
  });
  if (!started) {
    // No audio output available at all — the text answer still stands.
    setState({ status: "idle", engine: "browser" });
  }
  return "browser";
}

function playUrl(url: string): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof Audio === "undefined") {
      resolve();
      return;
    }
    const audio = new Audio(url);
    _currentAudio = audio;
    const finish = () => {
      _currentAudio = null;
      resolve();
    };
    audio.onended = finish;
    audio.onerror = finish;
    void audio.play().catch(finish);
  });
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Execute one Atlas tool for a routed intent. */
async function runIntent(transcript: string, context: AtlasVoiceContext) {
  const intent = routeAtlasIntent(transcript, { claimId: context.claimId });
  if (!intent) return null;

  const label =
    intent.name === "navigate_atlas"
      ? "Opening…"
      : intent.name === "search_claims"
        ? "Searching claims…"
        : intent.name === "get_missing_evidence"
          ? "Checking evidence…"
          : intent.name === "get_claim_findings"
            ? "Checking findings…"
            : "Loading claim…";

  setState({ status: "executing", toolLabel: label });

  switch (intent.name) {
    case "navigate_atlas":
      return navigateAtlasTool({
        destination: String(intent.args.destination ?? ""),
        claimRef: intent.args.claimRef ? String(intent.args.claimRef) : undefined,
      });
    case "search_claims":
      return searchClaims({
        query: intent.args.query ? String(intent.args.query) : undefined,
        needsAttention: intent.args.needsAttention === true,
      });
    case "get_claim":
      return getClaim(String(intent.args.claimRef ?? ""));
    case "get_claim_findings":
      return getClaimFindings(String(intent.args.claimRef ?? ""));
    case "get_missing_evidence":
      return getMissingEvidence(String(intent.args.claimRef ?? ""));
    default:
      return null;
  }
}

/**
 * Process a transcript through the Atlas pipeline. This is the single entry
 * point used by both push-to-talk and any programmatic caller.
 */
export async function processAtlasVoiceTranscript(
  transcript: string,
): Promise<void> {
  const clean = (transcript ?? "").trim();
  if (!clean) {
    setState({ status: "idle", transcript: "", toolLabel: null });
    return;
  }

  const context = currentAtlasVoiceContext();
  setState({ transcript: clean, error: null, toolLabel: null, status: "processing" });

  // "Atlas, stop" is handled locally — never sent to the model.
  if (isInterruptPhrase(clean)) {
    stopAtlasVoiceSpeaking();
    setState({ status: "interrupted", response: "Stopped." });
    setTimeout(() => {
      if (_state.status === "interrupted") setState({ status: "idle" });
    }, 600);
    return;
  }

  try {
    // 1. Deterministic Atlas tools first (navigation, claim lookup).
    const toolResult = await runIntent(clean, context);

    let answer: string;
    if (toolResult) {
      answer = toolResult.message;
      // If a claim question could not be answered (no claim found / ambiguous),
      // let the conversation engine try — it may have other context.
      if (!toolResult.success && toolResult.clarification) {
        answer = toolResult.message;
      }
    } else {
      // 2. Otherwise: the existing Atlas conversation engine.
      answer = await askAtlasConversation(clean, context);
    }

    setState({ response: answer, toolLabel: null, status: "idle" });
    if (_state.autoSpeak) await speakAnswer(answer);
  } catch (error) {
    const message =
      error instanceof SpeechEngineError
        ? error.message
        : "I couldn't complete that. Please try again.";
    console.error(
      "[atlas-voice] transcript processing failed:",
      error instanceof Error ? error.message : String(error),
    );
    setState({ status: "error", error: message, toolLabel: null });
  }
}

// ---------------------------------------------------------------------------
// Microphone control
// ---------------------------------------------------------------------------

export async function startAtlasVoiceListening(): Promise<void> {
  if (_state.status === "speaking") stopAtlasVoiceSpeaking();
  if (_state.status === "listening") return;

  setState({ error: null });
  try {
    _recorder = await startAudioRecording();
    setState({ status: "listening", transcript: "" });
  } catch (error) {
    const message =
      error instanceof SpeechEngineError
        ? error.message
        : "Atlas Voice needs microphone access. Allow the microphone and try again.";
    setState({ status: "error", error: message, supported: false });
  }
}

export async function stopAtlasVoiceListening(): Promise<void> {
  const recorder = _recorder;
  _recorder = null;
  if (!recorder) {
    if (_state.status === "listening") setState({ status: "idle" });
    return;
  }

  setState({ status: "processing" });
  const tag = instanceTag;

  try {
    const clip = await recorder.stop();
    if (tag !== instanceTag) return;

    if (_state.preferredEngine === "elevenlabs") {
      try {
        const transcript = await elevenLabsTranscribe(clip);
        if (tag !== instanceTag) return;
        setState({ engine: "elevenlabs" });
        await processAtlasVoiceTranscript(transcript);
        return;
      } catch (error) {
        if (tag !== instanceTag) return;
        const code = error instanceof SpeechEngineError ? error.code : "unavailable";
        console.info(
          "[atlas-voice] ElevenLabs STT unavailable — using the existing browser recognizer.",
          code,
        );
        setState({ preferredEngine: "browser" });
      }
    }

    // Fallback: hand off to the existing browser recognition path.
    setState({
      status: "error",
      engine: "browser",
      error:
        "I couldn't transcribe that recording. Please try again, or type your question to Atlas.",
    });
  } catch (error) {
    if (tag !== instanceTag) return;
    setState({
      status: "error",
      error:
        error instanceof SpeechEngineError
          ? error.message
          : "I couldn't use that recording. Please try again.",
    });
  }
}

export function cancelAtlasVoiceListening(): void {
  _recorder?.cancel();
  _recorder = null;
  if (_state.status === "listening") setState({ status: "idle" });
}

/** Stop audio immediately (used for interruption). */
export function stopAtlasVoiceSpeaking(): void {
  _ttsAbort?.abort();
  _ttsAbort = null;
  if (_currentAudio) {
    try {
      _currentAudio.pause();
      _currentAudio.currentTime = 0;
    } catch {
      // already stopped
    }
    _currentAudio = null;
  }
  stopBrowserSpeaking();
}

export function setAtlasVoiceAutoSpeak(value: boolean): void {
  if (!value) stopAtlasVoiceSpeaking();
  setState({ autoSpeak: value });
}

export function clearAtlasVoiceError(): void {
  setState({ error: null, status: "idle" });
}
