import { api } from "@/lib/api";
import type { Id } from "@/lib/data-model";
import { KnowledgeBadge, formatDate } from "@/components/atlas-ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useVoice } from "@/hooks/use-voice";
import { useVoiceSession } from "@/components/voice-session";
import { getMicPermissionState } from "@/lib/voice";
import { useAction, useMutation } from "@/hooks/use-supabase";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  Bot,
  Check,
  CircleStop,
  FileText,
  HelpCircle,
  Landmark,
  Loader2,
  MessageSquareText,
  Mic,
  MicOff,
  Plus,
  Radar,
  ScrollText,
  Send,
  ShieldAlert,
  Sparkles,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// Client-side types (mirror of the conversation API surface)
// ---------------------------------------------------------------------------

interface PendingState {
  kind: string;
  message?: string;
  title?: string;
  options?: Array<{ id?: string; label: string }>;
}

interface EntityRef {
  id: string;
  name: string;
  entityTypeKey?: string;
  status?: string;
}

interface SupplementDocumentPayload {
  claimNumber: string | null;
  customer: string | null;
  property: string | null;
  carrier: string | null;
  reason: string;
  status: string;
  requestedAmount?: number;
  sections: Array<{ title: string; body: string[] }>;
  preparedAt: number;
  disclaimer: string;
}

interface AssistantTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  intent?: string;
  kind?: string;
  ts: number;
  spoken?: string;
  pending?: PendingState | null;
  evidence?: Array<Record<string, unknown>>;
  authorityAnswers?: Array<Record<string, unknown>>;
  entityRefs?: EntityRef[];
  suggestedActions?: string[];
  memoryNote?: string;
  limitations?: string;
  supplementDocument?: SupplementDocumentPayload | null;
}

interface ConverseResponse {
  sessionId: string;
  answer: string;
  spoken: string;
  intent: string;
  intentLabel: string;
  confidence: number;
  classification?: string;
  mode?: string;
  limitations?: string;
  suggestedActions: string[];
  questionType?: string;
  authorityAnswers?: Array<Record<string, unknown>>;
  evidence?: Array<Record<string, unknown>>;
  toolPlan?: Record<string, unknown> | null;
  entityRefs?: EntityRef[];
  temporal?: { label?: string };
  pending?: PendingState;
  memoryNote?: string;
  supplementDocument?: SupplementDocumentPayload | null;
  ai?: {
    configured?: boolean;
    provider?: string;
    model?: string | null;
    status?: string;
    lastErrorCode?: string;
    latencyMs?: number;
  };
}

const SESSION_KEY = "atlas-conversation-session";

const INTENT_TONE: Record<string, string> = {
  organizational: "text-cyan-700 dark:text-cyan-200 border-cyan-400/30 bg-cyan-400/10",
  investigative: "text-violet-700 dark:text-violet-200 border-violet-400/30 bg-violet-400/10",
  workflow: "text-amber-700 dark:text-amber-200 border-amber-400/30 bg-amber-400/10",
  action: "text-rose-700 dark:text-rose-200 border-rose-400/30 bg-rose-400/10",
  regulatory: "text-emerald-700 dark:text-emerald-200 border-emerald-400/30 bg-emerald-400/10",
};

function intentChip(intent?: string) {
  if (!intent) return null;
  const tone = INTENT_TONE[intent] ?? "text-muted-foreground border-border/70 bg-muted/30";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tone}`}
    >
      <Sparkles className="size-3" />
      {intent.replace(/_/g, " ")}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AtlasAssistant({
  pageContext,
  entityContextId,
}: {
  pageContext?: string;
  entityContextId?: string;
}) {
  const converse = useAction(api.conversation.converse);
  const deleteSession = useMutation(api.conversation.deleteConversationSession);

  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [voiceIntro, setVoiceIntro] = useState(false);
  const [voiceDiag, setVoiceDiag] = useState(false);
  const [micPermission, setMicPermission] = useState<string>("unknown");
  const [lastAi, setLastAi] = useState<NonNullable<ConverseResponse["ai"]> | null>(null);
  const voiceIntroSeenRef = useRef(
    typeof localStorage !== "undefined" && !!localStorage.getItem("atlas-voice-intro"),
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  const navigate = useNavigate();

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  // Restore the conversation across pages/navigation.
  useEffect(() => {
    const saved = localStorage.getItem(SESSION_KEY);
    if (saved) setSessionId(saved);
  }, []);

  // Phase 12 — “Meet Atlas Voice” onboarding: shown once on first assistant
  // open so microphone use is always explicit and explained. Never silently
  // activates the mic.
  useEffect(() => {
    if (open && !voiceIntroSeenRef.current) {
      const t = setTimeout(() => setVoiceIntro(true), 600);
      return () => clearTimeout(t);
    }
  }, [open]);

  const closeVoiceIntro = () => {
    setVoiceIntro(false);
    voiceIntroSeenRef.current = true;
    try {
      localStorage.setItem("atlas-voice-intro", "1");
    } catch {
      // best-effort
    }
  };

  const voiceSession = useVoiceSession();
  const voice = useVoice({
    onTranscript: (text) => {
      setInput((prev) => (prev ? `${prev} ${text}` : text));
    },
    onAmbientCommand: (text) => void send(text),
  });

  // Sync voice session turns into the assistant's conversation display.
  // The shared session handles ambient commands and PTT via the Edge Function.
  // We mirror its turns into the local state so the panel shows the full
  // conversation regardless of whether the user typed or spoke.
  //
  // IMPORTANT: The voice session already calls speakTextLocal() for voice
  // commands, so we do NOT call voice.speak() here — that would produce
  // double-speech. Auto-speak only applies to typed messages (handled by
  // the send() function below).
  const lastSessionTurnCountRef = useRef(0);
  useEffect(() => {
    const sessionTurns = voiceSession.turns;
    if (sessionTurns.length > lastSessionTurnCountRef.current) {
      const newTurns = sessionTurns.slice(lastSessionTurnCountRef.current);
      lastSessionTurnCountRef.current = sessionTurns.length;
      setTurns((prev) => [
        ...prev,
        ...newTurns.map((t) => ({
          id: t.id,
          role: t.role,
          text: t.text,
          ts: t.ts,
        })),
      ]);
      // Do NOT auto-speak here — the session handles its own TTS.
    }
  }, [voiceSession.turns]);

  useEffect(() => {
    if (open) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [turns, busy, open]);

  // Refresh mic permission state when the diagnostics panel opens.
  useEffect(() => {
    if (!voiceDiag) return;
    void getMicPermissionState().then(setMicPermission);
  }, [voiceDiag, voice.ambientEnabled]);

  const send = async (text?: string) => {
    const q = (text ?? input).trim();
    if (!q || busyRef.current) return;
    setInput("");
    const userTurn: AssistantTurn = {
      id: `u-${Date.now()}`,
      role: "user",
      text: q,
      ts: Date.now(),
    };
    setTurns((t) => [...t, userTurn]);
    setBusy(true);
    voice.stopSpeaking();
    // Structured diagnostics: the converse round-trip is traced in the Voice
    // panel (transcript captured → converse started/completed/failed → TTS).
    // The failure reason is never swallowed — it is shown in the event log,
    // the toast AND the visible error turn.
    voice.pushDiagnostic("converse-start", q.slice(0, 80));
    try {
      const res = (await converse({
        sessionId: (sessionId ?? undefined) as Id<"conversationSessions"> | undefined,
        transcript: q,
        pageContext,
        entityContextId: entityContextId as Id<"entities"> | undefined,
      })) as unknown as ConverseResponse;
      voice.pushDiagnostic("converse-completed", res.intent ?? "answer");
      // AI diagnostics — expose the actual reasoning-engine state (no
      // secrets): model, status, and latency only.
      if (res.ai) {
        setLastAi(res.ai);
        const model = res.ai.model ?? "?";
        if (res.ai.status === "connected") {
          voice.pushDiagnostic(
            "ai-request-completed",
            `gemini:${model} ${res.ai.latencyMs ?? "?"}ms`,
          );
        } else if (res.ai.status === "fallback") {
          voice.pushDiagnostic(
            "ai-fallback",
            `gemini:${model} reason=${res.ai.lastErrorCode ?? "?"}`,
          );
        } else if (res.ai.status === "skipped") {
          voice.pushDiagnostic("ai-skipped", `reason=${res.ai.lastErrorCode ?? "no_evidence"}`);
        }
      }
      setSessionId(res.sessionId);
      localStorage.setItem(SESSION_KEY, res.sessionId);
      setTurns((t) => [
        ...t,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          text: res.answer,
          spoken: res.spoken || res.answer,
          intent: res.intent,
          kind: res.pending?.kind?.startsWith("clarify")
            ? "clarification_request"
            : res.pending?.kind === "confirm_action" || res.pending?.kind === "confirm_workflow"
              ? "confirmation_request"
              : "answer",
          pending: res.pending ?? null,
          evidence: res.evidence,
          authorityAnswers: res.authorityAnswers,
          entityRefs: res.entityRefs,
          suggestedActions: res.suggestedActions,
          memoryNote: res.memoryNote,
          limitations: res.limitations,
          supplementDocument: res.supplementDocument ?? null,
          ts: Date.now(),
        },
      ]);
      if (autoSpeak && (res.spoken || res.answer)) {
        void voice.speak(res.spoken || res.answer);
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      voice.pushDiagnostic("converse-failed", reason.slice(0, 200));
      const short = reason.length > 220 ? `${reason.slice(0, 220)}…` : reason;
      toast.error(short);
      setTurns((t) => [
        ...t,
        {
          id: `e-${Date.now()}`,
          role: "assistant",
          text: `I hit a problem responding to that. ${short}`,
          ts: Date.now(),
        },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const newSession = async () => {
    if (sessionId) {
      await deleteSession({ sessionId: sessionId as Id<"conversationSessions"> }).catch(
        () => undefined,
      );
      localStorage.removeItem(SESSION_KEY);
    }
    setSessionId(null);
    setTurns([]);
    voice.stopSpeaking();
  };

  const voiceLabel = (() => {
    const p = voice.providerStatus;
    if (!p) return "Voice: checking provider…";
    const stt = p.stt === "server" ? `server STT (${p.sttProvider})` : "browser STT";
    const tts = p.tts === "server" ? `server TTS (${p.ttsProvider})` : "browser TTS";
    return `Voice: ${stt} · ${tts}`;
  })();

  const micState = (() => {
    switch (voice.status) {
      case "listening":
      case "transcribing":
        return "listening";
      case "speaking":
        return "speaking";
      case "thinking":
        return "thinking";
      case "error":
      case "unavailable":
        return "error";
      default:
        return "idle";
    }
  })();

  // Phase 11 — ambient status label. Never claims the mic is active when it
  // is not: every label maps to a real state.
  const statusLabel = (() => {
    if (busy) return "Thinking…";
    switch (voice.status) {
      case "listening":
      case "transcribing":
        return "Listening…";
      case "speaking":
        return "Speaking…";
      case "interrupted":
        return "Atlas stopped.";
      case "permission_required":
        return "Microphone permission needed";
      case "listening_for_wake_word":
        return "Say \u201cAtlas\u201d…";
      case "wake_detected":
        return "Yes?";
      case "listening_for_command":
        return "I\u2019m listening…";
      case "paused":
        return "Paused";
      case "error":
        return "Voice error";
      default:
        return "Online";
    }
  })();

  const ambientActive =
    voice.ambientEnabled &&
    ["listening_for_wake_word", "wake_detected", "listening_for_command", "paused", "interrupted"].includes(
      voice.status,
    );

  return (
    <>
      {/* Floating launcher */}
      {!open && (
        <motion.button
          type="button"
          onClick={() => setOpen(true)}
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.4 }}
          className="fixed bottom-5 right-5 z-50 flex h-14 w-14 items-center justify-center rounded-2xl border border-teal-400/30 bg-gradient-to-br from-teal-500/90 to-cyan-600/90 text-white shadow-lg shadow-teal-500/25 transition-transform hover:scale-105 hover:shadow-xl"
          aria-label="Open Atlas assistant"
        >
          <Radar className="size-6" />
          <span className="absolute -right-0.5 -top-0.5 flex size-3">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-teal-400 opacity-60" />
            <span className="relative inline-flex size-3 rounded-full border border-white/60 bg-teal-400" />
          </span>
        </motion.button>
      )}

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, x: 60 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 60 }}
            transition={{ type: "spring", stiffness: 320, damping: 30 }}
            className="fixed bottom-4 right-4 z-50 flex h-[min(720px,calc(100vh-2rem))] w-[min(420px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border/70 bg-background shadow-2xl"
          >
            {/* Header */}
            <div className="flex items-center gap-2 border-b border-border/60 bg-gradient-to-r from-teal-500/10 via-cyan-500/5 to-transparent px-4 py-3">
              <div className="flex size-9 items-center justify-center rounded-xl border border-teal-400/25 bg-teal-400/10 text-teal-600 dark:text-teal-300">
                <Radar className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">Atlas Assistant</p>
                <p className="flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
                  <span
                    className={`inline-block size-1.5 rounded-full ${
                      busy
                        ? "bg-amber-400"
                        : micState === "listening"
                          ? "animate-pulse bg-rose-500"
                          : micState === "speaking"
                            ? "animate-pulse bg-teal-400"
                            : ambientActive
                              ? "animate-pulse bg-emerald-400"
                              : "bg-teal-500"
                    }`}
                  />
                  {statusLabel}
                  {ambientActive && (
                    <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-emerald-600 dark:text-emerald-300">
                      ambient
                    </span>
                  )}
                  <span className="hidden truncate text-muted-foreground/60 sm:inline">
                    · {voiceLabel}
                  </span>
                </p>
              </div>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => void newSession()} title="New conversation">
                <Plus className="size-4" />
              </Button>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setOpen(false)} title="Close">
                <X className="size-4" />
              </Button>
            </div>

            {/* Transcript */}
            <div ref={scrollRef} className="atlas-scroll flex-1 space-y-4 overflow-y-auto p-4">
              {turns.length === 0 && (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                  <div className="flex size-12 items-center justify-center rounded-2xl border border-teal-400/25 bg-teal-400/10 text-teal-600 dark:text-teal-300">
                    <MessageSquareText className="size-6" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold">Talk to Atlas like your ops assistant</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      Try “What's going on?”, “Why hasn't the Johnson project moved?”, or
                      “Start the document review workflow”. Voice works in Chrome, Edge and
                      Safari — or just type.
                    </p>
                  </div>
                  <div className="flex flex-wrap justify-center gap-2">
                    {["What's going on?", "What's waiting on me?", "What changed today?"].map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => void send(s)}
                        className="rounded-lg border border-border/70 bg-muted/30 px-2.5 py-1.5 text-[11px] text-muted-foreground transition-colors hover:border-teal-400/40 hover:text-teal-700 dark:hover:text-teal-200"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {turns.map((t) =>
                t.role === "user" ? (
                  <div key={t.id} className="flex justify-end gap-2">
                    <div className="max-w-[85%] rounded-2xl rounded-tr-sm border border-teal-400/25 bg-teal-400/10 px-3.5 py-2 text-sm leading-6 text-teal-800 dark:text-teal-50">
                      {t.text}
                    </div>
                  </div>
                ) : (
                  <div key={t.id} className="flex gap-2">
                    <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-teal-400/15 text-teal-600 ring-1 ring-teal-400/25 dark:text-teal-300">
                      <Bot className="size-3.5" />
                    </div>
                    <div className="min-w-0 max-w-[88%] flex-1">
                      <div className="mb-1 flex flex-wrap items-center gap-1.5">
                        {intentChip(t.intent)}
                        <span className="font-mono text-[10px] text-muted-foreground/60">
                          {formatDate(t.ts)}
                        </span>
                      </div>
                      <div className="rounded-2xl rounded-tl-sm border border-border/70 bg-card px-3.5 py-2.5 text-sm leading-6 text-foreground">
                        <p className="whitespace-pre-wrap">{t.text}</p>

                        {t.memoryNote && (
                          <p className="mt-2.5 rounded-lg border border-amber-400/25 bg-amber-400/5 px-2.5 py-1.5 text-[11px] leading-5 text-amber-700 dark:text-amber-200">
                            <ShieldAlert className="mr-1 inline size-3 -translate-y-px" />
                            {t.memoryNote}
                          </p>
                        )}

                        {t.limitations && (
                          <p className="mt-2 text-[11px] italic text-muted-foreground">
                            ⚠ {t.limitations}
                          </p>
                        )}

                        {/* Phase 12 — inline structured supplement document */}
                        {t.supplementDocument && (
                          <div className="mt-3 overflow-hidden rounded-xl border border-teal-400/25 bg-teal-400/5">
                            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-teal-400/20 bg-teal-400/10 px-3 py-2">
                              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-teal-700 dark:text-teal-200">
                                <ScrollText className="size-3" />
                                Supplement document · draft for review
                              </p>
                              <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide text-amber-600 dark:text-amber-300">
                                {(t.supplementDocument.status ?? "draft").replace(/_/g, " ")}
                              </span>
                            </div>
                            <div className="space-y-2 p-3">
                              {typeof t.supplementDocument.requestedAmount === "number" && (
                                <p className="text-[11px] font-medium text-emerald-600 dark:text-emerald-300">
                                  Requested ${t.supplementDocument.requestedAmount.toLocaleString()}
                                </p>
                              )}
                              {t.supplementDocument.sections.map((s) => (
                                <div key={s.title}>
                                  <p className="text-[11px] font-semibold text-foreground">{s.title}</p>
                                  <div className="mt-0.5 space-y-0.5">
                                    {s.body.map((line, i) => (
                                      <p key={i} className="text-[11px] leading-4 text-muted-foreground">
                                        {line}
                                      </p>
                                    ))}
                                  </div>
                                </div>
                              ))}
                              <p className="rounded-lg border border-amber-400/25 bg-amber-400/5 px-2 py-1.5 text-[10px] italic leading-4 text-amber-700 dark:text-amber-200">
                                {t.supplementDocument.disclaimer}
                              </p>
                            </div>
                          </div>
                        )}

                        {t.entityRefs && t.entityRefs.length > 0 && (
                          <div className="mt-2.5 flex flex-wrap gap-1.5">
                            {t.entityRefs.map((e) => {
                              const isClaim = /claim/.test(e.entityTypeKey ?? "");
                              return isClaim ? (
                                <button
                                  key={e.id}
                                  type="button"
                                  onClick={() => navigate(`/dashboard/revenue-recovery/${e.id}`)}
                                  title="Open claim"
                                  className="rounded-md border border-amber-400/30 bg-amber-400/5 px-2 py-0.5 text-[11px] text-amber-700 transition-colors hover:border-amber-400/60 hover:bg-amber-400/10 dark:text-amber-200"
                                >
                                  {e.name} →
                                </button>
                              ) : (
                                <span
                                  key={e.id}
                                  className="rounded-md border border-cyan-400/25 bg-cyan-400/5 px-2 py-0.5 text-[11px] text-cyan-700 dark:text-cyan-200"
                                >
                                  {e.name}
                                </span>
                              );
                            })}
                          </div>
                        )}

                        {/* Confirmation */}
                        {t.pending?.kind === "confirm_action" ||
                        t.pending?.kind === "confirm_workflow" ? (
                          <div className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/5 p-3">
                            <p className="text-[11px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-300">
                              Awaiting your confirmation
                            </p>
                            {t.pending.message && (
                              <p className="mt-1 text-xs leading-5 text-foreground">
                                {t.pending.message}
                              </p>
                            )}
                            <div className="mt-2.5 flex gap-2">
                              <Button
                                size="sm"
                                className="h-8 gap-1.5 text-xs"
                                onClick={() => void send("yes, proceed")}
                              >
                                <Check className="size-3.5" />
                                Proceed
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 gap-1.5 text-xs"
                                onClick={() => void send("no, cancel")}
                              >
                                <CircleStop className="size-3.5" />
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : null}

                        {/* Clarification */}
                        {t.pending?.kind === "clarify_entity" ||
                        t.pending?.kind === "clarify_general" ? (
                          <div className="mt-3 rounded-xl border border-violet-400/25 bg-violet-400/5 p-3">
                            <p className="text-[11px] font-medium uppercase tracking-wide text-violet-600 dark:text-violet-300">
                              Which one do you mean?
                            </p>
                            {(t.pending?.options ?? []).length > 0 ? (
                              <div className="mt-2 flex flex-col gap-1.5">
                                {(t.pending?.options ?? []).map((o, i) => (
                                  <button
                                    key={o.id ?? o.label}
                                    type="button"
                                    onClick={() => void send(`the ${i + 1 === 1 ? "first" : i + 1 === 2 ? "second" : i + 1 === 3 ? "third" : `${i + 1}th`} one`)}
                                    className="rounded-lg border border-border/70 bg-muted/30 px-2.5 py-1.5 text-left text-xs text-foreground transition-colors hover:border-violet-400/40"
                                  >
                                    <span className="mr-1.5 font-mono text-[10px] text-muted-foreground">
                                      {i + 1}.
                                    </span>
                                    {o.label}
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                {t.pending?.message ?? "Could you rephrase that?"}
                              </p>
                            )}
                          </div>
                        ) : null}

                        {/* Suggested actions */}
                        {t.suggestedActions && t.suggestedActions.length > 0 && (
                          <div className="mt-2.5 flex flex-wrap gap-1.5">
                            {t.suggestedActions.map((a) => (
                              <span
                                key={a}
                                className="rounded-md border border-amber-400/25 bg-amber-400/5 px-2 py-0.5 text-[11px] text-amber-700 dark:text-amber-200"
                              >
                                {a}
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Authority answers */}
                        {t.authorityAnswers && t.authorityAnswers.length > 0 && (
                          <div className="mt-2.5 space-y-1.5">
                            <p className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                              <Landmark className="size-3" />
                              Authoritative sources
                            </p>
                            {t.authorityAnswers.slice(0, 2).map((a, i) => (
                              <details
                                key={i}
                                className="rounded-lg border border-emerald-400/20 bg-emerald-400/5"
                              >
                                <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 text-[11px]">
                                  <FileText className="size-3 shrink-0 text-emerald-600 dark:text-emerald-300" />
                                  <span className="truncate font-medium">
                                    {String(a.source ?? a.organization ?? "Source")}
                                  </span>
                                </summary>
                                <p className="px-2.5 pb-2 text-[11px] leading-5 text-muted-foreground">
                                  {String(a.sourceFact ?? "")}
                                </p>
                              </details>
                            ))}
                            <p className="text-[10px] italic text-muted-foreground">
                              This is not legal advice.
                            </p>
                          </div>
                        )}
                      </div>

                      {/* Evidence */}
                      {t.evidence && t.evidence.length > 0 && (
                        <div className="mt-1.5 space-y-1">
                          {t.evidence.slice(0, 4).map((e, i) => (
                            <details
                              key={`${t.id}-e${i}`}
                              className="rounded-lg border border-border/60 bg-muted/20"
                            >
                              <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-[11px]">
                                <FileText className="size-3 shrink-0 text-teal-600 dark:text-teal-300" />
                                <span className="truncate font-medium">
                                  {String(e.documentTitle ?? e.title ?? e.kind ?? "Evidence")}
                                </span>
                                {e.evidenceType ? (
                                  <KnowledgeBadge classification={String(e.evidenceType)} />
                                ) : null}
                              </summary>
                              {e.snippet ? (
                                <p className="px-2.5 pb-2 text-[11px] leading-5 text-muted-foreground">
                                  {String(e.snippet)}
                                </p>
                              ) : null}
                            </details>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ),
              )}

              {busy && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <div className="flex size-7 items-center justify-center rounded-full bg-teal-400/15 text-teal-600 ring-1 ring-teal-400/25 dark:text-teal-300">
                    <Bot className="size-3.5" />
                  </div>
                  <div className="flex items-center gap-2 rounded-2xl rounded-tl-sm border border-border/70 bg-card px-3.5 py-2.5">
                    <Loader2 className="size-4 animate-spin text-teal-600 dark:text-teal-300" />
                    <span className="flex gap-1">
                      {[0, 1, 2].map((i) => (
                        <span
                          key={i}
                          className="size-1.5 animate-bounce rounded-full bg-teal-500/70"
                          style={{ animationDelay: `${i * 140}ms` }}
                        />
                      ))}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Input */}
            <div className="border-t border-border/60 p-3">
              {voice.interim && micState === "listening" && (
                <p className="mb-1.5 px-1 text-[11px] italic text-muted-foreground">
                  “{voice.interim}”
                </p>
              )}
              {voice.error && (
                <p className="mb-1.5 rounded-lg border border-rose-400/25 bg-rose-400/5 px-2.5 py-1.5 text-[11px] text-rose-700 dark:text-rose-200">
                  {voice.error}
                </p>
              )}
              <div className="flex items-end gap-2">
                <button
                  type="button"
                  onClick={() => voice.toggle()}
                  title={micState === "listening" ? "Stop listening" : "Press to talk"}
                  className={`flex size-10 shrink-0 items-center justify-center rounded-xl border transition-colors ${
                    micState === "listening"
                      ? "animate-pulse border-rose-400/40 bg-rose-500 text-white"
                      : micState === "speaking"
                        ? "border-teal-400/40 bg-teal-400/15 text-teal-600 dark:text-teal-300"
                        : voice.supported
                          ? "border-border/70 bg-muted/40 text-muted-foreground hover:border-teal-400/40 hover:text-teal-600 dark:hover:text-teal-300"
                          : "border-border/50 bg-muted/20 text-muted-foreground/50"
                  }`}
                >
                  {micState === "listening" ? <MicOff className="size-4" /> : <Mic className="size-4" />}
                </button>
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  rows={1}
                  placeholder="Talk or type to Atlas…"
                  className="max-h-28 min-h-10 flex-1 resize-none rounded-xl border border-border/70 bg-card/70 px-3 py-2.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-teal-400/50 focus:ring-2 focus:ring-teal-400/20"
                />
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={busy || !input.trim()}
                  className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-teal-400 text-teal-950 transition-colors hover:bg-teal-300 disabled:opacity-40"
                >
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                </button>
              </div>
              <div className="mt-2 flex items-center justify-between px-1">
                <button
                  type="button"
                  onClick={() => {
                    setAutoSpeak((v) => !v);
                    if (autoSpeak) voice.stopSpeaking();
                  }}
                  className={`flex items-center gap-1.5 text-[11px] transition-colors ${
                    autoSpeak ? "text-teal-600 dark:text-teal-300" : "text-muted-foreground/60"
                  }`}
                >
                  {autoSpeak ? <Volume2 className="size-3" /> : <VolumeX className="size-3" />}
                  {autoSpeak ? "Auto-speak on" : "Auto-speak off"}
                </button>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setVoiceIntro(true)}
                    title="Meet Atlas Voice — how listening works"
                    className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60 transition-colors hover:text-teal-600 dark:hover:text-teal-300"
                  >
                    <HelpCircle className="size-3" />
                    Voice
                  </button>
                  {/* Phase 12 — developer-visible voice diagnostics (Part 10). */}
                  <button
                    type="button"
                    onClick={() => setVoiceDiag(true)}
                    title="Voice diagnostics"
                    className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60 transition-colors hover:text-teal-600 dark:hover:text-teal-300"
                  >
                    <Activity className="size-3" />
                    Diag
                  </button>
                  {/* Phase 11 — ambient mode toggle: “Say Atlas and Atlas is ready.” */}
                  <button
                    type="button"
                    onClick={() => voice.toggleAmbient()}
                    title={
                      voice.ambientEnabled
                        ? "Disable ambient listening"
                        : "Enable ambient listening (mic access required)"
                    }
                    className={`flex items-center gap-1.5 text-[11px] transition-colors ${
                      voice.ambientEnabled
                        ? "text-emerald-600 dark:text-emerald-300"
                        : "text-muted-foreground/60"
                    }`}
                  >
                    <Radar className="size-3" />
                    {voice.ambientEnabled ? "Ambient on" : "Ambient off"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void voice.speak(turns[turns.length - 1]?.spoken ?? "")}
                    disabled={turns.length === 0}
                    className="text-[11px] text-muted-foreground/60 transition-colors hover:text-teal-600 dark:hover:text-teal-300 disabled:opacity-40"
                  >
                    Replay last response
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Phase 12 — “Meet Atlas Voice” onboarding: explicit, honest mic UX. */}
      <Dialog open={voiceIntro} onOpenChange={(o) => !o && closeVoiceIntro()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Radar className="size-4 text-teal-600 dark:text-teal-300" />
              Meet Atlas Voice
            </DialogTitle>
            <DialogDescription>
              Atlas can listen for the wake word “Atlas” and take spoken commands — but only
              when you enable it, and only in this browser.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1 text-[12px] leading-5">
            <div className="flex gap-2.5">
              <Mic className="mt-0.5 size-4 shrink-0 text-teal-600 dark:text-teal-300" />
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">What the microphone is used for</span> —
                recognizing the wake word and your commands. Audio is processed by your browser's
                speech recognition; raw audio is not uploaded to Atlas.
              </p>
            </div>
            <div className="flex gap-2.5">
              <Radar className="mt-0.5 size-4 shrink-0 text-teal-600 dark:text-teal-300" />
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">When Atlas listens</span> — only when
                ambient listening is enabled. The status pill above always shows the live state
                (listening, thinking, speaking).
              </p>
            </div>
            <div className="flex gap-2.5">
              <Sparkles className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-300" />
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">How the wake word works</span> — say
                “Atlas”, wait for the chime, then give your command. Duplicate triggers are
                suppressed, and Atlas never wakes itself while speaking.
              </p>
            </div>
            <div className="flex gap-2.5">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-300" />
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">Privacy</span> — voice commands go
                through the same conversation engine, permissions and audit as typed messages.
                No microphone data is sent to Atlas servers.
              </p>
            </div>
            <div className="flex gap-2.5">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-300" />
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">Browser limits</span> — ambient
                listening works while this app is open in the active tab. Browsers do not guarantee
                true background listening, so Atlas never claims otherwise.
              </p>
            </div>
            <div className="flex gap-2.5">
              <CircleStop className="mt-0.5 size-4 shrink-0 text-rose-600 dark:text-rose-300" />
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">How to disable</span> — switch
                “Ambient” off in the assistant footer, or revoke microphone permission in your
                browser at any time.
              </p>
            </div>
          </div>
          <DialogFooter className="flex-wrap gap-2 sm:justify-between">
            <Button variant="outline" size="sm" onClick={closeVoiceIntro}>
              Later
            </Button>
            <Button
              size="sm"
              onClick={() => {
                closeVoiceIntro();
                if (!voice.ambientEnabled) void voice.enableAmbient();
              }}
            >
              <Mic className="mr-1.5 size-3.5" />
              Enable ambient listening
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Phase 12 — Voice diagnostics (Part 10). Developer-visible, no secrets: */}
      {/* capability flags, provider status, engine state, and a live event log. */}
      <Dialog open={voiceDiag} onOpenChange={(o) => !o && setVoiceDiag(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Activity className="size-4 text-teal-600 dark:text-teal-300" />
              Voice diagnostics
            </DialogTitle>
            <DialogDescription>
              Real-time voice runtime state. No secrets are shown — only capability
              flags, provider status and the state machine log.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2.5 py-1 text-[12px] leading-5">
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-border/70 bg-muted/30 px-2.5 py-2">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Speech recognition
                </p>
                <p className="mt-0.5 font-medium">{voice.supported ? "Browser (Web Speech)" : "Unavailable"}</p>
              </div>
              <div className="rounded-lg border border-border/70 bg-muted/30 px-2.5 py-2">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Speech synthesis
                </p>
                <p className="mt-0.5 font-medium">
                  {voiceSession.speechEngine === "elevenlabs"
                    ? "ElevenLabs"
                    : voiceSession.speechEngine === "browser"
                      ? "Browser (Web Speech)"
                      : voice.ttsSupported
                        ? "Not used yet · Browser available"
                        : "Unavailable"}
                </p>
              </div>
              <div className="rounded-lg border border-border/70 bg-muted/30 px-2.5 py-2">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Mic permission
                </p>
                <p className="mt-0.5 font-medium">{micPermission}</p>
              </div>
              <div className="rounded-lg border border-border/70 bg-muted/30 px-2.5 py-2">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Engine state
                </p>
                <p className="mt-0.5 font-medium">
                  {voice.wakeState !== "off" ? voice.wakeState : voice.status}
                </p>
              </div>
            </div>
            {voice.providerStatus && (
              <p className="rounded-lg border border-border/70 bg-muted/30 px-2.5 py-2 text-[11px] text-muted-foreground">
                STT: <span className="font-medium text-foreground">{voice.providerStatus.stt === "server" ? `server (${voice.providerStatus.sttProvider ?? "?"})` : "browser"}</span>
                {" · "}
                TTS: <span className="font-medium text-foreground">{voice.providerStatus.tts === "server" ? `server (${voice.providerStatus.ttsProvider ?? "?"})` : "browser"}</span>
                {" · "}server credentials:{" "}
                <span className="font-medium text-foreground">
                  {voice.providerStatus.serverConfigured ? "configured" : "not configured (browser fallback)"}
                </span>
              </p>
            )}
            <div className="rounded-lg border border-border/70 bg-muted/30 px-2.5 py-2">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                AI reasoning
              </p>
              {!lastAi ? (
                <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                  Ask a question to check the reasoning engine.
                </p>
              ) : (
                <p className="mt-0.5 text-[11px]">
                  {lastAi.configured ? (
                    <>
                      Provider: <span className="font-medium text-foreground">{lastAi.provider === "gemini" ? "Gemini" : lastAi.provider}</span>
                      {lastAi.model ? ` · Model: ${lastAi.model}` : ""}
                      {" · "}
                      <span className="font-medium text-foreground">
                        {lastAi.status === "connected"
                          ? "Connected"
                          : lastAi.status === "fallback"
                            ? `Fallback (${lastAi.lastErrorCode ?? "?"})`
                            : lastAi.status}
                      </span>
                    </>
                  ) : (
                    <>
                      Provider: <span className="font-medium text-foreground">None</span> —
                      <span className="text-muted-foreground"> evidence retrieval</span>
                    </>
                  )}
                </p>
              )}
            </div>
            <div className="rounded-lg border border-border/70 bg-muted/30 px-2.5 py-2">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Event log
              </p>
              {voice.voiceEvents.length === 0 ? (
                <p className="mt-1 text-[11px] text-muted-foreground/70">No voice activity yet.</p>
              ) : (
                <div className="mt-1.5 max-h-40 space-y-1 overflow-y-auto font-mono text-[10px] leading-4">
                  {voice.voiceEvents.slice(-16).reverse().map((e, i) => (
                    <p key={`${e.ts}-${i}"`} className="flex gap-1.5 text-muted-foreground">
                      <span className="shrink-0 text-muted-foreground/50">
                        {new Date(e.ts).toLocaleTimeString()}
                      </span>
                      <span className="min-w-0 truncate">
                        {e.event}
                        {e.detail ? ` · ${e.detail}` : ""}
                      </span>
                    </p>
                  ))}
                </div>
              )}
            </div>
            <p className="text-[10px] italic leading-4 text-muted-foreground/70">
              Ambient voice only listens after you enable it, and no audio is uploaded to Atlas
              before the wake word is heard. Interruptions are recognized as “Atlas stop” while speaking.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
