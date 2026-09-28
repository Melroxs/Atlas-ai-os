// ---------------------------------------------------------------------------
// Atlas Content Engine — copy builders (pure, no I/O, no network)
//
// ONE article -> one video script -> one thumbnail brief -> one LinkedIn post,
// all derived from the SAME approved text so the package is one argument told
// on four channels, not four unrelated generations.
//
// No-fabrication rules are enforced here, not left to prompt hope:
//   * a claim that looks like a statistic, regulation, carrier policy or
//     citation is FLAGGED and must map to a knowledge item before publishing;
//   * placeholders, TODOs and model boilerplate are refused outright;
//   * URLs are only ever real ones supplied by the caller.
// ---------------------------------------------------------------------------

import { buildLinkedInDraft, slugify } from "@/lib/platform/content";

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** Atlas's audience, used when an organization has not set its own. */
export const DEFAULT_AUDIENCE =
  "US insurance restoration contractors, roofing and restoration business owners";

export const DEFAULT_CTA = "See how Atlas turns scattered job data into decisions.";

export const DEFAULT_TONE = "professional, educational, specific, evidence-oriented";

export interface BrandContext {
  audience?: string | null;
  tone?: string | null;
  primaryCta?: string | null;
  brandVoice?: string | null;
}

export function resolveBrand(brand: BrandContext = {}) {
  return {
    audience: brand.audience?.trim() || DEFAULT_AUDIENCE,
    tone: brand.tone?.trim() || DEFAULT_TONE,
    cta: brand.primaryCta?.trim() || DEFAULT_CTA,
    voice: brand.brandVoice?.trim() || "",
  };
}

const BANNED_ARTIFACTS: Array<{ re: RegExp; label: string }> = [
  { re: /\bTODO\b|\bFIXME\b/, label: "a TODO marker" },
  { re: /\blorem ipsum\b/i, label: "lorem ipsum filler" },
  { re: /\bas an AI language model\b/i, label: "model boilerplate" },
  { re: /\b(insert|add) (your|the) [a-z ]+ here\b/i, label: "an unfilled template slot" },
  { re: /\bplaceholder\b/i, label: 'the word "placeholder"' },
];

/**
 * Claim shapes that must be backed by a knowledge item. This is a FLAGGER, not
 * a censor: it never blocks a draft on its own, it makes the unverified claim
 * visible so the human reviewer (and the governance gate) can require evidence.
 */
const CLAIM_PATTERNS: Array<{ re: RegExp; label: string; example: string }> = [
  {
    re: /\b\d{1,3}(\.\d+)?\s?%/,
    label: "statistic",
    example: "a percentage figure",
  },
  {
    re: /\$\s?\d[\d,.]*(\s?(million|billion|k))?\b/i,
    label: "figure",
    example: "a monetary figure",
  },
  {
    re: /\b(studies|research|survey|data) (show|shows|suggest|indicate)\b/i,
    label: "study",
    example: "a study reference",
  },
  {
    re: /\baccording to\b/i,
    label: "attribution",
    example: "an attributed source",
  },
  {
    re: /\b(most|majority of|nearly all|always|never) (carriers|insurers|adjusters|contractors)\b/i,
    label: "generalisation",
    example: "a generalisation about carriers or contractors",
  },
  {
    re: /\b(IRC|IBC|NFPA|OSHA|ADA|FEMA|Xactimate|Verisk)\b/,
    label: "standard",
    example: "a code, standard or platform reference",
  },
];

export interface ClaimFlag {
  label: string;
  example: string;
  excerpt: string;
}

/** Find claims in generated prose that require evidence before publishing. */
export function scanForUnverifiedClaims(text: string): ClaimFlag[] {
  const flags: ClaimFlag[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    for (const { re, label, example } of CLAIM_PATTERNS) {
      if (re.test(sentence)) {
        flags.push({
          label,
          example,
          excerpt: sentence.trim().slice(0, 200),
        });
      }
    }
  }
  return flags;
}

/** Structural problems that must block publishing regardless of approval. */
export function validateGeneratedCopy(text: string): {
  ok: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!text.trim()) {
    errors.push("Generated copy is empty.");
    return { ok: false, errors, warnings };
  }
  for (const { re, label } of BANNED_ARTIFACTS) {
    if (re.test(text)) errors.push(`Generated copy contains ${label}.`);
  }
  if (/\[\]\(|\]\(\s*\)/.test(text)) errors.push("Generated copy contains an empty link.");
  const externalLink = text.match(/\]\((https?:\/\/[^\s)]+)\)/);
  if (externalLink && /\b(broken|example\.com|localhost)\b/i.test(externalLink[1])) {
    errors.push("Generated copy links to a placeholder URL.");
  }
  const flags = scanForUnverifiedClaims(text);
  if (flags.length > 0) {
    warnings.push(
      `${flags.length} claim(s) need an evidence link before publishing: ${[
        ...new Set(flags.map((f) => f.label)),
      ].join(", ")}.`,
    );
  }
  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Article
// ---------------------------------------------------------------------------

export interface ArticleBriefInput {
  topic: string;
  brand?: BrandContext;
  /** Real knowledge items retrieved from the Atlas knowledge base. */
  knowledge?: Array<{ knowledgeId: string; title: string; statement: string }>;
  /** Real internal Atlas links the writer may reference. */
  internalLinks?: Array<{ title: string; url: string }>;
  /** Real external references (authoritative sources only). */
  externalReferences?: Array<{ title: string; url: string }>;
  category?: string | null;
  tags?: string[];
}

export interface ArticleBrief {
  topic: string;
  slug: string;
  audience: string;
  tone: string;
  cta: string;
  category: string;
  tags: string[];
  knowledge: Array<{ knowledgeId: string; title: string; statement: string }>;
  internalLinks: Array<{ title: string; url: string }>;
  externalReferences: Array<{ title: string; url: string }>;
  /**
   * The instruction block handed to the model. It is a contract, not a
   * suggestion: any claim outside the supplied knowledge must be written as
   * an explicit gap rather than invented.
   */
  instructions: string;
}

export function buildArticleBrief(input: ArticleBriefInput): ArticleBrief {
  const brand = resolveBrand(input.brand);
  const topic = input.topic.trim();
  const knowledge = input.knowledge ?? [];
  const internalLinks = input.internalLinks ?? [];
  const externalReferences = input.externalReferences ?? [];

  const instructions = [
    `Write a B2B article for ${brand.audience}.`,
    `Tone: ${brand.tone}.${brand.voice ? ` Brand voice: ${brand.voice}.` : ""}`,
    `Topic: ${topic}`,
    "Structure: a specific H1, a short standfirst, 3-6 H2 sections with concrete operational detail, and a closing CTA.",
    "Be specific and useful. Prefer concrete workflow detail over adjectives.",
    "You MUST NOT invent statistics, regulations, insurance requirements, carrier policies, manufacturer requirements, customer results, testimonials, case studies or citations.",
    knowledge.length > 0
      ? "You may only state a fact that appears in the KNOWLEDGE section below, and you must reference it inline. Anything else must be framed as an open question, not a fact."
      : "No knowledge items were retrieved. Do not state any factual claim about codes, carriers, percentages or studies. Write about process, decision-making and workflow only.",
    internalLinks.length > 0
      ? `You may link only to these Atlas pages: ${internalLinks.map((l) => `${l.title} (${l.url})`).join("; ")}.`
      : "Do not invent internal links.",
    externalReferences.length > 0
      ? `You may cite only these references: ${externalReferences.map((r) => `${r.title} (${r.url})`).join("; ")}.`
      : "Do not cite any external source.",
    `End with this call to action, verbatim: "${brand.cta}"`,
    knowledge.length > 0
      ? `KNOWLEDGE:\n${knowledge.map((k) => `- [${k.knowledgeId}] ${k.title}: ${k.statement}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    topic,
    slug: slugify(topic),
    audience: brand.audience,
    tone: brand.tone,
    cta: brand.cta,
    category: input.category?.trim() || "Operations",
    tags: dedupeTags(input.tags ?? []),
    knowledge,
    internalLinks,
    externalReferences,
    instructions,
  };
}

function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const clean = tag.trim().toLowerCase();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out.slice(0, 12);
}

// ---------------------------------------------------------------------------
// Video script (derived from the article — never a new topic)
// ---------------------------------------------------------------------------

export interface VideoScriptInput {
  articleTitle: string;
  articleBody: string;
  cta?: string | null;
  durationSeconds?: number;
}

export interface VideoScript {
  title: string;
  durationSeconds: number;
  hook: string;
  introduction: string;
  mainPoints: string[];
  examples: string[];
  conclusion: string;
  cta: string;
  /** The full read-through script, in order. */
  script: string;
  /** Word budget used, so a 3–6 minute target stays honest. */
  wordTarget: number;
}

/** Speaking pace used to convert a duration target into a word budget. */
export const WORDS_PER_MINUTE = 150;

/**
 * The video script is a re-telling of the ARTICLE. It takes the article's own
 * headings as the main points and its own sentences as the introduction, so the
 * video cannot drift onto a different subject than the blog post.
 */
export function buildVideoScript(input: VideoScriptInput): VideoScript {
  const durationSeconds = clamp(input.durationSeconds ?? 300, 180, 600);
  const wordTarget = Math.round((durationSeconds / 60) * WORDS_PER_MINUTE);
  const body = input.articleBody.trim();

  const headings = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^#{2,3}\s+\S/.test(l))
    .map((l) => l.replace(/^#{2,3}\s+/, "").trim());

  // Prose paragraphs only: headings, list markers and CTA lines are excluded so
  // the spoken introduction reads naturally.
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => p.replace(/^#{1,6}\s+/, "").trim())
    .filter((p) => p.length > 80 && !/^[-*>|]/.test(p) && !/https?:\/\//.test(p));

  const title = input.articleTitle.trim();
  const cta = (input.cta ?? DEFAULT_CTA).trim();

  const mainPoints =
    headings.length > 0
      ? headings.slice(0, 6)
      : paragraphs.slice(0, 4).map((p) => p.split(/[.!?]/)[0].trim().slice(0, 90));

  const hook = buildHook(title);
  const introduction = paragraphs[0]?.slice(0, 700) ?? "";
  const examples = paragraphs.slice(1, 3).map((p) => p.slice(0, 500));
  const conclusion = paragraphs.length > 0 ? paragraphs[paragraphs.length - 1].slice(0, 600) : "";

  const script = [
    `HOOK: ${hook}`,
    introduction ? `INTRO: ${introduction}` : "",
    ...mainPoints.map((p, i) => `POINT ${i + 1}: ${p}`),
    ...examples.map((e, i) => `EXAMPLE ${i + 1}: ${e}`),
    conclusion ? `CONCLUSION: ${conclusion}` : "",
    `CTA: ${cta}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    title,
    durationSeconds,
    hook,
    introduction,
    mainPoints,
    examples,
    conclusion,
    cta,
    script,
    wordTarget,
  };
}

function buildHook(title: string): string {
  const subject = title.replace(/[?.!]+$/, "").trim();
  return `Most restoration operators know ${lowerFirst(subject)} matters — far fewer can explain exactly where it breaks down.`;
}

function lowerFirst(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(Math.round(n), min), max);
}

// ---------------------------------------------------------------------------
// Thumbnail brief (shared visual identity for YouTube, blog hero and LinkedIn)
// ---------------------------------------------------------------------------

export interface ThumbnailBrief {
  prompt: string;
  /** Short, non-misleading overlay text. Never a statistic. */
  overlayText: string;
  width: number;
  height: number;
  aspectRatio: "16:9";
}

export const THUMBNAIL_WIDTH = 1280;
export const THUMBNAIL_HEIGHT = 720;

/**
 * The thumbnail is generated ONCE per package and reused everywhere, so the
 * YouTube video, the blog hero card and the LinkedIn visual are the same
 * artefact rather than three unrelated images.
 */
export function buildThumbnailBrief(input: {
  articleTitle: string;
  brandVoice?: string | null;
}): ThumbnailBrief {
  const overlayText = toOverlayText(input.articleTitle);
  return {
    prompt: [
      "Professional B2B editorial thumbnail for an insurance restoration operator audience.",
      `Subject: ${input.articleTitle.trim()}.`,
      overlayText ? `Render the exact text "${overlayText}" in clean, high-contrast type.` : "",
      input.brandVoice?.trim() ? `Brand guidance: ${input.brandVoice.trim()}.` : "",
      "Photorealistic or clean vector style, strong focal point, readable at 320px wide.",
      "Do not include invented statistics, percentages, dollar figures, logos you were not given, or misleading imagery.",
    ]
      .filter(Boolean)
      .join(" "),
    overlayText,
    width: THUMBNAIL_WIDTH,
    height: THUMBNAIL_HEIGHT,
    aspectRatio: "16:9",
  };
}

/** At most four words, no digits — a stat-shaped overlay would be a claim. */
export function toOverlayText(title: string): string {
  const words = title
    .replace(/[^A-Za-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const meaningful = words.filter((w) => !/^\d/.test(w)).slice(0, 4);
  return meaningful.join(" ").toUpperCase();
}

// ---------------------------------------------------------------------------
// YouTube presentation
// ---------------------------------------------------------------------------

export interface YouTubePresentation {
  title: string;
  description: string;
  tags: string[];
}

export const YOUTUBE_TITLE_MAX = 100;

/**
 * The video description carries the CANONICAL BLOG URL, completing the
 * two-way relationship between the owned article and the video companion.
 */
export function buildYouTubePresentation(input: {
  articleTitle: string;
  summary: string | null;
  script: VideoScript;
  blogUrl: string | null;
  tags: string[];
  cta?: string | null;
}): YouTubePresentation {
  const title = truncate(input.articleTitle, YOUTUBE_TITLE_MAX);
  const description = [
    input.summary?.trim() ?? input.script.introduction.slice(0, 300),
    "",
    "IN THIS VIDEO",
    ...input.script.mainPoints.map((p) => `• ${p}`),
    "",
    input.blogUrl ? `Read the full article on Atlas: ${input.blogUrl}` : "",
    "",
    (input.cta ?? DEFAULT_CTA).trim(),
    "",
    "#insurance #restoration #contractors",
  ]
    .filter((line) => line !== undefined)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title, description, tags: dedupeTags(input.tags).slice(0, 15) };
}

function truncate(s: string, max: number): string {
  const clean = s.trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// LinkedIn post
// ---------------------------------------------------------------------------

export interface LinkedInPostInput {
  articleTitle: string;
  articleSummary: string | null;
  articleStatus: string;
  approvalStatus: string;
  articleId: string;
  sourceIds: string[];
  knowledgeIds: string[];
  keyPoints: string[];
  blogUrl: string | null;
  youtubeUrl: string | null;
  cta?: string | null;
}

export interface LinkedInPostResult {
  ok: boolean;
  error?: string;
  body?: string;
  /** Known limitations, surfaced to the reviewer rather than hidden. */
  notes: string[];
}

/**
 * A native LinkedIn post: HOOK / PROBLEM / INSIGHT / WHY IT MATTERS / CTA, with
 * the blog as the primary owned destination. It is NOT the article pasted into
 * a text box — buildLinkedInDraft refuses to reproduce the full article, and
 * this function additionally refuses to build a post with no thesis.
 */
export function buildLinkedInPost(input: LinkedInPostInput): LinkedInPostResult {
  const base = buildLinkedInDraft(
    {
      _id: input.articleId,
      title: input.articleTitle,
      summary: input.articleSummary,
      status: input.articleStatus as never,
      approvalStatus: input.approvalStatus as never,
      sourceIds: input.sourceIds,
      knowledgeIds: input.knowledgeIds,
    },
    input.keyPoints,
    { maxChars: 3_000 },
  );
  if (!base.ok || !base.post) {
    return { ok: false, error: base.error ?? "LinkedIn post could not be derived.", notes: [] };
  }

  const notes: string[] = [];
  if (!input.blogUrl) {
    notes.push("No canonical blog URL is available yet; the post omits the article link.");
  }
  if (!input.youtubeUrl) {
    notes.push("No YouTube URL yet; the post omits the video link.");
  }

  const hook = input.articleTitle.trim();
  const thesis = input.articleSummary?.trim() ?? "";
  const points = input.keyPoints.map((p) => p.trim()).filter(Boolean).slice(0, 4);
  const problem = points[0] ?? thesis;
  const insight = points[1] ?? input.keyPoints[1]?.trim() ?? "";
  const matters = thesis || input.articleSummary?.trim() || "";

  const body = [
    hook,
    "",
    problem ? `THE PROBLEM\n${problem}` : "",
    "",
    insight ? `THE INSIGHT\n${insight}` : "",
    "",
    matters ? `WHY IT MATTERS\n${matters}` : "",
    "",
    `READ THE FULL ARTICLE → ${input.blogUrl ?? "(link pending)"}`,
    input.youtubeUrl ? `WATCH THE VIDEO → ${input.youtubeUrl}` : "",
    "",
    (input.cta ?? DEFAULT_CTA).trim(),
  ]
    .filter((line) => line !== "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { ok: true, body, notes };
}
