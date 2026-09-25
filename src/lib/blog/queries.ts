// ---------------------------------------------------------------------------
// Atlas Blog — read path
//
// The public blog reads the EXISTING content engine table
// (`atlasContentItems`, migration 20260913) directly. That table already has
// the right row-level security:
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
//
// `content_public_list` exists but returns no body, so the public article page
// must read the table; using one path for both index and article keeps the two
// views consistent.
// ---------------------------------------------------------------------------

import { getSupabaseClient } from "@/lib/supabase";

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
  publishedAt: number | null;
  updatedAt: number | null;
}

/** Index list item — everything except the (potentially large) body. */
export type PublishedArticleSummary = Omit<PublishedArticle, "body">;

const LIST_COLUMNS =
  '_id,slug,title,summary,seo,jurisdiction,industry,publishedAt,updatedAt';
const ARTICLE_COLUMNS = `${LIST_COLUMNS},body`;

const TABLE = "atlasContentItems";

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
  return (data ?? []) as unknown as PublishedArticleSummary[];
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
  return (data ?? null) as unknown as PublishedArticle | null;
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
