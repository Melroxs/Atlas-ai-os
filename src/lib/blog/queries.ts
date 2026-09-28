// ---------------------------------------------------------------------------
// Atlas Blog — read path
//
// The public blog reads the EXISTING content engine table
// (`atlasContentItems`, migrations 20260913 / 20260920 / 20260926) directly.
// That table already has the right row-level security:
//
//   contentitems_public_read -> anon + authenticated may SELECT rows where
//                               status = 'published' and contentType = 'blog'
//   contentitems_auth_read   -> authenticated may also read approved content
//   contentitems_admin_all   -> platform admins (super_admin / atlas_admin)
//
// Every query below ALSO filters explicitly on status = 'published', so a
// draft, failed or archived article can never leak into the public blog even
// for a signed-in admin. RLS is the second, server-side layer — the frontend
// is never the only guard.
// ---------------------------------------------------------------------------

import { getSupabaseClient } from "@/lib/supabase";
import type { Motif } from "./visuals";

/** A published blog article, as rendered by the public site. */
export interface PublishedArticle {
  _id: string;
  slug: string;
  title: string;
  summary: string | null;
  body: string | null;
  seo: Record<string, unknown> | null;
  jurisdiction: string | null;
  industry: string | null;
  category: string | null;
  tags: string[];
  author: string | null;
  heroImage: string | null;
  socialImage: string | null;
  readingTime: number | null;
  ctaId: string | null;
  /**
   * The canonical YouTube artefact for this article, written by the Content
   * Engine when a package's video is published. The hero video card and the
   * two-way blog <-> video link are built from these — never from a second,
   * unrelated asset.
   */
  youtubeUrl: string | null;
  youtubeVideoId: string | null;
  youtubeThumbnailUrl: string | null;
  /**
   * Visual motif, read back out of the stored SEO contract rather than the
   * table, so a published article needs no extra column to render its
   * fallback artwork.
   */
  motif: Motif;
  publishedAt: number | null;
  updatedAt: number | null;
}

/** Index list item — everything except the (potentially large) body. */
export type PublishedArticleSummary = Omit<PublishedArticle, "body">;

/** A related-article card. */
export interface RelatedArticle {
  slug: string;
  title: string;
  summary: string | null;
  category: string | null;
  heroImage: string | null;
  publishedAt: number | null;
  readingTime: number | null;
}

const LIST_COLUMNS =
  "_id,slug,title,summary,seo,jurisdiction,industry,category,tags,author,heroImage,socialImage,readingTime,publishedAt,updatedAt,youtubeUrl,youtubeVideoId,youtubeThumbnailUrl";
const ARTICLE_COLUMNS = `${LIST_COLUMNS},body,ctaId`;

const TABLE = "atlasContentItems";

/** Coerce a jsonb column that may arrive as an array, a JSON string, or null. */
function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((v): v is string => typeof v === "string")
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Read the stored motif, falling back rather than rendering nothing. */
function toMotif(seo: Record<string, unknown> | null): Motif {
  const value = seo?.motif;
  return typeof value === "string" ? (value as Motif) : "product";
}

/**
 * Normalize a raw row into the published shape.
 *
 * This is a boundary transform, matching the established pattern elsewhere in
 * Atlas: jsonb columns are decoded once, at the edge, so no render site ever
 * has to defend against a legacy or malformed shape.
 */
function toPublishedArticle(row: Record<string, unknown>): PublishedArticle {
  const seo = (row.seo ?? null) as Record<string, unknown> | null;
  return {
    _id: String(row._id ?? ""),
    slug: String(row.slug ?? ""),
    title: String(row.title ?? ""),
    summary: (row.summary as string | null) ?? null,
    body: (row.body as string | null) ?? null,
    seo,
    jurisdiction: (row.jurisdiction as string | null) ?? null,
    industry: (row.industry as string | null) ?? null,
    category: (row.category as string | null) ?? null,
    tags: toStringArray(row.tags),
    author: (row.author as string | null) ?? null,
    heroImage: (row.heroImage as string | null) ?? null,
    socialImage: (row.socialImage as string | null) ?? null,
    readingTime: typeof row.readingTime === "number" ? row.readingTime : null,
    ctaId: (row.ctaId as string | null) ?? null,
    youtubeUrl: (row.youtubeUrl as string | null) ?? null,
    youtubeVideoId: (row.youtubeVideoId as string | null) ?? null,
    youtubeThumbnailUrl: (row.youtubeThumbnailUrl as string | null) ?? null,
    motif: toMotif(seo),
    publishedAt: typeof row.publishedAt === "number" ? row.publishedAt : null,
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : null,
  };
}

/** Newest-first published articles. Returns [] on any failure (never throws). */
export async function listPublishedArticles(
  limit = 50,
): Promise<PublishedArticleSummary[]> {
  const supabase = getSupabaseClient();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from(TABLE)
    .select(LIST_COLUMNS)
    .eq("status", "published")
    .eq("contentType", "blog")
    .not("slug", "is", null)
    .order("publishedAt", { ascending: false, nullsFirst: false })
    .limit(Math.max(1, Math.min(limit, 100)));

  if (error) {
    console.error("[atlas] blog list failed:", error.message);
    return [];
  }
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(
    toPublishedArticle,
  );
}

/**
 * One published article by slug.
 *
 * Returns `null` for anything that is not published — an unpublished slug is
 * indistinguishable from a missing one, so drafts cannot be probed.
 */
export async function getPublishedArticleBySlug(
  slug: string,
): Promise<PublishedArticle | null> {
  const clean = (slug ?? "").trim();
  if (!clean) return null;

  const supabase = getSupabaseClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from(TABLE)
    .select(ARTICLE_COLUMNS)
    .eq("slug", clean)
    .eq("status", "published")
    .eq("contentType", "blog")
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[atlas] blog article failed:", error.message);
    return null;
  }
  if (!data) return null;
  return toPublishedArticle(data as unknown as Record<string, unknown>);
}

/**
 * Related articles for an article page.
 *
 * Falls back to the most recent published articles if the related RPC is
 * unavailable, so the section degrades rather than disappearing.
 */
export async function listRelatedArticles(
  slug: string,
  limit = 3,
): Promise<RelatedArticle[]> {
  const supabase = getSupabaseClient();
  if (!supabase) return [];

  const { data, error } = await supabase.rpc("content_public_related", {
    p_slug: (slug ?? "").trim(),
    p_limit: Math.max(1, Math.min(limit, 6)),
  });

  if (!error && Array.isArray(data)) {
    return (data as unknown as RelatedArticle[]).filter((r) => r && r.slug);
  }

  const all = await listPublishedArticles(12);
  return all
    .filter((a) => a.slug !== slug)
    .slice(0, limit)
    .map((a) => ({
      slug: a.slug,
      title: a.title,
      summary: a.summary,
      category: a.category,
      heroImage: a.heroImage,
      publishedAt: a.publishedAt,
      readingTime: a.readingTime,
    }));
}

/** Absolute site origin, used for canonical + Open Graph URLs. */
export function siteOrigin(): string {
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin.replace(/\/+$/, "");
  }
  return "https://atlas-ai-os.com";
}

/** Canonical URL for an article slug. */
export function articleUrl(slug: string): string {
  return `${siteOrigin()}/blog/${slug}`;
}
