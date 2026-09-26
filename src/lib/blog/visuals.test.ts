// ---------------------------------------------------------------------------
// Atlas Intelligence — the visual system
//
// The artwork is generated, not sourced, so these tests assert the properties
// that make generation safe to rely on: it is deterministic, it is on-brand,
// it contains no external reference, and it cannot inject anything.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  ATLAS_VISUAL,
  HERO,
  SOCIAL,
  renderAtlasArtwork,
} from "./visuals";
import { MOTIFS_FOR_TEST } from "./visuals.test-support";
import { ARTICLES } from "./articles";

describe("Atlas artwork renderer", () => {
  it("renders every known motif as a complete, labelled SVG", () => {
    for (const motif of MOTIFS_FOR_TEST) {
      const svg = renderAtlasArtwork(motif, "seed-slug");
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg.endsWith("</svg>")).toBe(true);
      expect(svg).toContain("<title>Atlas Intelligence");
      // Every motif must actually draw something, not just emit a frame.
      expect(svg.length).toBeGreaterThan(1500);
    }
  });

  it("is deterministic: the same seed always yields identical output", () => {
    for (const motif of MOTIFS_FOR_TEST) {
      const a = renderAtlasArtwork(motif, "revenue-you-are-already-owed");
      const b = renderAtlasArtwork(motif, "revenue-you-are-already-owed");
      expect(a).toBe(b);
    }
  });

  it("varies composition between articles so the blog does not look cloned", () => {
    const rendered = new Set(
      ARTICLES.map((a) => renderAtlasArtwork(a.motif, a.slug, "hero")),
    );
    // Different motifs guarantee difference; same-motif articles must still
    // differ because the seed drives the geometry.
    expect(rendered.size).toBeGreaterThan(1);
  });

  it("uses only the Atlas palette", () => {
    const allowed = new Set(Object.values(ATLAS_VISUAL));
    for (const motif of MOTIFS_FOR_TEST) {
      const svg = renderAtlasArtwork(motif, "seed-slug");
      const hexes = svg.match(/#[0-9a-f]{6}/gi) ?? [];
      for (const hex of hexes) {
        expect(
          allowed.has(hex.toLowerCase()),
          `${motif} used a colour outside the palette: ${hex}`,
        ).toBe(true);
      }
    }
  });

  it("contains no external reference, script or embedded handler", () => {
    for (const motif of MOTIFS_FOR_TEST) {
      const svg = renderAtlasArtwork(motif, "seed-slug");
      expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/i);
      expect(svg).not.toMatch(/<script/i);
      expect(svg).not.toMatch(/on(load|error|click)\s*=/i);
      expect(svg).not.toMatch(/<foreignObject/i);
      expect(svg).not.toMatch(/javascript:/i);
    }
  });

  it("renders at the declared hero and social dimensions", () => {
    const hero = renderAtlasArtwork("analysis", "seed", "hero");
    expect(hero).toContain(`viewBox="0 0 ${HERO.width} ${HERO.height}"`);
    const social = renderAtlasArtwork("analysis", "seed", "social");
    expect(social).toContain(`viewBox="0 0 ${SOCIAL.width} ${SOCIAL.height}"`);
  });

  it("stays small enough to inline as a fallback", () => {
    for (const motif of MOTIFS_FOR_TEST) {
      expect(renderAtlasArtwork(motif, "seed-slug").length).toBeLessThan(60_000);
    }
  });

  it("is accessible: labelled, and decorative shapes carry no text spam", () => {
    const svg = renderAtlasArtwork("leakage", "seed-slug");
    expect(svg).toContain('role="img"');
    expect(svg).toContain("<title>");
    expect(svg).toContain('aria-label=');
  });
});

describe("Atlas artwork output is escaped by construction", () => {
  it("cannot be influenced by a hostile slug into emitting markup", () => {
    // The slug is only ever used as a PRNG seed, never interpolated into the
    // markup, so a hostile value changes composition and nothing else.
    const hostile = '"><script>alert(1)</script>';
    const svg = renderAtlasArtwork("analysis", hostile);
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("alert(1)");
  });
});
