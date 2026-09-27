// ---------------------------------------------------------------------------
// Atlas Intelligence — article source-of-truth shape
//
// Articles live in TypeScript as the authoring source, and the seed pipeline
// (`scripts/seed-blog-articles.mjs`) pushes each one through the REAL content
// engine: insert -> human-approval record -> content_publish_blog. Nothing
// bypasses the publish gate, and nothing is written to the table by a
// hand-crafted INSERT that skips validation.
//
// The type is intentionally strict about the fields the publish gate enforces,
// so a typo becomes a TypeScript error rather than a rejected publication.
// ---------------------------------------------------------------------------

import type { Motif } from "../visuals";

/** The three reusable CTAs defined in the CTA system. */
export type CtaId = "A" | "B" | "C" | "none";

export interface Article {
  /** URL slug. Also the deterministic seed for the artwork. */
  slug: string;
  title: string;
  /** Short excerpt shown on cards and used as the meta description fallback. */
  excerpt: string;
  /** Light markdown: ## / ### headings, "- " bullets, "> " quotes, blank-line paragraphs. */
  body: string;
  /** Editorial pillar slug — must exist in CATEGORIES. */
  category: string;
  tags: string[];
  /** Byline shown on the article page. */
  author: string;
  /** Which reusable CTA closes the article. */
  cta: CtaId;
  /** Visual motif for the generated hero/social artwork. */
  motif: Motif;
  /** Human-readable brief for regenerating the artwork later. */
  imagePrompt: string;
  /** SEO title override. Must differ from the H1 and fit a SERP. */
  seoTitle: string;
  /** SEO description. 140-165 characters. */
  seoDescription: string;
  /** Open Graph title. */
  ogTitle: string;
  /** Open Graph description. */
  ogDescription: string;
  /** Marks the homepage feature slot. Exactly one article sets this. */
  featured?: boolean;
  /**
   * Publication date as an ISO date string (YYYY-MM-DD). The seed resolves it
   * to epoch milliseconds. Spaced so the archive reads in a deliberate order.
   */
  publishedOn: string;
}
