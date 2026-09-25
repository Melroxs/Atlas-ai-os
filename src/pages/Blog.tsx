// ---------------------------------------------------------------------------
// Atlas Blog — public index (/blog)
//
// Reads ONLY published blog articles (see src/lib/blog/queries.ts). The empty
// state is honest: Atlas does not fabricate articles to make the page look
// populated.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { Link } from "react-router";
import { formatDate } from "@/components/atlas-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { applyBlogIndexSeo, clearArticleSeo } from "@/lib/blog/seo";
import {
  listPublishedArticles,
  type PublishedArticleSummary,
} from "@/lib/blog/queries";

export default function Blog() {
  const [articles, setArticles] = useState<PublishedArticleSummary[] | null>(null);

  useEffect(() => {
    let active = true;
    listPublishedArticles(60).then((rows) => {
      if (!active) return;
      setArticles(rows);
      applyBlogIndexSeo(rows.length);
    });
    return () => {
      active = false;
      clearArticleSeo();
    };
  }, []);

  const loading = articles === null;

  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl px-6 py-16 sm:px-8">
      <header className="border-b border-border pb-10">
        <Link
          to="/"
          className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground"
        >
          Atlas
        </Link>
        <h1 className="mt-6 text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
          Atlas Blog
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted-foreground">
          Field notes on restoration operations, regulatory change and AI workforce
          intelligence — written from Atlas's authoritative-source library, not from
          thin air.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button asChild variant="secondary" size="sm">
            <Link to="/pricing">See Atlas plans</Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link to="/">Back to Atlas</Link>
          </Button>
        </div>
      </header>

      {loading ? (
        <p className="py-16 text-sm text-muted-foreground">Loading articles…</p>
      ) : articles.length === 0 ? (
        <div className="py-16">
          <h2 className="text-lg font-medium text-foreground">No articles published yet</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Every Atlas article is generated from the knowledge library, validated, and
            explicitly approved by a human before it appears here. Nothing is published
            automatically, so this page stays empty until that pipeline has run.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {articles.map((article) => (
            <li key={article.slug} className="py-8">
              <Link to={`/blog/${article.slug}`} className="group block">
                <div className="flex flex-wrap items-center gap-2">
                  {article.jurisdiction ? (
                    <Badge variant="secondary">{article.jurisdiction}</Badge>
                  ) : null}
                  {article.industry ? (
                    <Badge variant="outline">{article.industry}</Badge>
                  ) : null}
                  {article.publishedAt ? (
                    <span className="text-xs text-muted-foreground">
                      {formatDate(article.publishedAt)}
                    </span>
                  ) : null}
                </div>
                <h2 className="mt-3 text-2xl font-medium tracking-tight text-foreground group-hover:underline">
                  {article.title}
                </h2>
                {article.summary ? (
                  <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                    {article.summary}
                  </p>
                ) : null}
                <span className="mt-3 inline-block text-sm font-medium text-foreground">
                  Read the article →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
