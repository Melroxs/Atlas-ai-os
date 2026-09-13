// ---------------------------------------------------------------------------
// Atlas Platform — Content engine foundation (pure, no I/O)
//
// Prepares automated publishing WITHOUT enabling autonomous publishing.
// Nothing in this module publishes: the worker only moves content between
// explicit, human-gated states.
//
// Provenance chain enforced here:
//   authoritative source -> knowledge version -> verified intelligence
//     -> content research -> blog article -> native LinkedIn post
// ---------------------------------------------------------------------------

import type {
  ContentItem,
  ContentProvenanceEdge,
  ContentSeo,
  ContentStatus,
  ContentType,
  KnowledgeVersion,
} from "./types";

// ---------------------------------------------------------------------------
// State machine (mirrors public.content_transition in SQL)
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<ContentStatus, ContentStatus[]> = {
  opportunity: ["researching", "archived", "failed"],
  researching: ["drafted", "failed", "archived"],
  drafted: ["in_review", "failed", "archived"],
  in_review: ["approved", "failed", "archived"],
  approved: ["published", "failed", "archived"],
  published: ["archived"],
  failed: ["researching", "drafted", "archived"],
  archived: [],
};

export function nextContentStatuses(from: ContentStatus): ContentStatus[] {
  return TRANSITIONS[from] ?? [];
}

export function canTransition(from: ContentStatus, to: ContentStatus): boolean {
  return nextContentStatuses(from).includes(to);
}

/** Validate a transition, including the hard publish gate. */
export function validateTransition(
  item: Pick<ContentItem, "status" | "approvalStatus" | "contentType">,
  to: ContentStatus,
): { ok: boolean; error?: string } {
  if (!canTransition(item.status, to)) {
    return {
      ok: false,
      error: `Invalid content transition: ${item.status} -> ${to}.`,
    };
  }
  if (to === "published" && item.approvalStatus !== "approved") {
    return {
      ok: false,
      error: "Content must be explicitly approved by a human before it can be published.",
    };
  }
  return { ok: true };
}

/** The terminal, human-owned gate for a content item. */
export function requiresHumanApproval(to: ContentStatus): boolean {
  return to === "approved" || to === "published";
}

// ---------------------------------------------------------------------------
// Draft validation
// ---------------------------------------------------------------------------

export interface ContentDraftValidation {
  errors: string[];
  warnings: string[];
}

/**
 * Validate a content draft before it can be persisted.
 *
 * A LinkedIn post must descend from a parent item, and content must reference
 * at least one knowledge item — Atlas does not publish unsupported claims.
 * Missing provenance is an ERROR for anything past 'opportunity'.
 */
export function validateContentDraft(item: {
  contentType: ContentType;
  status?: ContentStatus;
  title?: string | null;
  parentContentId?: string | null;
  knowledgeIds?: string[];
  summary?: string | null;
}): ContentDraftValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const status = item.status ?? "opportunity";

  if (!item.title || item.title.trim().length === 0) {
    errors.push("Content title is required.");
  }
  if (item.contentType === "linkedin_post" && !item.parentContentId) {
    errors.push("A LinkedIn post must reference the parent blog article it derives from.");
  }
  if (status !== "opportunity" && (item.knowledgeIds?.length ?? 0) === 0) {
    errors.push(
      "Content beyond the opportunity stage must reference at least one knowledge item.",
    );
  }
  if (status !== "opportunity" && !item.summary) {
    warnings.push("No summary supplied; SEO description will fall back to the title.");
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// SEO
// ---------------------------------------------------------------------------

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Build the SEO contract for a blog article.
 * `publishedDate`/`updatedDate` are only set when they actually exist — no
 * fabricated dates.
 */
export function buildSeoMetadata(
  item: Pick<
    ContentItem,
    | "title"
    | "summary"
    | "body"
    | "slug"
    | "jurisdiction"
    | "industry"
    | "publishedAt"
    | "updatedAt"
  >,
  baseUrl = "",
): ContentSeo {
  const slug = item.slug ?? slugify(item.title);
  const description =
    item.summary?.trim() ||
    (item.body ? item.body.replace(/\s+/g, " ").trim().slice(0, 155) : "") ||
    item.title;
  const iso = (ms?: number | null) =>
    ms ? new Date(ms).toISOString().slice(0, 10) : undefined;

  return {
    title: item.title,
    slug,
    description,
    canonicalUrl: baseUrl ? `${baseUrl.replace(/\/$/, "")}/blog/${slug}` : undefined,
    publishedDate: iso(item.publishedAt),
    updatedDate: iso(item.updatedAt),
    topic: item.industry ?? undefined,
    jurisdiction: item.jurisdiction ?? undefined,
    keywords: deriveKeywords(item.title, item.summary),
  };
}

/** Conservative keyword derivation — real words from the title, never invented. */
export function deriveKeywords(title: string, summary?: string | null): string[] {
  const stop = new Set([
    "the", "and", "for", "with", "that", "this", "from", "are", "was", "were",
    "what", "when", "how", "why", "into", "your", "you", "its", "it's", "a",
    "an", "of", "to", "in", "on", "at", "by", "or", "as", "is", "be", "not",
  ]);
  const words = `${title} ${summary ?? ""}`
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !stop.has(w));
  return [...new Set(words)].slice(0, 8);
}

// ---------------------------------------------------------------------------
// Blog -> LinkedIn (a SEPARATE native post, never a copy of the article)
// ---------------------------------------------------------------------------

export interface LinkedInDerivationResult {
  ok: boolean;
  error?: string;
  post?: {
    title: string;
    body: string;
    parentContentId: string;
    sourceIds: string[];
    knowledgeIds: string[];
  };
}

/**
 * Derive a native LinkedIn post from an approved/drafted blog article.
 *
 * Explicitly refuses to reproduce the article body: a LinkedIn post is a short
 * native post built from the article's thesis. If no thesis material exists,
 * the derivation fails rather than duplicating the whole article.
 */
export function buildLinkedInDraft(
  blog: Pick<
    ContentItem,
    "_id" | "title" | "summary" | "status" | "approvalStatus" | "sourceIds" | "knowledgeIds"
  >,
  keyPoints: string[],
  opts: { maxChars?: number } = {},
): LinkedInDerivationResult {
  if (blog.status === "opportunity" || blog.status === "researching") {
    return {
      ok: false,
      error: "Research must be complete before a LinkedIn post can be derived.",
    };
  }
  if (blog.approvalStatus !== "approved" && blog.status !== "approved" && blog.status !== "published") {
    return {
      ok: false,
      error: "The parent article must be approved before a LinkedIn post is derived.",
    };
  }

  const points = keyPoints.map((p) => p.trim()).filter(Boolean);
  const thesis = blog.summary?.trim();
  if (points.length === 0 && !thesis) {
    return {
      ok: false,
      error:
        "No thesis or key points available. Atlas will not duplicate the full article as a LinkedIn post.",
    };
  }

  const maxChars = opts.maxChars ?? 1_300;
  const lines = [blog.title.trim()];
  if (thesis) lines.push("", thesis);
  if (points.length > 0) lines.push("", ...points.map((p) => `• ${p}`));
  let body = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (body.length > maxChars) body = `${body.slice(0, maxChars - 1).trimEnd()}…`;

  return {
    ok: true,
    post: {
      title: blog.title,
      body,
      parentContentId: blog._id,
      sourceIds: blog.sourceIds ?? [],
      knowledgeIds: blog.knowledgeIds ?? [],
    },
  };
}

// ---------------------------------------------------------------------------
// Provenance chain
// ---------------------------------------------------------------------------

export interface ProvenanceChainStep {
  level:
    | "authoritative_source"
    | "knowledge_version"
    | "verified_intelligence"
    | "content_research"
    | "blog_article"
    | "linkedin_post";
  label: string;
  referenceId: string | null;
  detail: string;
}

/**
 * Build the human-readable provenance chain for a content item.
 * Every hop is a real reference; missing hops are surfaced as missing rather
 * than silently skipped.
 */
export function buildProvenanceChain(
  content: Pick<ContentItem, "contentType" | "title" | "_id" | "sourceIds" | "knowledgeIds">,
  knowledge: KnowledgeVersion[],
  sources: Array<{ sourceId: string; name: string }>,
): ProvenanceChainStep[] {
  const steps: ProvenanceChainStep[] = [];

  const matchedSources = sources.filter((s) =>
    (content.sourceIds ?? []).includes(s.sourceId),
  );
  steps.push({
    level: "authoritative_source",
    label: matchedSources.length > 0 ? matchedSources.map((s) => s.name).join(", ") : "No sources linked",
    referenceId: matchedSources[0]?.sourceId ?? null,
    detail:
      matchedSources.length > 0
        ? `${matchedSources.length} registered authoritative source(s).`
        : "This content has no linked authoritative source and must not be published.",
  });

  for (const v of knowledge) {
    steps.push({
      level: "knowledge_version",
      label: v.title,
      referenceId: v.knowledgeId,
      detail: `Version ${v.versionNumber} (${v.version ?? "unversioned"}), status ${v.status}${
        v.effectiveDate ? `, effective ${new Date(v.effectiveDate).toISOString().slice(0, 10)}` : ""
      }.`,
    });
    steps.push({
      level: "verified_intelligence",
      label: v.title,
      referenceId: v.knowledgeId,
      detail:
        v.reviewStatus === "verified"
          ? "Human-verified knowledge."
          : `Review status: ${v.reviewStatus ?? "unverified"} — not yet authoritative.`,
    });
  }

  steps.push({
    level: "content_research",
    label: "Research",
    referenceId: content._id,
    detail: "Content derived from the knowledge versions above.",
  });

  if (content.contentType === "blog") {
    steps.push({
      level: "blog_article",
      label: content.title,
      referenceId: content._id,
      detail: "Blog article.",
    });
  } else {
    steps.push({
      level: "linkedin_post",
      label: content.title,
      referenceId: content._id,
      detail: "Native LinkedIn post derived from its parent article.",
    });
  }

  return steps;
}

/** True only when every provenance hop needed for publishing exists. */
export function hasCompleteProvenance(
  content: Pick<ContentItem, "sourceIds" | "knowledgeIds">,
): boolean {
  return (content.sourceIds?.length ?? 0) > 0 && (content.knowledgeIds?.length ?? 0) > 0;
}

/** Group provenance edges by content id (for list rendering). */
export function groupProvenanceByContent(
  edges: ContentProvenanceEdge[],
): Record<string, ContentProvenanceEdge[]> {
  const out: Record<string, ContentProvenanceEdge[]> = {};
  for (const edge of edges) {
    (out[edge.contentId] ??= []).push(edge);
  }
  return out;
}
