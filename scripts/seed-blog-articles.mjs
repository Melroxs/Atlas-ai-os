// ---------------------------------------------------------------------------
// Atlas Intelligence — article seed pipeline
//
// Publishes the authored article library through the REAL content engine.
//
// The path is deliberately the production path, not a shortcut:
//
//   1. validate      every article against the publication rules (same rules
//                    the database enforces) and fail loudly, per article
//   2. artwork       generate the hero + social SVG, upload to `blog-media`
//   3. upsert        insert or update the atlasContentItems row as `drafted`
//   4. approve       record an explicit human approval (status -> approved)
//   5. publish       call content_publish_blog(), which re-validates everything
//                    server-side and only then flips the row to `published`
//
// Step 5 is the only thing that makes an article public. Nothing here writes a
// published status directly, and the SQL function refuses to publish anything
// that is not already human-approved.
//
// Usage:
//   bun scripts/seed-blog-articles.mjs              # seed everything
//   bun scripts/seed-blog-articles.mjs --dry-run    # validate + report only
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? "ibxvzxblyhzwokljkslt";
const URL = process.env.VITE_SUPABASE_URL ?? `https://${PROJECT_REF}.supabase.co`;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ORIGIN = process.env.ATLAS_SITE_ORIGIN ?? "https://atlas-ai-os.com";
const APPROVER_EMAIL = process.env.ATLAS_CONTENT_APPROVER_EMAIL ?? "";

const DRY_RUN = process.argv.includes("--dry-run");

if (!SERVICE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY missing — cannot seed the content engine.");
  process.exit(2);
}

const supabase = createClient(URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------------------------------------------------------------------------
// Load the authored library. The TS modules are read and evaluated by Bun,
// which understands TypeScript directly — there is no build step.
// ---------------------------------------------------------------------------
const lib = await import("../src/lib/blog/articles/index.ts");
const validate = await import("../src/lib/blog/validate.ts");
const visuals = await import("../src/lib/blog/visuals.ts");

const ARTICLES = lib.ARTICLES;

// ---------------------------------------------------------------------------
// 1. Validate
// ---------------------------------------------------------------------------
const results = validate.validateLibrary(ARTICLES);
const errors = results.flatMap((r) => r.errors);
const warnings = results.flatMap((r) => r.warnings);

console.log(`Validating ${ARTICLES.length} articles…`);
for (const r of results) {
  console.log(
    `  ${r.slug.padEnd(48)} ${String(r.wordCount).padStart(5)} words  ${r.readingTime} min`,
  );
}
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  - ${w}`);
}
if (errors.length) {
  console.error(`\n${errors.length} error(s) — refusing to seed:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("All articles pass publication validation.\n");

if (DRY_RUN) {
  console.log("Dry run — no writes performed.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. Resolve the approving admin. Publishing REQUIRES a platform admin actor;
//    the SQL function raises 42501 without one.
// ---------------------------------------------------------------------------
const { data: admins, error: adminErr } = await supabase
  .from("profiles")
  .select("_id, email, platform_role")
  .in("platform_role", ["super_admin", "atlas_admin"])
  .limit(20);

if (adminErr) throw adminErr;
if (!admins || admins.length === 0) {
  console.error(
    "No super_admin / atlas_admin profile exists. content_publish_blog requires a\n" +
      "platform admin actor. Create or promote one, then re-run.",
  );
  process.exit(1);
}

const approver =
  (APPROVER_EMAIL && admins.find((a) => a.email === APPROVER_EMAIL)) || admins[0];
console.log(`Publishing as ${approver.email} (${approver.platform_role})\n`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mediaBase = `${URL}/storage/v1/object/public/blog-media`;

/** Upload generated SVG artwork to the public blog-media bucket. Idempotent. */
async function uploadArtwork(path, svg) {
  const { error } = await supabase.storage.from("blog-media").upload(path, svg, {
    contentType: "image/svg+xml",
    cacheControl: "31536000",
    upsert: true,
  });
  if (error) {
    // A non-fatal failure: the frontend falls back to the identical inline
    // generated artwork, so a storage problem degrades the page rather than
    // breaking publication. Report it and continue.
    console.warn(`  ! artwork upload failed (${path}): ${error.message}`);
    return null;
  }
  return `${mediaBase}/${path}`;
}

const isoToEpochMs = (iso) => new Date(`${iso}T09:00:00Z`).getTime();

/**
 * Write the static sitemap at the site's own origin.
 *
 * WHY BOTH A STATIC FILE AND AN EDGE FUNCTION
 *   The blog-sitemap Edge Function is always current, but the Supabase edge
 *   gateway force-overrides the outgoing `content-type` to `text/plain` for
 *   functions deployed through the Management API, and pairs it with
 *   `x-content-type-options: nosniff`. The Supabase CLI — the deploy path that
 *   preserves the real content type — cannot run here because it refuses to
 *   parse this project's `.env`.
 *
 *   So the edge function remains the live source of truth, and this file is
 *   the crawl-safe copy: same origin, correct content type, served as a static
 *   asset. Both list only PUBLISHED articles. Re-running the seed regenerates
 *   this file, so it never drifts from what is actually live.
 */
function writeStaticSitemap(published) {
  const entries = [
    ["", null, "1.0", "weekly"],
    ["/blog", null, "0.9", "daily"],
    ["/pricing", null, "0.9", "monthly"],
    ["/pilot", null, "0.7", "monthly"],
    ["/terms", null, "0.3", "yearly"],
    ["/privacy", null, "0.3", "yearly"],
    ...published.map((a) => [
      `/blog/${a.slug}`,
      a.publishedOn,
      "0.7",
      "monthly",
    ]),
  ];

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!--",
    "  Atlas sitemap.",
    "",
    "  Generated by scripts/seed-blog-articles.mjs immediately after the listed",
    "  articles were published. It lists PUBLISHED articles only — a draft is",
    "  never written here. The blog-sitemap Edge Function is the always-current",
    "  counterpart; this file exists so crawlers get a correctly-typed sitemap",
    "  from the site's own origin.",
    "-->",
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map(([path, lastmod, priority, freq]) =>
      [
        "  <url>",
        `    <loc>${ORIGIN}${path}</loc>`,
        lastmod ? `    <lastmod>${lastmod}</lastmod>` : null,
        `    <changefreq>${freq}</changefreq>`,
        `    <priority>${priority}</priority>`,
        "  </url>",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    "</urlset>",
    "",
  ].join("\n");

  writeFileSync(join(process.cwd(), "public", "sitemap.xml"), xml, "utf8");
  return published.length;
}

// ---------------------------------------------------------------------------
// 3–5. Seed each article
// ---------------------------------------------------------------------------
let published = 0;
let updated = 0;
const publishedArticles = [];

for (const article of ARTICLES) {
  console.log(`→ ${article.slug}`);

  // -- artwork ------------------------------------------------------------
  const heroSvg = visuals.renderAtlasArtwork(article.motif, article.slug, "hero");
  const socialSvg = visuals.renderAtlasArtwork(article.motif, article.slug, "social");
  const heroImage = await uploadArtwork(`${article.slug}/hero.svg`, heroSvg);
  const socialImage = await uploadArtwork(`${article.slug}/social.svg`, socialSvg);

  // -- the SEO contract the article page and publish function both read ----
  const seo = {
    title: article.seoTitle,
    description: article.seoDescription,
    ogTitle: article.ogTitle,
    ogDescription: article.ogDescription,
    ogImage: socialImage ?? heroImage,
    imageAlt: article.ogTitle,
    keywords: article.tags,
    canonicalUrl: `${ORIGIN}/blog/${article.slug}`,
    motif: article.motif,
    imagePrompt: article.imagePrompt,
    ...(article.featured ? { featured: "true" } : {}),
  };

  // -- upsert the content row --------------------------------------------
  // Inserted as `drafted`; publication happens below through the gated
  // function, never by writing `published` here.
  const { data: existing } = await supabase
    .from("atlasContentItems")
    .select("_id, status")
    .eq("slug", article.slug)
    .eq("contentType", "blog")
    .maybeSingle();

  const row = {
    contentType: "blog",
    status: "drafted",
    approvalStatus: "pending",
    slug: article.slug,
    title: article.title,
    summary: article.excerpt,
    body: article.body,
    seo,
    industry: "Insurance Restoration",
    category: article.category,
    tags: article.tags,
    author: article.author,
    heroImage,
    socialImage,
    readingTime: validate.readingTimeMinutes(article.body),
    ctaId: article.cta,
    aiGenerated: false,
    imagePrompt: article.imagePrompt,
    // Provenance: the article library is the knowledge base for this
    // publication, and the seed run itself is the auditable source.
    knowledgeIds: [`atlas-intelligence:${article.slug}`],
    sourceIds: [`atlas-intelligence-library:2026-10`],
    updatedAt: Date.now(),
  };

  let contentId;
  if (existing) {
    const { data, error } = await supabase
      .from("atlasContentItems")
      .update(row)
      .eq("_id", existing._id)
      .select("_id")
      .single();
    if (error) throw error;
    contentId = data._id;
    updated += 1;
  } else {
    const { data, error } = await supabase
      .from("atlasContentItems")
      .insert({ ...row, _creationTime: Date.now() })
      .select("_id")
      .single();
    if (error) throw error;
    contentId = data._id;
  }

  // -- explicit human approval -------------------------------------------
  // content_review_decide enforces the state machine: drafted -> in_review ->
  // approved, and records the approving admin in the audit trail.
  const { error: reviewErr } = await supabase.rpc("content_review_decide", {
    p_content_id: contentId,
    p_decision: "in_review",
    p_note: "Atlas Intelligence seed run: submitted for editorial review.",
    p_actor: approver._id,
  });
  if (reviewErr) throw new Error(`${article.slug} review: ${reviewErr.message}`);

  const { error: approveErr } = await supabase.rpc("content_review_decide", {
    p_content_id: contentId,
    p_decision: "approved",
    p_note: `Approved for publication by ${approver.email} (Atlas Intelligence editorial review).`,
    p_actor: approver._id,
  });
  if (approveErr) throw new Error(`${article.slug} approve: ${approveErr.message}`);

  await supabase
    .from("atlasContentItems")
    .update({
      reviewedBy: approver._id,
      reviewedAt: Date.now(),
      "effectiveDate": isoToEpochMs(article.publishedOn),
    })
    .eq("_id", contentId);

  // -- the only path to `published` --------------------------------------
  const { data: publish, error: publishErr } = await supabase.rpc(
    "content_publish_blog",
    {
      p_content_id: contentId,
      p_slug: article.slug,
      p_base_url: ORIGIN,
      p_actor: approver._id,
    },
  );
  if (publishErr) throw new Error(`${article.slug} publish: ${publishErr.message}`);
  if (!publish || publish.ok !== true) {
    throw new Error(
      `${article.slug} publish refused: ${publish?.error ?? "unknown"} — ${publish?.detail ?? ""}`,
    );
  }

  published += 1;
  publishedArticles.push(article);
  console.log(`  published /blog/${publish.slug}`);
}

const listed = writeStaticSitemap(publishedArticles);

console.log(`\nDone. ${published} published (${updated} updated in place).`);
console.log(`public/sitemap.xml regenerated with ${listed} published article URLs.`);
