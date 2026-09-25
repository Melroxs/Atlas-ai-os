// ---------------------------------------------------------------------------
// Atlas Blog — article body rendering (pure, no DOM, no HTML injection)
//
// AI-generated article bodies are stored as light markdown. They are rendered
// as structured blocks, NEVER with dangerouslySetInnerHTML: generated content
// is untrusted input, and a prompt-injected body must not be able to inject
// markup or script into the public site.
// ---------------------------------------------------------------------------

export type ArticleBlock =
  | { kind: "heading"; level: 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "bullet"; items: string[] }
  | { kind: "quote"; text: string };

const BULLET_PREFIX = /^\s*(?:[-*•]|\d+\.)\s+/;
const HEADING_PREFIX = /^(#{1,6})\s+(.*)$/;

/** Parse a stored article body into renderable blocks. */
export function parseArticleBody(body: string | null | undefined): ArticleBlock[] {
  const source = (body ?? "").replace(/\r\n?/g, "\n").trim();
  if (!source) return [];

  const blocks: ArticleBlock[] = [];
  const lines = source.split("\n");
  let bullets: string[] = [];

  const flushBullets = () => {
    if (bullets.length > 0) {
      blocks.push({ kind: "bullet", items: bullets });
      bullets = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trim();

    if (line === "") {
      flushBullets();
      continue;
    }

    const heading = HEADING_PREFIX.exec(line);
    if (heading) {
      flushBullets();
      const level = heading[1].length;
      blocks.push({
        kind: "heading",
        level: level <= 2 ? 2 : 3,
        text: heading[2].trim(),
      });
      continue;
    }

    if (BULLET_PREFIX.test(line)) {
      bullets.push(line.replace(BULLET_PREFIX, "").trim());
      continue;
    }

    if (line.startsWith(">")) {
      flushBullets();
      blocks.push({ kind: "quote", text: line.replace(/^>\s?/, "").trim() });
      continue;
    }

    flushBullets();
    blocks.push({ kind: "paragraph", text: line });
  }

  flushBullets();
  return blocks;
}

/** Plain-text preview length guard (used by validation + reading time). */
export function wordCount(body: string | null | undefined): number {
  const text = (body ?? "").trim();
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

/** Human reading time in minutes (200 wpm, minimum 1 for non-empty bodies). */
export function readingMinutes(body: string | null | undefined): number {
  const words = wordCount(body);
  if (words === 0) return 0;
  return Math.max(1, Math.round(words / 200));
}
