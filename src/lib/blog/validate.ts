// ---------------------------------------------------------------------------
// Atlas Intelligence — publication validation
//
// The database publish function (content_publish_blog) is the authority and
// will refuse to publish anything that fails its gates. This module is the
// authoring-side mirror of those gates, plus the publication-layer checks
// added in 20260926_atlas_intelligence_publication.sql.
//
// Why duplicate it at all: the seed pipeline needs to fail loudly on a bad
// article BEFORE it calls the database, with a precise per-article reason,
// rather than discovering the problem as a generic function error. And the
// content-quality tests assert against the same rules, so a rule cannot drift
// between the two without a test failing.
// ---------------------------------------------------------------------------

import { CATEGORIES, isCategorySlug } from "./taxonomy";
import type { Article } from "./articles/types";

export interface ArticleValidation {
  slug: string;
  errors: string[];
  warnings: string[];
  wordCount: number;
  readingTime: number;
}

const MIN_WORDS = 900;
const TARGET_MAX_WORDS = 2200;
const MIN_DESCRIPTION = 110;
const MAX_DESCRIPTION = 170;
const PLACEHOLDER =
  /\b(lorem ipsum|todo|fixme|placeholder|xxx+)\b|as an AI language model/i;
const CREDENTIAL =
  /(sk_(live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|service_role_key)/i;

export function countWords(body: string): number {
  return body.trim().split(/\s+/).filter(Boolean).length;
}

export function readingTimeMinutes(body: string): number {
  const words = countWords(body);
  return words === 0 ? 0 : Math.max(1, Math.round(words / 200));
}

/**
 * Validate one article against every publication rule.
 * Errors block publication; warnings do not.
 */
export function validateArticle(article: Article): ArticleValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const words = countWords(article.body);
  const slug = article.slug || "(missing slug)";

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.slug)) {
    errors.push(`${slug}: slug must be lowercase kebab-case`);
  }
  if (article.title.trim().length < 20) {
    errors.push(`${slug}: title is too short to be a real headline`);
  }
  if (!article.excerpt.trim()) {
    errors.push(`${slug}: excerpt is required`);
  } else if (article.excerpt.trim().length > 320) {
    errors.push(`${slug}: excerpt must be under 320 characters`);
  }
  if (!article.author.trim()) {
    errors.push(`${slug}: author (byline) is required`);
  }
  if (!isCategorySlug(article.category)) {
    errors.push(
      `${slug}: category "${article.category}" is not one of the eight editorial pillars`,
    );
  }
  if (article.tags.length < 3) {
    warnings.push(`${slug}: only ${article.tags.length} tags; 3+ is the house minimum`);
  }
  if (words < MIN_WORDS) {
    errors.push(`${slug}: body is ${words} words; ${MIN_WORDS}+ required`);
  }
  if (words > TARGET_MAX_WORDS) {
    warnings.push(`${slug}: body is ${words} words; over the ${TARGET_MAX_WORDS} target`);
  }
  if (!/^##\s+\S/m.test(article.body)) {
    errors.push(`${slug}: body has no level-two subheadings`);
  }
  if (article.body.split(/\n##\s+/).length < 3) {
    warnings.push(`${slug}: fewer than 3 subheadings; long articles break up better`);
  }
  if (PLACEHOLDER.test(article.body) || PLACEHOLDER.test(article.excerpt)) {
    errors.push(`${slug}: body or excerpt contains placeholder text`);
  }
  if (CREDENTIAL.test(article.body) || CREDENTIAL.test(article.excerpt)) {
    errors.push(`${slug}: body or excerpt contains credential-shaped material`);
  }

  const desc = article.seoDescription.trim();
  if (desc.length < MIN_DESCRIPTION || desc.length > MAX_DESCRIPTION) {
    errors.push(
      `${slug}: seoDescription is ${desc.length} characters; ${MIN_DESCRIPTION}-${MAX_DESCRIPTION} required`,
    );
  }
  if (article.seoTitle.trim() === article.title.trim()) {
    warnings.push(`${slug}: seoTitle duplicates the H1; a distinct SERP title is better`);
  }
  if (article.seoTitle.trim().length > 65) {
    errors.push(`${slug}: seoTitle is ${article.seoTitle.length} characters; 65 max`);
  }
  if (!article.ogTitle.trim() || !article.ogDescription.trim()) {
    errors.push(`${slug}: ogTitle and ogDescription are required`);
  }
  if (!article.imagePrompt.trim()) {
    warnings.push(`${slug}: imagePrompt is empty`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(article.publishedOn)) {
    errors.push(`${slug}: publishedOn must be an ISO date (YYYY-MM-DD)`);
  }

  return {
    slug,
    errors,
    warnings,
    wordCount: words,
    readingTime: readingTimeMinutes(article.body),
  };
}

/** Validate the whole library, plus cross-article invariants. */
export function validateLibrary(articles: readonly Article[]): ArticleValidation[] {
  const results = articles.map(validateArticle);

  const slugs = new Set<string>();
  for (const a of articles) {
    if (slugs.has(a.slug)) {
      results.push({
        slug: a.slug,
        errors: [`${a.slug}: duplicate slug in the library`],
        warnings: [],
        wordCount: 0,
        readingTime: 0,
      });
    }
    slugs.add(a.slug);
  }

  const featured = articles.filter((a) => a.featured);
  if (featured.length !== 1) {
    results.push({
      slug: "(library)",
      errors: [`exactly one article must be featured; found ${featured.length}`],
      warnings: [],
      wordCount: 0,
      readingTime: 0,
    });
  }

  // Every pillar should be represented, or the taxonomy is decoration.
  const used = new Set(articles.map((a) => a.category));
  for (const c of CATEGORIES) {
    if (!used.has(c.slug)) {
      results.push({
        slug: "(library)",
        errors: [`pillar "${c.slug}" has no articles`],
        warnings: [],
        wordCount: 0,
        readingTime: 0,
      });
    }
  }

  return results;
}
