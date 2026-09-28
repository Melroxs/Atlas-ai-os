// @vitest-environment jsdom
//
// Content Studio — the parts that must not regress silently:
//   * slug/keyword derivation from a topic (pure, deterministic);
//   * the blog video card, which is the visible half of the two-way
//     blog <-> YouTube relationship (§11 / §22).
//
// The card is rendered with react-dom/server, matching this repo's preference
// for testing pure output rather than mounting a router or a data layer.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BlogVideoCard } from "@/components/blog/BlogVideoCard";
import { keywordsForTopic, slugifyTopic } from "./studio-api";

describe("slugifyTopic", () => {
  it("produces a URL-safe slug", () => {
    expect(slugifyTopic("Why Insurance Supplements Get Missed")).toBe(
      "why-insurance-supplements-get-missed",
    );
  });

  it("strips punctuation rather than encoding it", () => {
    expect(slugifyTopic("Supplements: what's actually missed?")).toBe(
      "supplements-whats-actually-missed",
    );
  });

  it("never returns a leading or trailing dash, and never an empty string", () => {
    const slug = slugifyTopic("  -- Roofing & Restoration --  ");
    expect(slug.startsWith("-")).toBe(false);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug.length).toBeGreaterThan(0);
  });

  it("is bounded so a long topic cannot produce an unbounded URL", () => {
    expect(slugifyTopic("a".repeat(200)).length).toBeLessThanOrEqual(80);
  });
});

describe("keywordsForTopic", () => {
  it("keeps meaningful words and drops stop words", () => {
    expect(keywordsForTopic("Why insurance supplements get missed")).toEqual([
      "insurance",
      "supplements",
      "get",
      "missed",
    ]);
  });

  it("never duplicates a keyword", () => {
    const keywords = keywordsForTopic("roofing roofing roofing");
    expect(keywords).toEqual(["roofing"]);
  });

  it("returns nothing rather than inventing a keyword", () => {
    expect(keywordsForTopic("why how what the a")).toEqual([]);
  });
});

describe("BlogVideoCard", () => {
  it("renders nothing when the article has no published video", () => {
    const html = renderToStaticMarkup(
      <BlogVideoCard thumbnailUrl={null} youtubeUrl={null} title="No video" />,
    );
    expect(html).toBe("");
  });

  it("links to the exact canonical video, in a new tab, without leaking a referrer", () => {
    const html = renderToStaticMarkup(
      <BlogVideoCard
        thumbnailUrl="https://cdn.example.com/thumb.jpg"
        youtubeUrl="https://www.youtube.com/watch?v=abc123"
        title="Why supplements get missed"
      />,
    );
    expect(html).toContain('href="https://www.youtube.com/watch?v=abc123"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('src="https://cdn.example.com/thumb.jpg"');
  });

  it("still renders a playable card when only the URL is known", () => {
    const html = renderToStaticMarkup(
      <BlogVideoCard
        thumbnailUrl={null}
        youtubeUrl="https://www.youtube.com/watch?v=abc123"
        title="Why supplements get missed"
      />,
    );
    // A labelled surface, never a fabricated image.
    expect(html).toContain("Video");
    expect(html).not.toContain("<img");
  });

  it("carries the article title so the link is announced meaningfully", () => {
    const html = renderToStaticMarkup(
      <BlogVideoCard
        thumbnailUrl={null}
        youtubeUrl="https://www.youtube.com/watch?v=abc123"
        title="Why supplements get missed"
      />,
    );
    expect(html).toContain("Watch the video: Why supplements get missed");
  });
});
