// ---------------------------------------------------------------------------
// Atlas Intelligence — public article (/blog/:slug)
//
// Drafts can never leak: getPublishedArticleBySlug() filters on status =
// 'published', so an unpublished slug is indistinguishable from a missing one.
// The body is rendered as structured blocks (never dangerouslySetInnerHTML) —
// generated content is untrusted input.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { formatDate } from "@/components/atlas-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { parseArticleBody, readingMinutes } from "@/lib/blog/render";
import {
  articleUrl,
  getPublishedArticleBySlug,
  listRelatedArticles,
  type PublishedArticle,
  type RelatedArticle,
} from "@/lib/blog/queries";
import { applyArticleSeo, clearArticleSeo } from "@/lib/blog/seo";
import { categoryBySlug } from "@/lib/blog/taxonomy";
import { ctaById } from "@/lib/blog/cta";
import { ArticleArtwork } from "@/components/blog/ArticleArtwork";
import { BlogVideoCard } from "@/components/blog/BlogVideoCard";

type State =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "ready"; article: PublishedArticle };

export default function BlogPost() {
  const { slug } = useParams<{ slug: string }>();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [related, setRelated] = useState<RelatedArticle[]>([]);

  useEffect(() => {
    let active = true;
    if (!slug) return;
    getPublishedArticleBySlug(slug).then((article) => {
      if (!active) return;
      if (!article) {
        setState({ kind: "missing" });
        return;
      }
      setState({ kind: "ready", article });

      const seo = article.seo ?? {};
      const image =
        (typeof seo.ogImage === "string" && seo.ogImage) ||
        article.youtubeThumbnailUrl ||
        article.socialImage ||
        article.heroImage ||
        null;
      applyArticleSeo({
        title: article.title,
        description:
          (typeof seo.description === "string" && seo.description) ||
          article.summary ||
          article.title,
        canonicalUrl:
          (typeof seo.canonicalUrl === "string" && seo.canonicalUrl) ||
          articleUrl(article.slug),
        publishedAt: article.publishedAt,
        updatedAt: article.updatedAt,
        keywords: article.tags.length ? article.tags : undefined,
        imageUrl: image,
        author: article.author ?? undefined,
        ogTitle: typeof seo.ogTitle === "string" ? seo.ogTitle : undefined,
        ogDescription:
          typeof seo.ogDescription === "string" ? seo.ogDescription : undefined,
        siteName: "Atlas Intelligence",
      });

      void listRelatedArticles(article.slug, 3).then((rows) => {
        if (active) setRelated(rows);
      });
    });
    return () => {
      active = false;
      clearArticleSeo();
    };
  }, [slug]);

  // A route with no slug IS the missing case, so it is DERIVED during render
  // rather than pushed into state from the effect body: the effect's only job
  // is to fetch, and it writes state from the response callback.
  const view: State = slug ? state : { kind: "missing" };

  if (view.kind === "loading") {
    return (
      <main className="mx-auto min-h-screen w-full max-w-3xl px-6 py-16 sm:px-8">
        <p className="text-sm text-muted-foreground">Loading article…</p>
      </main>
    );
  }

  if (view.kind === "missing") {
    return (
      <main className="mx-auto min-h-screen w-full max-w-3xl px-6 py-16 sm:px-8">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          Article not found
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          This article either doesn't exist or hasn't been published yet. Atlas only
          serves approved, published articles.
        </p>
        <Button asChild variant="secondary" size="sm" className="mt-6">
          <Link to="/blog">All articles</Link>
        </Button>
      </main>
    );
  }

  const { article } = view;
  const blocks = parseArticleBody(article.body);
  const minutes = article.readingTime ?? readingMinutes(article.body);
  const category = categoryBySlug(article.category);
  const cta = ctaById((article.ctaId ?? "none") as "A" | "B" | "C" | "none");

  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl px-6 py-14 sm:px-8">
      <Link
        to="/blog"
        className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground"
      >
        ← Atlas Intelligence
      </Link>

      <article className="mt-8">
        <header>
          <div className="flex flex-wrap items-center gap-2">
            {category ? <Badge variant="secondary">{category.label}</Badge> : null}
            {article.publishedAt ? (
              <time
                className="text-xs text-muted-foreground"
                dateTime={new Date(article.publishedAt).toISOString()}
              >
                {formatDate(article.publishedAt)}
              </time>
            ) : null}
            {minutes > 0 ? (
              <span className="text-xs text-muted-foreground">{minutes} min read</span>
            ) : null}
          </div>

          <h1 className="mt-4 text-4xl font-semibold leading-tight tracking-tight text-foreground sm:text-5xl">
            {article.title}
          </h1>
          {article.summary ? (
            <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
              {article.summary}
            </p>
          ) : null}
          {article.author ? (
            <p className="mt-5 text-sm text-muted-foreground">
              By <span className="text-foreground">{article.author}</span>
            </p>
          ) : null}
        </header>

        {/*
          When the package has a published video, the SAME thumbnail that is
          the video's poster becomes the article hero as a video card that opens
          the canonical YouTube URL. Articles without a video keep the plain
          hero artwork they had before.
        */}
        {article.youtubeUrl ? (
          <BlogVideoCard
            thumbnailUrl={article.youtubeThumbnailUrl ?? article.heroImage}
            youtubeUrl={article.youtubeUrl}
            title={article.title}
            className="mt-8"
          />
        ) : article.heroImage ? (
          <ArticleArtwork
            src={article.heroImage}
            alt=""
            motif={article.motif}
            slug={article.slug}
            aspect="16 / 9"
            className="mt-8"
          />
        ) : null}

        <div className="mt-10">
          {blocks.length === 0 ? (
            <p className="text-sm text-muted-foreground">This article has no body content.</p>
          ) : (
            <div className="prose-atlas space-y-5">
              {blocks.map((block, i) => {
                if (block.kind === "heading") {
                  return block.level === 2 ? (
                    <h2
                      key={i}
                      className="pt-4 text-2xl font-medium tracking-tight text-foreground"
                    >
                      {block.text}
                    </h2>
                  ) : (
                    <h3 key={i} className="pt-2 text-xl font-medium text-foreground">
                      {block.text}
                    </h3>
                  );
                }
                if (block.kind === "bullet") {
                  return (
                    <ul
                      key={i}
                      className="list-disc space-y-2 pl-6 text-base leading-relaxed text-foreground/90"
                    >
                      {block.items.map((item, j) => (
                        <li key={j}>{item}</li>
                      ))}
                    </ul>
                  );
                }
                if (block.kind === "quote") {
                  return (
                    <blockquote
                      key={i}
                      className="border-l-2 border-border pl-4 text-base italic leading-relaxed text-muted-foreground"
                    >
                      {block.text}
                    </blockquote>
                  );
                }
                return (
                  <p key={i} className="text-base leading-relaxed text-foreground/90">
                    {block.text}
                  </p>
                );
              })}
            </div>
          )}
        </div>

        {article.tags.length > 0 ? (
          <div className="mt-10 flex flex-wrap items-center gap-2 border-t border-border pt-6">
            <span className="text-xs uppercase tracking-[0.15em] text-muted-foreground">
              Topics
            </span>
            {article.tags.map((tag) => (
              <Badge key={tag} variant="outline">
                {tag}
              </Badge>
            ))}
          </div>
        ) : null}

        {cta ? (
          <aside className="mt-10 rounded-lg border border-border bg-card p-6 sm:p-8">
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">
              {cta.headline}
            </h2>
            <p className="mt-3 text-base leading-relaxed text-muted-foreground">
              {cta.body}
            </p>
            <Button asChild className="mt-6">
              <Link to={cta.to}>{cta.action}</Link>
            </Button>
          </aside>
        ) : null}
      </article>

      {related.length > 0 ? (
        <section aria-labelledby="related-heading" className="mt-16">
          <h2
            id="related-heading"
            className="text-2xl font-semibold tracking-tight text-foreground"
          >
            Related reading
          </h2>
          <ul className="mt-6 grid gap-6 sm:grid-cols-3">
            {related.map((item) => (
              <li key={item.slug}>
                <Link
                  to={`/blog/${item.slug}`}
                  className="group flex h-full flex-col rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/40"
                >
                  <span className="text-xs text-muted-foreground">
                    {categoryBySlug(item.category)?.label ?? "Atlas Intelligence"}
                    {item.readingTime ? ` · ${item.readingTime} min` : ""}
                  </span>
                  <span className="mt-2 text-sm font-semibold leading-snug text-foreground group-hover:underline">
                    {item.title}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <footer className="mt-16 border-t border-border pt-8">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Published by Atlas. Articles are reviewed and approved by a human before
          publication.
        </p>
        <Button asChild variant="secondary" size="sm" className="mt-5">
          <Link to="/blog">All articles</Link>
        </Button>
      </footer>
    </main>
  );
}
