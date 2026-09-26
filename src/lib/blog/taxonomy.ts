// ---------------------------------------------------------------------------
// Atlas Intelligence — editorial taxonomy
//
// The eight pillars are the spine of the publication. They are a CLOSED set:
// the `contentitems_category_check` constraint in migration
// 20260926_atlas_intelligence_publication.sql enforces exactly these slugs, so
// a typo can never create an orphan category the index cannot filter on.
//
// Each pillar carries a real editorial job. "Revenue Recovery" and
// "Estimating & Supplements" are close relatives, and the split is deliberate:
// recovery is about money that exists but was never claimed, while estimating
// is about the technical accuracy of the scope itself. Readers in a supplement
// role go to one; owners and operators go to the other.
// ---------------------------------------------------------------------------

import type { Motif } from "./visuals";

export interface Category {
  /** The value stored in atlasContentItems.category (and the DB CHECK set). */
  slug: string;
  /** Human label shown on cards, filters and the article header. */
  label: string;
  /** One line, used on the category filter and the article eyebrow. */
  blurb: string;
  /** The default visual motif for articles in this pillar. */
  motif: Motif;
}

export const CATEGORIES: readonly Category[] = [
  {
    slug: "revenue-recovery",
    label: "Revenue Recovery",
    blurb: "Money you already earned and never claimed.",
    motif: "ledger",
  },
  {
    slug: "insurance-claims",
    label: "Insurance Claims",
    blurb: "Documentation, evidence and carrier process.",
    motif: "evidence",
  },
  {
    slug: "restoration-operations",
    label: "Restoration Operations",
    blurb: "How restoration work actually gets run.",
    motif: "coordination",
  },
  {
    slug: "ai-automation",
    label: "AI & Automation",
    blurb: "What AI genuinely does inside a restoration business.",
    motif: "analysis",
  },
  {
    slug: "estimating-supplements",
    label: "Estimating & Supplements",
    blurb: "Scope accuracy, line items and the evidence behind them.",
    motif: "lineItems",
  },
  {
    slug: "business-growth",
    label: "Restoration Business Growth",
    blurb: "Margin, leverage and scaling without more chaos.",
    motif: "convergence",
  },
  {
    slug: "restoration-intelligence",
    label: "Restoration Intelligence",
    blurb: "Data, knowledge and decision support.",
    motif: "analysis",
  },
  {
    slug: "atlas",
    label: "Atlas",
    blurb: "Product education, workflows and announcements.",
    motif: "product",
  },
] as const;

const BY_SLUG = new Map(CATEGORIES.map((c) => [c.slug, c]));

export function categoryBySlug(slug: string | null | undefined): Category | undefined {
  return slug ? BY_SLUG.get(slug) : undefined;
}

export function categoryLabel(slug: string | null | undefined): string | null {
  return categoryBySlug(slug)?.label ?? null;
}

export function isCategorySlug(value: unknown): value is string {
  return typeof value === "string" && BY_SLUG.has(value);
}
