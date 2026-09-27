// ---------------------------------------------------------------------------
// Atlas Intelligence — public index (/blog)
//
// Reads ONLY published blog articles (see src/lib/blog/queries.ts). The empty
// state is honest: Atlas does not fabricate articles to make the page look
// populated.
//
// Layout is a real publication front page — featured article, pillar filter,
// client-side search, card grid, load-more — built from the existing Atlas
// design tokens. No new UI primitives are introduced.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { formatDate } from "@/components/atlas-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { applyBlogIndexSeo, clearArticleSeo } from "@/lib/blog/seo";
import {
  listPublishedArticles,
  type PublishedArticleSummary,
} from "@/lib/blog/queries";
import { CATEGORIES, categoryBySlug, categoryLabel } from "@/lib/blog/taxonomy";
import { ArticleArtwork } from "@/components/blog/ArticleArtwork";

const PAGE_SIZE = 6;

function articleHref(slug: string): string {
  return `/blog/${slug}`;
}

function isFeatured(article: PublishedArticleSummary): boolean {
  return (article.seo as Record<string, unknown> | null)?.featured === "true";
}

function matchesQuery(article: PublishedArticleSummary, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const haystack = [
    article.title,
    article.summary ?? "",
    article.author ?? "",
    ...(article.tags ?? []),
    categoryLabel(article.category) ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

export default function Blog() {
  const [articles, setArticles] = useState<PublishedArticleSummary[] | null>(null);
  const [category, setCategory] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(PAGE_SIZE);

  useEffect(() => {
    let active = true;
    listPublishedArticles(100).then((rows) => {
      if (!active) return;
      setArticles(rows);
      applyBlogIndexSeo(rows.length);
    });
    return () => {
      active = false;
      clearArticleSeo();
    };
  }, []);

  // Reset pagination whenever the visible set changes shape.
  useEffect(() => {
    setVisible(PAGE_SIZE);
  }, [category, query]);

  const all = articles ?? [];
  const featured = useMemo(() => all.find(isFeatured) ?? all[0] ?? null, [all]);

  const filtered = useMemo(() => {
    return all.filter(
      (a) =>
        a.slug !== featured?.slug &&
        (category === "all" || a.category === category) &&
        matchesQuery(a, query),
    );
  }, [all, category, query, featured]);

  const shown = filtered.slice(0, visible);
  const hasMore = filtered.length > shown.length;
  const loading = articles === null;

  // A featured article should still respect an active filter/search.
  const showFeatured =
    featured !== null &&
    (category === "all" || featured.category === category) &&
    matchesQuery(featured, query);

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-6 py-14 sm:px-8">
      <header className="border-b border-border pb-8">
        <Link
          to="/"
          className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground"
        >
          Atlas
        </Link>
        <h1 className="mt-6 text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
          Atlas Intelligence
        </h1>
        <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
          Field intelligence for insurance restoration: claims, evidence, estimating,
          supplements and the revenue hiding in completed work. Written for the people
          who run restoration companies and recover the money in them.
        </p>
      </header>

      {loading ? (
        <p className="py-20 text-sm text-muted-foreground">Loading articles…</p>
      ) : all.length === 0 ? (
        <div className="py-20">
          <h2 className="text-lg font-medium text-foreground">No articles published yet</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Every Atlas article is reviewed and explicitly approved by a human before it
            appears here. Nothing is published automatically, so this page stays empty
            until that approval has happened.
          </p>
          <Button asChild variant="secondary" size="sm" className="mt-6">
            <Link to="/pricing">See Atlas plans</Link>
          </Button>
        </div>
      ) : (
        <>
          {showFeatured && featured ? (
            <section aria-labelledby="featured-heading" className="pt-12">
              <h2
                id="featured-heading"
                className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground"
              >
                Featured
              </h2>
              <Link
                to={articleHref(featured.slug)}
                className="group mt-4 grid gap-8 rounded-lg border border-border bg-card p-6 transition-colors hover:border-primary/40 sm:p-8 md:grid-cols-2"
              >
                <div className="order-2 flex flex-col justify-center md:order-1">
                  <ArticleMeta article={featured} />
                  <h3 className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-foreground group-hover:underline">
                    {featured.title}
                  </h3>
                  {featured.summary ? (
                    <p className="mt-3 text-base leading-relaxed text-muted-foreground">
                      {featured.summary}
                    </p>
                  ) : null}
                  <span className="mt-5 text-sm font-medium text-foreground">
                    Read the article →
                  </span>
                </div>
                <div className="order-1 md:order-2">
                  <ArticleArtwork
                    src={featured.heroImage ?? null}
                    alt=""
                    motif={featured.motif ?? "product"}
                    slug={featured.slug}
                    aspect="16 / 9"
                  />
                </div>
              </Link>
            </section>
          ) : null}

          <section aria-labelledby="library-heading" className="pt-14">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <h2
                id="library-heading"
                className="text-2xl font-semibold tracking-tight text-foreground"
              >
                Latest articles
              </h2>
              <div className="w-full sm:w-72">
                <label htmlFor="blog-search" className="sr-only">
                  Search articles
                </label>
                <input
                  id="blog-search"
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search articles…"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>

            <div
              role="group"
              aria-label="Filter by category"
              className="mt-5 flex flex-wrap gap-2"
            >
              <CategoryPill active={category === "all"} onClick={() => setCategory("all")}>
                All
              </CategoryPill>
              {CATEGORIES.map((c) => (
                <CategoryPill
                  key={c.slug}
                  active={category === c.slug}
                  onClick={() => setCategory(c.slug)}
                  title={c.blurb}
                >
                  {c.label}
                </CategoryPill>
              ))}
            </div>

            {filtered.length === 0 ? (
              <p className="py-14 text-sm text-muted-foreground">
                No articles match that filter. Try another pillar, or clear the search.
              </p>
            ) : (
              <>
                <ul className="mt-8 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
                  {shown.map((article) => (
                    <li key={article.slug}>
                      <Link
                        to={articleHref(article.slug)}
                        className="group flex h-full flex-col rounded-lg border border-border bg-card p-5 transition-colors hover:border-primary/40"
                      >
                        <ArticleArtwork
                          src={article.heroImage ?? null}
                          alt=""
                          motif={article.motif ?? "product"}
                          slug={article.slug}
                          aspect="16 / 9"
                        />
                        <div className="mt-4 flex flex-1 flex-col">
                          <ArticleMeta article={article} />
                          <h3 className="mt-2 text-lg font-semibold leading-snug tracking-tight text-foreground group-hover:underline">
                            {article.title}
                          </h3>
                          {article.summary ? (
                            <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-muted-foreground">
                              {article.summary}
                            </p>
                          ) : null}
                          <span className="mt-4 text-sm font-medium text-foreground">
                            Read →
                          </span>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>

                {hasMore ? (
                  <div className="mt-10 flex justify-center">
                    <Button
                      variant="secondary"
                      onClick={() => setVisible((v) => v + PAGE_SIZE)}
                    >
                      Load more articles ({filtered.length - shown.length} remaining)
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </section>

          <footer className="mt-20 border-t border-border pt-8">
            <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
              Atlas Intelligence is written for restoration professionals. Every article is
              reviewed and approved by a human before publication, and nothing is
              published automatically.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Button asChild variant="secondary" size="sm">
                <Link to="/pricing">See Atlas plans</Link>
              </Button>
              <Button asChild variant="ghost" size="sm">
                <Link to="/">Back to Atlas</Link>
              </Button>
            </div>
          </footer>
        </>
      )}
    </main>
  );
}

function CategoryPill({
  active,
  onClick,
  children,
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={
        active
          ? "rounded-full border border-primary bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
          : "rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
      }
    >
      {children}
    </button>
  );
}

function ArticleMeta({ article }: { article: PublishedArticleSummary }) {
  const label = categoryBySlug(article.category)?.label;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {label ? <Badge variant="secondary">{label}</Badge> : null}
      {article.publishedAt ? (
        <span className="text-xs text-muted-foreground">
          {formatDate(article.publishedAt)}
        </span>
      ) : null}
      {article.readingTime ? (
        <span className="text-xs text-muted-foreground">{article.readingTime} min</span>
      ) : null}
    </div>
  );
}
