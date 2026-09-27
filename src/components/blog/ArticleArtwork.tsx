// ---------------------------------------------------------------------------
// Atlas Intelligence — article artwork
//
// Renders the published hero image for an article. The image is served from the
// public `blog-media` Supabase bucket.
//
// Two properties matter here:
//
//   1. It never renders a broken image. If the stored URL is missing or fails
//      to load, it falls back to the SAME generated composition the seed
//      pipeline produced, inlined as an SVG data URI. Because the generator is
//      deterministic on the slug, the fallback is visually identical to the
//      intended artwork rather than a grey box.
//
//   2. It costs nothing until it is needed. No image is fetched on a page that
//      does not render an article, and the real image is lazy-loaded with an
//      explicit aspect ratio so the grid never shifts as images arrive.
// ---------------------------------------------------------------------------

import { useState } from "react";
import { renderAtlasArtwork, type Motif } from "@/lib/blog/visuals";

interface ArticleArtworkProps {
  /** Published hero image URL, or null if the article has none. */
  src: string | null;
  /**
   * Decorative images pass an empty alt. Pass real text only when the image
   * carries information the surrounding text does not.
   */
  alt: string;
  /** The article's motif, used to build the inline fallback. */
  motif: Motif;
  /** The article slug — the deterministic seed for the fallback. */
  slug: string;
  /** CSS aspect-ratio for the frame, so layout is stable before load. */
  aspect?: string;
  /** Render at the social crop instead of the hero crop. */
  kind?: "hero" | "social";
  className?: string;
}

export function ArticleArtwork({
  src,
  alt,
  motif,
  slug,
  aspect = "16 / 9",
  kind = "hero",
  className,
}: ArticleArtworkProps) {
  const [failed, setFailed] = useState(false);
  const fallback = `data:image/svg+xml;utf8,${encodeURIComponent(
    renderAtlasArtwork(motif, slug, kind),
  )}`;
  const useFallback = !src || failed;

  return (
    <div
      className={`overflow-hidden rounded-md bg-muted ${className ?? ""}`}
      style={{ aspectRatio: aspect }}
    >
      <img
        src={useFallback ? fallback : src}
        alt={alt}
        width={kind === "social" ? 1200 : 1600}
        height={kind === "social" ? 628 : 900}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className="h-full w-full object-cover"
      />
    </div>
  );
}
