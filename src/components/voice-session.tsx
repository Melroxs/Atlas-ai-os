import { getSupabaseClient } from "@/lib/supabase";
import {
  currentAtlasVoiceContext,
  executeAtlasVoiceIntent,
} from "@/lib/atlas-voice/session";
import {
  browserSpeechRecognitionSupported,
  browserSpeechSynthesisSupported,
  createSpeechRecognizer,
  createWakeWordEngine,
  playWakeChime,
  requestMicrophonePermission,
  speakText,
  stopBrowserSpeaking,
  type WakeWordEngine,
} from "@/lib/voice";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VoiceStatus =
  | "idle"
  | "unavailable"
  | "permission_required"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "ambient_ready"
  | "listening_for_wake_word"
  | "wake_detected"
  | "listening_for_command"
  | "interrupted"
  | "paused"
  | "error";

export type WakeState =
  | "off"
  | "unavailable"
  | "permission_required"
  | "initializing"
  | "ambient_ready"
  | "listening_for_wake_word"
  | "wake_detected"
  | "listening_for_command"
  | "transcribing"
  | "interrupted"
  | "paused"
  | "error";

export interface ConversationTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  ts: number;
}

export interface VoiceSessionValue {
  // State
  status: VoiceStatus;
  wakeState: WakeState;
  ambientEnabled: boolean;
  ambientSupported: boolean;
  supported: boolean;
  ttsSupported: boolean;
  interim: string;
  error: string | null;
  turns: ConversationTurn[];
  busy: boolean;

  // Controls
  enableAmbient: () => Promise<void>;
  disableAmbient: () => void;
  toggleAmbient: () => void;
  togglePtt: () => void;
  speak: (text: string) => void;
  stopSpeaking: () => void;
  newSession: () => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const VoiceSessionContext = createContext<VoiceSessionValue | null>(null);

export function useVoiceSession(): VoiceSessionValue {
  const ctx = useContext(VoiceSessionContext);
  if (!ctx) {
    // Fallback when provider is not mounted (tests, landing page)
    return {
      status: "idle",
      wakeState: "off",
      ambientEnabled: false,
      ambientSupported: false,
      supported: false,
      ttsSupported: false,
      interim: "",
      error: null,
      turns: [],
      busy: false,
      enableAmbient: async () => {},
      disableAmbient: () => {},
      toggleAmbient: () => {},
      togglePtt: () => {},
      speak: () => {},
      stopSpeaking: () => {},
      newSession: () => {},
    };
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const AMBIENT_KEY = "atlas-ambient";

function storedAmbient(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(AMBIENT_KEY) === "on";
}

export function VoiceSessionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // -- State --
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [wakeState, setWakeState] = useState<WakeState>("off");
  const [ambientEnabled, setAmbientEnabled] = useState<boolean>(storedAmbient);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [busy, setBusy] = useState(false);

  // -- Refs --
  const engineRef = useRef<WakeWordEngine | null>(null);
  const pttRecRef = useRef<ReturnType<typeof createSpeechRecognizer> | null>(
    null,
  );
  const captureBusyRef = useRef(false);
  const ambientRoundTripRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speakTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** True while the engine is recovering from a browser recognition end/error.
   *  The lifecycle effect must not interfere during this window. */
  const recoveringRef = useRef(false);

  const statusRef = useRef(status);
  statusRef.current = status;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const supported = browserSpeechRecognitionSupported();
  const ttsSupported = browserSpeechSynthesisSupported();

  // -- Helpers --
  const clearAmbientTimer = useCallback(() => {
    if (ambientRoundTripRef.current !== null) {
      clearTimeout(ambientRoundTripRef.current);
      ambientRoundTripRef.current = null;
    }
  }, []);

  const finishSpeaking = useCallback(() => {
    setStatus((s) => (s === "speaking" ? "idle" : s));
  }, []);

  const speakTextLocal = useCallback(
    (text: string) => {
      setStatus("speaking");
      speakText(text, {
        onEnd: () => {
          // Transition: speaking → idle. The lifecycle effect will
          // NOT resume the engine here (it only handles paused/interrupted),
          // so we do it explicitly. The engine was set to interruptOnly during
          // speaking; resume() resets mode to wake + interruptOnly to false.
          finishSpeaking();
          captureBusyRef.current = false;
          engineRef.current?.resume();
        },
      });
    },
    [finishSpeaking],
  );

  // -- Send command to AI via Edge Function --
  const sendCommand = useCallback(
    async (text: string) => {
      setBusy(true);
      setStatus("thinking");
      engineRef.current?.pause();
      captureBusyRef.current = true;
      clearAmbientTimer();
      ambientRoundTripRef.current = setTimeout(() => {
        ambientRoundTripRef.current = null;
        captureBusyRef.current = false;
        engineRef.current?.resume();
        setStatus((s) => (s === "thinking" ? "idle" : s));
      }, 15_000);

      // Add user turn
      const userTurn: ConversationTurn = {
        id: `u-${Date.now()}`,
        role: "user",
        text,
        ts: Date.now(),
      };
      setTurns((prev) => [...prev, userTurn]);

      try {
        // 1. Deterministic Atlas layer first: commands like "Atlas, open claims"
        //    or "open the Carter claim" run the SAME intent router and Atlas
        //    tools as the rest of Atlas voice, and navigate the real router.
        //    Everything else (e.g. "what do I have today?") returns null and
        //    falls through to the conversation engine below.
        const toolResult = await executeAtlasVoiceIntent(
          text,
          currentAtlasVoiceContext(),
        );
        if (toolResult) {
          setTurns((prev) => [
            ...prev,
            {
              id: `a-${Date.now()}`,
              role: "assistant",
              text: toolResult.message,
              ts: Date.now(),
            },
          ]);
          clearAmbientTimer();
          captureBusyRef.current = false;
          speakTextLocal(toolResult.message);
          return;
        }

        // 2. Otherwise: the existing Atlas conversation engine.
        const supabase = getSupabaseClient();
        if (!supabase) throw new Error("Supabase not configured");
        const { data, error: fnError } = await supabase.functions.invoke(
          "conversation-converse",
          { body: { transcript: text } },
        );
        if (fnError) throw fnError;
        // The Edge Function returns { data: {...}, error?: string } or the data directly
        const raw = data as Record<string, unknown> | null;
        const payload = (raw && typeof raw === "object" && "data" in raw)
          ? (raw.data as Record<string, unknown> | null)
          : raw;
        if (raw && typeof raw === "object" && typeof raw.error === "string") {
          throw new Error(raw.error);
        }

        const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : undefined;
        if (sessionId) {
          try {
            localStorage.setItem("atlas-conversation-session", sessionId);
          } catch {
            // best-effort
          }
        }

        const answer = (typeof payload?.answer === "string" ? payload.answer : null) ?? "I'm not sure how to respond to that.";
        const spoken = (typeof payload?.spoken === "string" ? payload.spoken : null) || answer;

        setTurns((prev) => [
          ...prev,
          {
            id: `a-${Date.now()}`,
            role: "assistant",
            text: answer,
            ts: Date.now(),
          },
        ]);

        // Speak and return to ambient
        clearAmbientTimer();
        captureBusyRef.current = false;
        // Do NOT call engine.resume() here — the lifecycle effect will
        // handle it once setStatus("thinking" → "idle") triggers a re-render.
        speakTextLocal(spoken);
      } catch (e) {
        clearAmbientTimer();
        captureBusyRef.current = false;
        // Same: let the lifecycle effect resume once status transitions.
        const msg = e instanceof Error ? e.message : "Failed to process command";
        setTurns((prev) => [
          ...prev,
          {
            id: `e-${Date.now()}`,
            role: "assistant",
            text: `I hit a problem: ${msg}`,
            ts: Date.now(),
          },
        ]);
        setStatus("idle");
      } finally {
        setBusy(false);
      }
    },
    [clearAmbientTimer, speakTextLocal],
  );

  // -- Ambient command handler --
  const handleAmbientCommand = useCallback(
    (text: string) => {
      const low = text.toLowerCase();
      const interrupted =
        /^\s*(stop|wait|never mind|nevermind|quiet|cancel that|pause|hold on|be quiet)\b/.test(
          low,
        ) ||
        /\batlas[,.]?\s+(stop|wait|never mind|nevermind|quiet|cancel that|pause|hold on)\b/.test(
          low,
        );
      if (interrupted) {
        stopBrowserSpeaking();
        finishSpeaking();
        setStatus("interrupted");
        setWakeState("interrupted");
        setTimeout(() => {
          setStatus((s) => (s === "interrupted" ? "idle" : s));
          setWakeState((s) =>
            s === "interrupted" ? "listening_for_wake_word" : s,
          );
        }, 1100);
        return;
      }
      setWakeState("transcribing");
      setStatus("transcribing");
      void sendCommand(text.trim());
    },
    [sendCommand, finishSpeaking],
  );

  // -- Enable ambient listening --
  const enableAmbient = useCallback(async () => {
    if (!supported) {
      setWakeState("unavailable");
      setError(
        "Ambient voice needs a browser with speech recognition (Chrome, Edge, Safari).",
      );
      return;
    }
    setWakeState("initializing");
    const ok = await requestMicrophonePermission();
    if (!ok) {
      setWakeState("permission_required");
      setStatus("permission_required");
      setError(
        "Atlas voice requires microphone access. Allow the microphone in your browser and try again.",
      );
      return;
    }
    setError(null);
    setAmbientEnabled(true);
    try {
      localStorage.setItem(AMBIENT_KEY, "on");
    } catch {
      // best-effort
    }

    const engine = createWakeWordEngine({
      onState: (state) => {
        setWakeState(state as WakeState);
        if (state === "listening_for_wake_word") {
          // Engine has successfully restarted — clear recovery guard
          recoveringRef.current = false;
          setStatus("listening_for_wake_word");
          setError(null);
        } else if (state === "wake_detected") {
          recoveringRef.current = false;
          setStatus("wake_detected");
          playWakeChime();
        } else if (state === "listening_for_command") {
          recoveringRef.current = false;
          setStatus("listening_for_command");
        } else if (state === "paused") {
          setStatus("paused");
        } else if (state === "permission_required") {
          recoveringRef.current = false;
          setStatus("permission_required");
          setWakeState("permission_required");
          setError(
            "Microphone access was denied. Allow the microphone in your browser.",
          );
        } else if (state === "error" || state === "unavailable") {
          recoveringRef.current = false;
          setStatus(state === "unavailable" ? "unavailable" : "error");
          setWakeState(state);
        }
      },
      onWake: () => {},
      onCommand: (text) => handleAmbientCommand(text.trim()),
      onInterrupt: () => {
        stopBrowserSpeaking();
        finishSpeaking();
        captureBusyRef.current = false;
        setStatus("interrupted");
        setWakeState("interrupted");
        setTimeout(() => {
          setStatus((s) => (s === "interrupted" ? "idle" : s));
          setWakeState((s) =>
            s === "interrupted" ? "listening_for_wake_word" : s,
          );
        }, 1100);
      },
      onError: (code) => {
        if (code === "unsupported") {
          setWakeState("unavailable");
          setStatus("unavailable");
        } else if (code === "not-allowed" || code === "service-not-allowed") {
          setWakeState("permission_required");
          setStatus("permission_required");
          setError(
            "Microphone access was denied. Allow the microphone in your browser and try again.",
          );
        }
      },
    });
    engineRef.current = engine;
    engine.start();
  }, [supported, handleAmbientCommand, finishSpeaking]);

  // -- Disable ambient listening --
  const disableAmbient = useCallback(() => {
    clearAmbientTimer();
    captureBusyRef.current = false;
    engineRef.current?.stop();
    engineRef.current = null;
    setAmbientEnabled(false);
    setWakeState("off");
    try {
      localStorage.setItem(AMBIENT_KEY, "off");
    } catch {
      // best-effort
    }
    if (statusRef.current !== "speaking") setStatus("idle");
  }, [clearAmbientTimer]);

  // -- Toggle ambient --
  const toggleAmbient = useCallback(() => {
    if (ambientEnabled) {
      disableAmbient();
    } else {
      void enableAmbient();
    }
  }, [ambientEnabled, disableAmbient, enableAmbient]);

  // -- Auto-start ambient if persisted on mount --
  useEffect(() => {
    if (ambientEnabled && !engineRef.current && supported) {
      void enableAmbient();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -- Engine lifecycle effect: the single source of truth for engine state.
  //    • speaking   → interruptOnly (so "Atlas stop" works, but TTS can't wake)
  //    • thinking   → paused (no point listening while the brain is working)
  //    • interrupted → resume after a brief settle (prevents trailing words)
  //    • idle/transcribing/listening → normal wake listening
  // --
  // recoveringRef: when the browser ends recognition naturally (onend fires),
  // the engine schedules its own restart. During that window the lifecycle
  // effect must NOT call pause/resume which would fight with the engine's
  // internal restart logic.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !ambientEnabled) return;

    // --- Guard: engine is recovering from a browser onend / onerror ---
    if (recoveringRef.current) return;

    // --- Speaking: only interruption phrases accepted ---
    if (status === "speaking") {
      engine.setInterruptOnly(true);
      return;
    }
    engine.setInterruptOnly(false);

    // --- Thinking / transcribing: pause (brain is working, no wake needed) ---
    if (status === "thinking" || status === "transcribing") {
      engine.pause();
      return;
    }

    // --- Interrupted: brief settle before resuming (prevents trailing word wake) ---
    if (status === "interrupted") {
      if (captureBusyRef.current) return;
      const t = setTimeout(() => {
        recoveringRef.current = true;
        engineRef.current?.resume();
        // Clear recovering after the engine has had time to restart
        setTimeout(() => { recoveringRef.current = false; }, 600);
      }, 400);
      return () => clearTimeout(t);
    }

    // --- Idle / listening_for_wake_word / wake_detected / listening_for_command ---
    // Normal wake listening. Ensure the engine is running.
    if (!captureBusyRef.current) {
      engine.resume();
    }
  }, [status, ambientEnabled, wakeState]);

  // -- Cleanup on unmount --
  useEffect(() => {
    return () => {
      clearAmbientTimer();
      captureBusyRef.current = false;
      recoveringRef.current = false;
      pttRecRef.current?.abort();
      engineRef.current?.stop();
      stopBrowserSpeaking();
      if (speakTimeoutRef.current !== null) {
        clearTimeout(speakTimeoutRef.current);
      }
    };
  }, [clearAmbientTimer]);

  // -- Push-to-talk toggle --
  const togglePtt = useCallback(() => {
    if (status === "listening" || status === "transcribing") {
      // Stop PTT
      pttRecRef.current?.stop();
      if (pttRecRef.current) {
        pttRecRef.current = null;
        captureBusyRef.current = false;
        engineRef.current?.resume();
        setStatus((s) => (s === "listening" ? "idle" : s));
      }
      return;
    }

    if (!supported) {
      setStatus("unavailable");
      setError(
        "Voice input isn't supported in this browser. You can still type to Atlas.",
      );
      return;
    }

    stopBrowserSpeaking();
    captureBusyRef.current = true;
    engineRef.current?.pause();
    setError(null);
    setInterim("");
    setStatus("listening");

    let segments: string[] = [];
    let delivered = false;

    const endCapture = () => {
      captureBusyRef.current = false;
      engineRef.current?.resume();
    };

    const commit = (via: string) => {
      if (delivered) return;
      delivered = true;
      pttRecRef.current = null;
      endCapture();
      const text = segments.join(" ").trim();
      setInterim("");
      if (text) {
        setStatus("transcribing");
        void sendCommand(text);
      } else {
        setStatus((s) => (s === "listening" ? "idle" : s));
      }
    };

    const rec = createSpeechRecognizer(
      {
        onInterim: (t) => setInterim(t),
        onFinal: (segment) => {
          segments.push(segment);
        },
        onEnd: () => commit("end"),
        onError: (code) => {
          if (
            code === "not-allowed" ||
            code === "service-not-allowed"
          ) {
            pttRecRef.current = null;
            endCapture();
            setStatus("permission_required");
            setError(
              "Microphone access was denied. Allow the microphone in your browser and try again.",
            );
          } else if (code === "no-speech" || code === "aborted") {
            pttRecRef.current = null;
            endCapture();
            setStatus((s) => (s === "listening" ? "idle" : s));
            setError(null);
          } else if (code === "start-failed") {
            pttRecRef.current = null;
            endCapture();
            setStatus("unavailable");
            setError(
              "The microphone couldn't be started. Check your browser's microphone permission.",
            );
          } else {
            const t = segments.join(" ").trim();
            pttRecRef.current = null;
            endCapture();
            if (t) {
              setStatus("transcribing");
              void sendCommand(t);
            } else {
              setStatus("error");
              setError("Speech recognition failed. Please try again.");
            }
          }
        },
      },
      undefined,
      { continuous: false },
    );

    if (rec) {
      pttRecRef.current = rec;
      rec.start();
    } else {
      endCapture();
      setStatus("unavailable");
    }
  }, [supported, sendCommand]);

  // -- Speak (TTS) --
  const speak = useCallback(
    (text: string) => {
      if (!text) return;
      stopBrowserSpeaking();
      captureBusyRef.current = false;
      speakTextLocal(text);
      // The lifecycle effect will set interruptOnly=true once status becomes
      // "speaking". No need to call engine.resume() here — it's already running.
    },
    [speakTextLocal],
  );

  const stopSpeaking = useCallback(() => {
    stopBrowserSpeaking();
    finishSpeaking();
    captureBusyRef.current = false;
    // Lifecycle effect will handle resume once status transitions from
    // "speaking" → "idle".
  }, [finishSpeaking]);

  // -- New session --
  const newSession = useCallback(() => {
    setTurns([]);
    setBusy(false);
    stopBrowserSpeaking();
    finishSpeaking();
    try {
      localStorage.removeItem("atlas-conversation-session");
    } catch {
      // best-effort
    }
  }, [finishSpeaking]);

  const value: VoiceSessionValue = {
    status,
    wakeState,
    ambientEnabled,
    ambientSupported: supported,
    supported,
    ttsSupported,
    interim,
    error,
    turns,
    busy,
    enableAmbient,
    disableAmbient,
    toggleAmbient,
    togglePtt,
    speak,
    stopSpeaking,
    newSession,
  };

  return (
    <VoiceSessionContext.Provider value={value}>
      {children}
    </VoiceSessionContext.Provider>
  );
}
