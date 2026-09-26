// ---------------------------------------------------------------------------
// AtlasVoiceControl — the Atlas voice interface.
//
// Uses the EXISTING Atlas visual language (the same Tailwind tokens, teal
// accent and pill styling as the app shell) rather than dropping in an
// unstyled third-party widget. Compact and non-intrusive: a small floating
// control, plus an expandable panel that shows what Atlas heard and said.
//
// It is reusable by design — the same component can be mounted globally and
// (with `variant="contextual"`) inline on a claim/evidence/workforce area,
// because all of them drive the one centralized voice session.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, Mic, Square, Volume2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAtlasVoice } from "@/hooks/use-atlas-voice";

export interface AtlasVoiceControlProps {
  /** "global" floats bottom-right; "contextual" renders inline. */
  variant?: "global" | "contextual";
  /** Optional hint about what the voice session can see (e.g. a claim). */
  contextHint?: string;
}

export function AtlasVoiceControl({
  variant = "global",
  contextHint,
}: AtlasVoiceControlProps) {
  const voice = useAtlasVoice();
  const [expanded, setExpanded] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Escape interrupts Atlas or cancels a recording — the keyboard equivalent
  // of saying "Atlas, stop".
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (voice.status === "listening") voice.cancel();
      else if (voice.status === "speaking") voice.interrupt();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [voice]);

  // Keep the panel scrolled to the newest turn.
  useEffect(() => {
    if (expanded && panelRef.current) {
      panelRef.current.scrollTop = panelRef.current.scrollHeight;
    }
  }, [expanded, voice.response, voice.transcript]);

  const isListening = voice.status === "listening";
  const isWorking =
    voice.status === "processing" ||
    voice.status === "executing" ||
    voice.status === "speaking";

  const label = (() => {
    switch (voice.status) {
      case "listening":
        return "Listening…";
      case "processing":
        return "Thinking…";
      case "executing":
        return voice.toolLabel ?? "Working…";
      case "speaking":
        return "Speaking…";
      case "interrupted":
        return "Stopped";
      case "error":
        return "Voice error";
      default:
        return "Ask Atlas";
    }
  })();

  const interactive = variant === "contextual" || expanded || voice.busy;

  return (
    <div
      className={cn(
        variant === "global" &&
          "fixed bottom-6 right-6 z-50 flex flex-col items-end gap-2",
        variant === "contextual" && "flex flex-col items-stretch gap-2",
      )}
    >
      {expanded && (
        <div
          ref={panelRef}
          className="w-80 max-w-[calc(100vw-3rem)] max-h-80 overflow-y-auto rounded-xl border border-border/60 bg-card/95 p-4 shadow-lg backdrop-blur"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Atlas Voice
            </p>
            <button
              type="button"
              onClick={() => {
                setExpanded(false);
                voice.cancel();
              }}
              className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
              aria-label="Close Atlas Voice"
            >
              <X className="size-3.5" />
            </button>
          </div>

          {contextHint && (
            <p className="mt-2 text-xs text-muted-foreground">Context: {contextHint}</p>
          )}

          {voice.transcript && (
            <div className="mt-3">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">You</p>
              <p className="mt-0.5 text-sm text-foreground">{voice.transcript}</p>
            </div>
          )}

          {voice.response && (
            <div className="mt-3">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Atlas</p>
              <p className="mt-0.5 text-sm leading-relaxed text-foreground">{voice.response}</p>
            </div>
          )}

          {voice.error && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-rose-500 dark:text-rose-300" />
              <p className="text-xs text-rose-600 dark:text-rose-300">{voice.error}</p>
            </div>
          )}

          {!voice.transcript && !voice.response && !voice.error && (
            <p className="mt-3 text-sm text-muted-foreground">
              Ask Atlas a question, or say “open the Carter claim”.
            </p>
          )}

          <div className="mt-4 flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">
              Engine:{" "}
              {voice.engine === "elevenlabs"
                ? "ElevenLabs"
                : voice.engine === "browser"
                  ? "Browser"
                  : "Not used yet"}
            </p>
            <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                checked={voice.autoSpeak}
                onChange={(event) => voice.setAutoSpeak(event.target.checked)}
                className="size-3 accent-teal-500"
              />
              Speak replies
            </label>
          </div>
        </div>
      )}

      {interactive && (
        <div
          className={cn(
            "flex items-center gap-2 rounded-full border border-border/60 bg-card/95 px-3 py-2 shadow-lg backdrop-blur",
            variant === "contextual" && "w-full justify-between",
          )}
        >
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              voice.status === "listening" && "animate-pulse bg-rose-400",
              voice.status === "processing" && "animate-pulse bg-amber-400",
              voice.status === "executing" && "animate-pulse bg-teal-400",
              voice.status === "speaking" && "animate-pulse bg-teal-400",
              voice.status === "interrupted" && "bg-slate-400",
              voice.status === "error" && "bg-rose-500",
              voice.status === "idle" && "bg-emerald-400",
            )}
          />
          <span className="whitespace-nowrap text-xs font-medium text-foreground">
            {label}
          </span>

          {isListening ? (
            <button
              type="button"
              onClick={() => void voice.stop()}
              className="rounded-full bg-rose-500/90 p-1.5 text-white transition-colors hover:bg-rose-500"
              aria-label="Stop listening"
            >
              <Square className="size-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                if (voice.status === "speaking") voice.interrupt();
                void voice.toggle();
              }}
              disabled={voice.status === "processing" || voice.status === "executing"}
              className="rounded-full bg-teal-500/90 p-1.5 text-white transition-colors hover:bg-teal-500 disabled:opacity-50"
              aria-label={isWorking ? "Interrupt Atlas" : "Talk to Atlas"}
            >
              {isWorking ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Mic className="size-3.5" />
              )}
            </button>
          )}
        </div>
      )}

      {variant === "global" && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className={cn(
            "inline-flex items-center gap-2 rounded-full border border-border/60 bg-card/95 px-4 py-2.5 text-sm font-medium shadow-lg backdrop-blur transition-colors hover:border-teal-400/40 hover:text-foreground",
            expanded ? "text-foreground" : "text-muted-foreground",
          )}
          aria-label="Open Atlas Voice"
        >
          {voice.status === "speaking" ? (
            <Volume2 className="size-4 text-teal-500" />
          ) : (
            <Mic className="size-4 text-teal-500" />
          )}
          Atlas Voice
        </button>
      )}
    </div>
  );
}

export default AtlasVoiceControl;
