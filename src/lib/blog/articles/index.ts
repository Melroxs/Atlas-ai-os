// ---------------------------------------------------------------------------
// Atlas Intelligence — the article library
//
// One import surface for the seed pipeline and the content-quality tests.
// The list is ordered oldest-first, which is the order they are published in,
// so the archive reads as a deliberate sequence rather than an arbitrary one.
// ---------------------------------------------------------------------------

import { BATCH_1 } from "./batch-1";
import { BATCH_2 } from "./batch-2";
import { BATCH_3 } from "./batch-3";
import { BATCH_4 } from "./batch-4";
import { BATCH_5 } from "./batch-5";
import type { Article } from "./types";

export const ARTICLES: readonly Article[] = [
  ...BATCH_1,
  ...BATCH_2,
  ...BATCH_3,
  ...BATCH_4,
  ...BATCH_5,
];

export type { Article } from "./types";

/** Look up an article by slug. */
export function articleBySlug(slug: string): Article | undefined {
  return ARTICLES.find((a) => a.slug === slug);
}

/** The article marked `featured`, if any. */
export function featuredArticle(): Article | undefined {
  return ARTICLES.find((a) => a.featured);
}

/** Every distinct tag used across the library, sorted. */
export function allTags(): string[] {
  const set = new Set<string>();
  for (const a of ARTICLES) for (const t of a.tags) set.add(t);
  return [...set].sort();
}
