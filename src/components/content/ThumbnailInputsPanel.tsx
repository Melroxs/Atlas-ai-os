// ---------------------------------------------------------------------------
// Atlas Content Studio — compositor thumbnail INPUTS panel.
//
// WHAT THIS PANEL IS FOR
// ----------------------
// The deterministic compositor needs two approved inputs before it can render
// anything: an approved background PNG and approved, ordered overlay copy. This
// panel is how a human supplies and approves them.
//
// WHAT IT DELIBERATELY DOES NOT DO
// --------------------------------
//   * it does not render a thumbnail. Composing is a separate, explicit job;
//   * it does not touch this package's canonical thumbnail. The background is
//     stored in its own content type, so it can never become an upsert target
//     for the `youtube_thumbnail` asset — an operator's uploaded artwork is not
//     replaceable from here;
//   * it does not publish anything;
//   * it does not invent copy. The overlay lines are whatever the operator
//     types. Nothing on this screen derives text from the title, the article
//     body, the image prompt or any brand setting.
//
// APPROVAL IS NOT REINVENTED
// --------------------------
// Both inputs are written in `drafted` / `pending` and are shown with their
// approval state. Approval happens through the EXISTING admin review action
// (`content_review_decide`), which this panel does not duplicate or bypass: a
// pending input is simply not renderable, and the worker enforces that.
// ---------------------------------------------------------------------------

import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Image as ImageIcon, Loader2, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/atlas-ui";
import {
  MAX_OVERLAY_LINES,
  MAX_OVERLAY_LINE_CHARS,
  THUMBNAIL_INPUT_CONTENT_TYPES,
  THUMBNAIL_OVERLAY_LINES_KEY,
  type ContentAssetRecord,
  type ContentPackageView,
} from "@/lib/content-engine/types";
import {
  ACCEPTED_BACKGROUND_TYPES,
  MAX_THUMBNAIL_BYTES,
  acceptAttribute,
  formatMediaBytes,
} from "@/lib/content-engine/media-upload";

export interface ThumbnailInputsPanelProps {
  view: ContentPackageView;
  /** Uploads a background PNG. Resolves to the updated asset. */
  onUploadBackground: (file: File) => Promise<void>;
  /** Persists the ordered overlay lines. */
  onSaveOverlay: (lines: string[]) => Promise<void>;
  /** Runs the existing admin review action against an input asset id. */
  onApprove: (assetId: string) => Promise<void>;
  disabled?: boolean;
  busy?: string | null;
}

function inputAsset(view: ContentPackageView, contentType: string): ContentAssetRecord | null {
  return view.assets.find((a) => a.contentType === contentType) ?? null;
}

function approvalBadge(asset: ContentAssetRecord | null) {
  if (!asset) return <Badge variant="outline">Not provided</Badge>;
  if (asset.approvalStatus === "approved") {
    return (
      <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="mr-1 size-3.5" /> Approved
      </Badge>
    );
  }
  return (
    <Badge variant="secondary">
      <AlertTriangle className="mr-1 size-3.5" />
      {asset.approvalStatus === "needs_changes" ? "Changes requested" : "Awaiting approval"}
    </Badge>
  );
}

/** The approved copy, or an empty array. Never derived from anything. */
function overlayLinesOf(asset: ContentAssetRecord | null): string[] {
  const raw = (asset?.metadata as Record<string, unknown> | null)?.[THUMBNAIL_OVERLAY_LINES_KEY];
  return Array.isArray(raw) ? raw.filter((line): line is string => typeof line === "string") : [];
}

export default function ThumbnailInputsPanel({
  view,
  onUploadBackground,
  onSaveOverlay,
  onApprove,
  disabled = false,
  busy = null,
}: ThumbnailInputsPanelProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const background = inputAsset(view, THUMBNAIL_INPUT_CONTENT_TYPES.background);
  const overlay = inputAsset(view, THUMBNAIL_INPUT_CONTENT_TYPES.overlay);
  const savedLines = overlayLinesOf(overlay);
  const [lines, setLines] = useState<string[]>(savedLines);
  const [error, setError] = useState<string | null>(null);

  // Adopt the server's copy whenever it changes, so a saved edit is not undone
  // by a stale local edit box.
  const serverKey = savedLines.join("\n");
  const [lastServerKey, setLastServerKey] = useState(serverKey);
  if (serverKey !== lastServerKey) {
    setLastServerKey(serverKey);
    setLines(savedLines);
  }

  const setLine = (index: number, value: string) => {
    setError(null);
    setLines((current) => current.map((line, i) => (i === index ? value : line)));
  };

  const saveOverlay = async () => {
    setError(null);
    const trimmed = lines.map((line) => line.trim()).filter((line) => line.length > 0);
    if (trimmed.length === 0) {
      setError("Enter at least one overlay line.");
      return;
    }
    try {
      await onSaveOverlay(trimmed);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The overlay could not be saved.");
    }
  };

  const uploadBackground = async (file: File) => {
    setError(null);
    try {
      await onUploadBackground(file);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The background could not be uploaded.");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <>
      <Panel
        title="Thumbnail background"
        description="The image the deterministic compositor draws the approved overlay text onto. PNG only, up to 2 MB. This is an input, not a thumbnail: it never replaces this package's thumbnail."
      >
        <div className="mb-3 flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept={acceptAttribute("background")}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void uploadBackground(file);
            }}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => fileRef.current?.click()}
          >
            {busy === "upload-background" ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <ImageIcon className="mr-2 size-4" />
            )}
            {background ? "Replace background" : "Upload background"}
          </Button>
          {approvalBadge(background)}
          {background?.approvalStatus === "approved" && (
            <span className="text-xs text-muted-foreground">
              Ready for the compositor. Limit {formatMediaBytes(MAX_THUMBNAIL_BYTES)}, format{" "}
              {ACCEPTED_BACKGROUND_TYPES.map((t) => t.label).join(", ")}.
            </span>
          )}
        </div>

        {background ? (
          <div className="space-y-1 text-sm text-muted-foreground">
            <div>
              Stored at{" "}
              <code className="text-xs">{background.storagePath ?? "(no stored image)"}</code>
            </div>
            {typeof background.metadata?.byteSize === "number" && (
              <div>Size {formatMediaBytes(background.metadata.byteSize as number)}</div>
            )}
            {background.approvalStatus !== "approved" && (
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => void onApprove(background._id)}
              >
                Approve background
              </Button>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No background provided yet. Atlas will not compose a thumbnail without an approved
            background and approved overlay copy.
          </p>
        )}
      </Panel>

      <Panel
        title="Thumbnail overlay copy"
        description={`The exact text drawn on the background, in order. Up to ${MAX_OVERLAY_LINES} lines of ${MAX_OVERLAY_LINE_CHARS} characters. Atlas never rewrites or generates this copy.`}
      >
        <div className="space-y-2">
          {lines.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No overlay copy yet. Write the approved lines yourself — nothing here is derived from
              the article or generated for you.
            </p>
          )}
          {lines.map((line, index) => (
            <div key={index} className="flex items-center gap-2">
              <Type className="size-4 shrink-0 text-muted-foreground" />
              <input
                value={line}
                maxLength={MAX_OVERLAY_LINE_CHARS}
                onChange={(e) => setLine(index, e.target.value)}
                placeholder={`Line ${index + 1}`}
                className="flex-1 rounded-md border border-border/60 bg-background px-3 py-2 text-sm"
              />
              <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">
                {line.length}/{MAX_OVERLAY_LINE_CHARS}
              </span>
            </div>
          ))}

          <div className="flex items-center gap-2 pt-1">
            {lines.length < MAX_OVERLAY_LINES && (
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => setLines((current) => [...current, ""])}
              >
                Add line
              </Button>
            )}
            <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void saveOverlay()}>
              {busy === "save-overlay" ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Save overlay
            </Button>
            {approvalBadge(overlay)}
            {overlay && overlay.approvalStatus !== "approved" && (
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => void onApprove(overlay._id)}
              >
                Approve overlay
              </Button>
            )}
          </div>

          {error && (
            <p className="flex items-start gap-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              {error}
            </p>
          )}
        </div>
      </Panel>
    </>
  );
}
