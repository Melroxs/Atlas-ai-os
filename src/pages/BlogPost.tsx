// ---------------------------------------------------------------------------
// Atlas Blog — public article (/blog/:slug)
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
import { articleUrl, getPublishedArticleBySlug, type PublishedArticle } from "@/lib/blog/queries";
import { applyArticleSeo, clearArticleSeo } from "@/lib/blog/seo";

type State =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "ready"; article: PublishedArticle };

export default function BlogPost() {
  const { slug } = useParams<{ slug: string }>();
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    if (!slug) {
      setState({ kind: "missing" });
      return;
    }
    getPublishedArticleBySlug(slug).then((article) => {
      if (!active) return;
      if (!article) {
        setState({ kind: "missing" });
        return;
      }
      setState({ kind: "ready", article });

      const seo = article.seo ?? {};
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
        keywords: Array.isArray(seo.keywords) ? (seo.keywords as string[]) : undefined,
      });
    });
    return () => {
      active = false;
      clearArticleSeo();
    };
  }, [slug]);

  if (state.kind === "loading") {
    return (
      <main className="mx-auto min-h-screen w-full max-w-3xl px-6 py-16 sm:px-8">
        <p className="text-sm text-muted-foreground">Loading article…</p>
      </main>
    );
  }

  if (state.kind === "missing") {
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

  const { article } = state;
  const blocks = parseArticleBody(article.body);
  const minutes = readingMinutes(article.body);

  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl px-6 py-16 sm:px-8">
      <Link
        to="/blog"
        className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground"
      >
        ← Atlas Blog
      </Link>

      <article className="mt-8">
        <header className="border-b border-border pb-8">
          <div className="flex flex-wrap items-center gap-2">
            {article.jurisdiction ? <Badge variant="secondary">{article.jurisdiction}</Badge> : null}
            {article.industry ? <Badge variant="outline">{article.industry}</Badge> : null}
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
          <h1 className="mt-4 text-4xl font-semibold leading-tight tracking-tight text-foreground">
            {article.title}
          </h1>
          {article.summary ? (
            <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
              {article.summary}
            </p>
          ) : null}
        </header>

        <div className="prose-atlas mt-10 space-y-5">
          {blocks.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This article has no body content.
            </p>
          ) : (
            blocks.map((block, i) => {
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
                  <ul key={i} className="list-disc space-y-2 pl-6 text-base leading-relaxed text-foreground/90">
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
            })
          )}
        </div>
      </article>

      <footer className="mt-14 border-t border-border pt-8">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Published by Atlas. Articles are generated from Atlas's authoritative-source
          library and reviewed by a human before publication.
        </p>
        <Button asChild variant="secondary" size="sm" className="mt-5">
          <Link to="/blog">All articles</Link>
        </Button>
      </footer>
    </main>
  );
}
