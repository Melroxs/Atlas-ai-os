import { Play } from "lucide-react";

/**
 * The blog's hero video card.
 *
 * The Content Engine generates ONE thumbnail per package and one canonical
 * YouTube URL. This card is where they meet: the same thumbnail that is the
 * video's poster is the article's hero, and clicking it opens the exact video
 * the package published — never a second, unrelated asset and never a video
 * hosted twice.
 *
 * Renders nothing when the article has no published video, so articles without
 * one keep the plain hero image they had before.
 */
export function BlogVideoCard({
  thumbnailUrl,
  youtubeUrl,
  title,
  className,
}: {
  thumbnailUrl: string | null;
  youtubeUrl: string | null;
  title: string;
  className?: string;
}) {
  if (!youtubeUrl) return null;

  return (
    <figure className={className}>
      <a
        href={youtubeUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="group relative block overflow-hidden rounded-xl border border-border bg-muted shadow-sm transition-shadow hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Watch the video: ${title}`}
      >
        <div className="relative aspect-video w-full overflow-hidden bg-muted">
          {thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt=""
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
              loading="lazy"
            />
          ) : (
            // No thumbnail yet: a labelled surface, never a fabricated image.
            <div className="flex h-full w-full items-center justify-center text-xs uppercase tracking-widest text-muted-foreground">
              Video
            </div>
          )}
          <div className="absolute inset-0 flex items-center justify-center bg-black/25 transition-colors group-hover:bg-black/35">
            <span className="flex size-14 items-center justify-center rounded-full bg-background/90 shadow-lg transition-transform duration-300 group-hover:scale-110">
              <Play className="ml-0.5 size-6 fill-current text-foreground" />
            </span>
          </div>
        </div>
        <figcaption className="flex items-center justify-between gap-3 px-4 py-3">
          <span className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Watch the video
          </span>
          <span className="truncate text-sm text-foreground">{title}</span>
        </figcaption>
      </a>
    </figure>
  );
}
