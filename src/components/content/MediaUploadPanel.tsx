// ---------------------------------------------------------------------------
// Atlas Content Studio — external media upload panel.
//
// One component serves both the Thumbnail tab and the Video tab. It is
// deliberately presentational: it owns the file input, the local pre-validation
// and the status wording, and it delegates the actual upload to `onUpload`, so
// the page keeps control of loading and refreshing the package.
//
// The four states the user must be able to tell apart at a glance are rendered
// explicitly rather than inferred from a spinner: NOT UPLOADED, UPLOADING,
// READY, FAILED.
// ---------------------------------------------------------------------------

import { useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileVideo,
  Image as ImageIcon,
  Loader2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/atlas-ui";
import {
  MANUAL_MEDIA_PROVIDER,
  acceptedLabel,
  acceptAttribute,
  formatMediaBytes,
  RECOMMENDED_THUMBNAIL_HEIGHT,
  RECOMMENDED_THUMBNAIL_WIDTH,
  type ManualMediaKind,
} from "@/lib/content-engine/media-upload";
import type { ContentAssetRecord } from "@/lib/content-engine/types";
import type { MediaUploadResult } from "@/lib/content-engine/media-upload-client";

export type MediaUploadStatus = "not_uploaded" | "uploading" | "ready" | "failed";

export interface MediaUploadPanelProps {
  kind: ManualMediaKind;
  /** The existing canonical asset, or null when nothing is attached yet. */
  asset: ContentAssetRecord | null;
  /** Public URL for a thumbnail (blog hero / OG). Null for a private video. */
  previewUrl: string | null;
  /** Performs the upload. Rejections are surfaced through `onError`. */
  onUpload: (kind: ManualMediaKind, file: File) => Promise<MediaUploadResult>;
  /** Called after a successful upload so the page can refresh the package. */
  onUploaded: (result: MediaUploadResult) => void;
  disabled?: boolean;
}

const HEADING: Record<ManualMediaKind, string> = {
  thumbnail: "Upload Thumbnail",
  video: "Upload Video",
  background: "Upload Thumbnail Background",
};

const DESCRIPTION: Record<ManualMediaKind, string> = {
  thumbnail:
    "Use a file you produced elsewhere. Atlas stores it and uses it as this package's shared thumbnail: the blog hero, the Open Graph image and the YouTube thumbnail are all the same file.",
  video:
    "Use a video you produced elsewhere. Atlas stores it privately and uses it as the source for YouTube publishing. Uploading it does not publish it.",
  background:
    "The image Atlas's deterministic compositor draws the approved overlay text onto. PNG only, up to 2 MB. It is an input, not a thumbnail: uploading it does not replace this package's thumbnail and does not render anything.",
};

const BUTTON_LABEL: Record<ManualMediaKind, { initial: string; replace: string }> = {
  thumbnail: { initial: "Upload Thumbnail", replace: "Replace Thumbnail" },
  video: { initial: "Upload Video", replace: "Replace Video" },
  background: { initial: "Upload Background", replace: "Replace Background" },
};

function statusOf(
  kind: ManualMediaKind,
  asset: ContentAssetRecord | null,
  busy: boolean,
  failed: boolean,
): MediaUploadStatus {
  if (busy) return "uploading";
  if (failed) return "failed";
  if (!asset) return "not_uploaded";
  // A manual upload that is still `drafted` is READY as media: the bytes are
  // durable and the asset exists. It is not published, and saying otherwise
  // would misrepresent the approval state, which this panel does not change.
  return kind === "thumbnail" || asset.storagePath ? "ready" : "not_uploaded";
}

const STATUS_BADGE: Record<MediaUploadStatus, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  not_uploaded: { label: "Not uploaded", variant: "outline" },
  uploading: { label: "Uploading", variant: "secondary" },
  ready: { label: "Ready", variant: "default" },
  failed: { label: "Failed", variant: "destructive" },
};

export default function MediaUploadPanel({
  kind,
  asset,
  previewUrl,
  onUpload,
  onUploaded,
  disabled = false,
}: MediaUploadPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [result, setResult] = useState<MediaUploadResult | null>(null);

  const status = statusOf(kind, asset, busy, error !== null);
  const badge = STATUS_BADGE[status];
  const Icon = kind === "thumbnail" ? ImageIcon : FileVideo;

  const handleFile = async (file: File) => {
    setBusy(true);
    setError(null);
    setWarning(null);
    try {
      const uploaded = await onUpload(kind, file);
      setResult(uploaded);
      setWarning(uploaded.warning);
      onUploaded(uploaded);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The upload could not be completed. Please try again.",
      );
    } finally {
      setBusy(false);
      // Allow re-selecting the same file after a failure.
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const byteSize = result?.byteSize ?? null;
  const originalName =
    result?.fileName ??
    (typeof asset?.metadata?.["originalFileName"] === "string"
      ? (asset.metadata["originalFileName"] as string)
      : null);
  const storedBytes =
    byteSize ??
    (typeof asset?.metadata?.["byteSize"] === "number"
      ? (asset.metadata["byteSize"] as number)
      : null);

  return (
    <Panel title={HEADING[kind]} description={DESCRIPTION[kind]}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={badge.variant}>{badge.label}</Badge>
          {asset?.status && asset.status !== "drafted" && (
            <Badge variant="secondary">asset: {asset.status}</Badge>
          )}
          {asset?.provider && (
            <span className="text-xs text-muted-foreground">source: {asset.provider}</span>
          )}
        </div>

        {/* Current media -------------------------------------------------- */}
        {kind === "thumbnail" ? (
          previewUrl ? (
            <img
              src={previewUrl}
              alt="Current package thumbnail"
              className="w-full max-w-xl rounded-lg border border-border/60"
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              No thumbnail is attached to this package yet.
            </p>
          )
        ) : previewUrl ? (
          <video
            src={previewUrl}
            controls
            preload="metadata"
            className="w-full max-w-xl rounded-lg border border-border/60"
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            No video is attached to this package yet.
          </p>
        )}

        {/* File facts ----------------------------------------------------- */}
        {(originalName || storedBytes !== null) && (
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {originalName && (
              <div className="flex gap-2">
                <dt className="text-muted-foreground">File</dt>
                <dd className="truncate text-foreground">{originalName}</dd>
              </div>
            )}
            {storedBytes !== null && (
              <div className="flex gap-2">
                <dt className="text-muted-foreground">Size</dt>
                <dd className="text-foreground">{formatMediaBytes(storedBytes)}</dd>
              </div>
            )}
            {result?.width && result?.height && (
              <div className="flex gap-2">
                <dt className="text-muted-foreground">Dimensions</dt>
                <dd className="text-foreground">
                  {result.width}x{result.height}
                </dd>
              </div>
            )}
            {typeof result?.durationSeconds === "number" && (
              <div className="flex gap-2">
                <dt className="text-muted-foreground">Duration</dt>
                <dd className="text-foreground">
                  {Math.round(result.durationSeconds)}s
                </dd>
              </div>
            )}
            {result?.replaced && (
              <div className="flex gap-2">
                <dt className="text-muted-foreground">Previous file</dt>
                <dd className="text-foreground">replaced</dd>
              </div>
            )}
          </dl>
        )}

        {/* Recommendation ------------------------------------------------- */}
        {kind === "thumbnail" && (
          <p className="text-xs text-muted-foreground">
            Recommended: {RECOMMENDED_THUMBNAIL_WIDTH}x{RECOMMENDED_THUMBNAIL_HEIGHT} (16:9).
            Accepted: {acceptedLabel(kind)}. Maximum {formatMediaBytes(2 * 1024 * 1024)}.
          </p>
        )}
        {kind === "video" && (
          <p className="text-xs text-muted-foreground">
            Accepted: {acceptedLabel(kind)}. Maximum {formatMediaBytes(100 * 1024 * 1024)}.
          </p>
        )}

        {/* Action --------------------------------------------------------- */}
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={inputRef}
            type="file"
            accept={acceptAttribute(kind)}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
          <Button
            size="sm"
            disabled={disabled || busy}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <Upload className="mr-2 size-4" />
            )}
            {busy
              ? "Uploading…"
              : asset
                ? BUTTON_LABEL[kind].replace
                : BUTTON_LABEL[kind].initial}
          </Button>
          {busy && (
            <span className="text-sm text-muted-foreground">
              Uploading — keep this tab open.
            </span>
          )}
        </div>

        {/* Feedback ------------------------------------------------------- */}
        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {warning && !error && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{warning}</span>
          </div>
        )}
        {!error && !warning && status === "ready" && (
          <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            <span>
              {kind === "thumbnail"
                ? `Stored in Atlas media and set as this package's shared thumbnail (${MANUAL_MEDIA_PROVIDER}).`
                : `Stored privately as this package's video source (${MANUAL_MEDIA_PROVIDER}).`}{" "}
              The package still needs review and approval before anything is published.
            </span>
          </div>
        )}
        {status === "not_uploaded" && !error && (
          <p className="text-sm text-muted-foreground">
            <Icon className="mr-1.5 inline size-4" />
            Nothing uploaded yet. Generate the file elsewhere, then bring it here.
          </p>
        )}
      </div>
    </Panel>
  );
}
