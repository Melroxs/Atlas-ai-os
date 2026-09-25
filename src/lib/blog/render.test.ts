import { describe, expect, it } from "vitest";
import { parseArticleBody, readingMinutes, wordCount } from "./render";

describe("blog/render — parseArticleBody", () => {
  it("returns no blocks for empty or missing bodies", () => {
    expect(parseArticleBody(null)).toEqual([]);
    expect(parseArticleBody(undefined)).toEqual([]);
    expect(parseArticleBody("   \n  \n")).toEqual([]);
  });

  it("parses headings, paragraphs, bullets and quotes", () => {
    const blocks = parseArticleBody(
      [
        "## Section one",
        "A first paragraph.",
        "",
        "- first point",
        "- second point",
        "",
        "> A quoted line",
        "",
        "### Nested heading",
      ].join("\n"),
    );

    expect(blocks).toEqual([
      { kind: "heading", level: 2, text: "Section one" },
      { kind: "paragraph", text: "A first paragraph." },
      { kind: "bullet", items: ["first point", "second point"] },
      { kind: "quote", text: "A quoted line" },
      { kind: "heading", level: 3, text: "Nested heading" },
    ]);
  });

  it("never emits HTML — markup stays literal text", () => {
    const blocks = parseArticleBody('<script>alert("x")</script>');
    expect(blocks).toEqual([
      { kind: "paragraph", text: '<script>alert("x")</script>' },
    ]);
  });

  it("treats numbered lines as bullets and flushes them before a paragraph", () => {
    const blocks = parseArticleBody("1. one\n2. two\n\nplain text");
    expect(blocks).toEqual([
      { kind: "bullet", items: ["one", "two"] },
      { kind: "paragraph", text: "plain text" },
    ]);
  });

  it("normalizes CRLF input", () => {
    expect(parseArticleBody("## A\r\nbody")).toEqual([
      { kind: "heading", level: 2, text: "A" },
      { kind: "paragraph", text: "body" },
    ]);
  });
});

describe("blog/render — word count and reading time", () => {
  it("counts words and derives reading minutes", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount("one two three")).toBe(3);
    expect(readingMinutes("")).toBe(0);
    expect(readingMinutes("one two three")).toBe(1);
    expect(readingMinutes(Array.from({ length: 1000 }, () => "word").join(" "))).toBe(5);
  });
});
