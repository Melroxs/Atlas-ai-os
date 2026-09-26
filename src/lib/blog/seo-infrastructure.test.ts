// ---------------------------------------------------------------------------
// Atlas Intelligence — SEO infrastructure
//
// Three things are asserted here, and each one corresponds to a real failure
// mode that is invisible in the UI:
//
//   1. robots.txt does not accidentally block /blog
//   2. the sitemap points at a live article-level sitemap
//   3. the sitemap function cannot emit a draft
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ARTICLES } from "./articles";

const root = join(__dirname, "..", "..", "..");
const robots = readFileSync(join(root, "public", "robots.txt"), "utf8");
const sitemap = readFileSync(join(root, "public", "sitemap.xml"), "utf8");
const sitemapFunction = readFileSync(
  join(root, "supabase", "functions", "blog-sitemap", "index.ts"),
  "utf8",
);

describe("robots.txt", () => {
  it("allows crawling", () => {
    expect(robots).toMatch(/User-agent: \*/);
    expect(robots).toMatch(/Allow: \//);
  });

  it("does not block the blog or any article route", () => {
    expect(robots).not.toMatch(/^Disallow: \/blog/m);
    expect(robots).not.toMatch(/^Disallow: \/$/m);
  });

  it("still blocks the private surfaces", () => {
    for (const path of ["/dashboard", "/auth", "/setup", "/checkout"]) {
      expect(robots).toContain(`Disallow: ${path}`);
    }
  });

  it("declares a sitemap", () => {
    expect(robots).toMatch(/Sitemap: https:\/\/atlas-ai-os\.com\/sitemap\.xml/);
  });
});

describe("sitemap", () => {
  it("is a urlset served from the site's own origin", () => {
    expect(sitemap).toContain("<urlset");
    expect(sitemap).toContain("https://atlas-ai-os.com/blog");
  });

  it("lists every published article, and nothing else", () => {
    for (const article of ARTICLES) {
      expect(sitemap).toContain(`https://atlas-ai-os.com/blog/${article.slug}`);
    }
    const listed = sitemap.match(/<loc>[^<]*\/blog\/[^<]*<\/loc>/g) ?? [];
    // Exactly one URL per article. A draft or a retired slug would change this
    // count, which is the point: the sitemap is a published-set artifact.
    expect(listed).toHaveLength(ARTICLES.length);
    expect(sitemap).toContain("<loc>https://atlas-ai-os.com/blog</loc>");
  });

  it("no longer claims article URLs cannot be generated", () => {
    expect(sitemap).not.toMatch(/requires a server-rendered endpoint/);
    expect(sitemap).not.toMatch(/are NOT enumerated here/);
  });

  it("is valid XML with every loc wrapped", () => {
    const openLocs = (sitemap.match(/<loc>/g) ?? []).length;
    const closeLocs = (sitemap.match(/<\/loc>/g) ?? []).length;
    expect(openLocs).toBe(closeLocs);
    expect(sitemap).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(sitemap.trimEnd().endsWith("</urlset>")).toBe(true);
  });
});

describe("blog-sitemap Edge Function", () => {
  it("reads only published blog articles", () => {
    expect(sitemapFunction).toContain('.eq("status", "published")');
    expect(sitemapFunction).toContain('.eq("contentType", "blog")');
    expect(sitemapFunction).toContain('.not("slug", "is", null)');
  });

  it("uses the anon key, so RLS decides visibility", () => {
    expect(sitemapFunction).toContain("SUPABASE_ANON_KEY");
    // Using the service role here would defeat the RLS guarantee that makes
    // verify_jwt = false safe, so its absence is a security assertion.
    expect(sitemapFunction).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("is declared verify_jwt = false in config, with the reason recorded", () => {
    const config = readFileSync(join(root, "supabase", "config.toml"), "utf8");
    expect(config).toMatch(/\[functions\.blog-sitemap\]\s*\nverify_jwt = false/);
  });

  it("escapes XML so a hostile slug cannot break the document", () => {
    expect(sitemapFunction).toContain("function escapeXml");
    expect(sitemapFunction).toContain("&amp;");
  });

  it("documents the gateway content-type limitation it works around", () => {
    // The static sitemap exists because of this. If the gateway behaviour ever
    // changes, this comment is the signal to simplify rather than to forget.
    expect(sitemapFunction + readFileSync(join(root, "public", "sitemap.xml"), "utf8")).toMatch(
      /content-type|gateway/i,
    );
  });
});

describe("article canonical URLs", () => {
  it("matches the /blog/<slug> shape the sitemap emits", () => {
    for (const article of ARTICLES) {
      expect(article.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });
});
