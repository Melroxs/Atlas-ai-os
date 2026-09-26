// ---------------------------------------------------------------------------
// Atlas Intelligence — SEO head management
//
// Atlas is a client-rendered SPA, so article metadata is applied to <head> at
// runtime. Every value written here comes from the stored article + its SEO
// contract; nothing is invented, and no date is emitted unless it exists.
// ---------------------------------------------------------------------------

export interface ArticleSeoInput {
  title: string;
  description: string;
  canonicalUrl: string;
  publishedAt?: number | null;
  updatedAt?: number | null;
  imageUrl?: string | null;
  keywords?: string[];
  author?: string;
  /** Distinct Open Graph title, when the publication sets one. */
  ogTitle?: string;
  /** Distinct Open Graph description, when the publication sets one. */
  ogDescription?: string;
  /** Site name for the Open Graph card. */
  siteName?: string;
}

const MANAGED = "data-atlas-seo";

function upsertMeta(attr: "name" | "property", key: string, content: string): void {
  if (typeof document === "undefined") return;
  let tag = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!tag) {
    tag = document.createElement("meta");
    tag.setAttribute(attr, key);
    tag.setAttribute(MANAGED, "true");
    document.head.appendChild(tag);
  }
  tag.setAttribute("content", content);
}

function removeManaged(selector: string): void {
  if (typeof document === "undefined") return;
  document.head.querySelectorAll(selector).forEach((el) => el.remove());
}

const iso = (ms?: number | null) =>
  ms && Number.isFinite(ms) ? new Date(ms).toISOString() : null;

/** Apply article metadata (title, description, canonical, OG, article JSON-LD). */
export function applyArticleSeo(input: ArticleSeoInput): void {
  if (typeof document === "undefined") return;

  const ogTitle = input.ogTitle?.trim() || input.title;
  const ogDescription = input.ogDescription?.trim() || input.description;

  document.title = `${input.title} | Atlas Intelligence`;

  upsertMeta("name", "description", input.description);

  upsertMeta("property", "og:type", "article");
  upsertMeta("property", "og:site_name", input.siteName?.trim() || "Atlas Intelligence");
  upsertMeta("property", "og:title", ogTitle);
  upsertMeta("property", "og:description", ogDescription);
  upsertMeta("property", "og:url", input.canonicalUrl);
  upsertMeta("name", "twitter:card", "summary_large_image");
  upsertMeta("name", "twitter:site", "@atlasaios");
  upsertMeta("name", "twitter:title", ogTitle);
  upsertMeta("name", "twitter:description", ogDescription);

  const published = iso(input.publishedAt);
  const updated = iso(input.updatedAt);
  if (published) upsertMeta("property", "article:published_time", published);
  if (updated) upsertMeta("property", "article:modified_time", updated);
  if (input.keywords?.length) {
    upsertMeta("name", "keywords", input.keywords.join(", "));
  }
  if (input.author) {
    upsertMeta("name", "author", input.author);
  }
  if (input.imageUrl) {
    upsertMeta("property", "og:image", input.imageUrl);
    upsertMeta("property", "og:image:alt", ogTitle);
    upsertMeta("name", "twitter:image", input.imageUrl);
  }

  let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!canonical) {
    canonical = document.createElement("link");
    canonical.setAttribute("rel", "canonical");
    canonical.setAttribute(MANAGED, "true");
    document.head.appendChild(canonical);
  }
  canonical.setAttribute("href", input.canonicalUrl);

  // Structured data for search engines.
  removeManaged('script[type="application/ld+json"][data-atlas-article]');
  const ld = document.createElement("script");
  ld.type = "application/ld+json";
  ld.setAttribute("data-atlas-article", "true");
  ld.textContent = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: input.title,
    description: input.description,
    url: input.canonicalUrl,
    ...(published ? { datePublished: published } : {}),
    ...(updated ? { dateModified: updated } : {}),
    ...(input.imageUrl ? { image: input.imageUrl } : {}),
    ...(input.author ? { author: { "@type": "Organization", name: input.author } } : {}),
    publisher: { "@type": "Organization", name: "Atlas" },
    mainEntityOfPage: { "@type": "WebPage", "@id": input.canonicalUrl },
  });
  document.head.appendChild(ld);
}

/** Apply the blog index metadata. */
export function applyBlogIndexSeo(count: number): void {
  if (typeof document === "undefined") return;
  document.title = "Atlas Intelligence | Restoration industry intelligence";
  upsertMeta(
    "name",
    "description",
    `Field intelligence for insurance restoration — claims, evidence, estimating, supplements and revenue recovery from Atlas${
      count > 0 ? ` — ${count} published ${count === 1 ? "article" : "articles"}` : ""
    }.`,
  );
  upsertMeta("property", "og:type", "website");
  upsertMeta("property", "og:site_name", "Atlas Intelligence");
  upsertMeta("property", "og:title", "Atlas Intelligence");
}

/** Remove article-specific tags when leaving the blog. */
export function clearArticleSeo(): void {
  removeManaged('script[type="application/ld+json"][data-atlas-article]');
  removeManaged(`meta[${MANAGED}][property^="article:"]`);
}
