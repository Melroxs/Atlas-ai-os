// ---------------------------------------------------------------------------
// Atlas Intelligence — the publication visual system
//
// WHY THIS EXISTS
//   Every article in the Atlas Intelligence publication needs a hero visual.
//   There is no image-generation integration in this environment, and stock
//   photography of smiling people in hard hats would be exactly the wrong
//   signal for a B2B claims-intelligence product. So the artwork is GENERATED:
//   each article declares a motif, and this module renders a deterministic,
//   on-brand SVG composition from it.
//
//   Properties this gives us:
//     * deterministic  — the same article always yields byte-identical SVG, so
//                        re-seeding never churns assets or breaks image URLs
//     * on-brand       — one palette, drawn from the Atlas design tokens
//     * zero-cost      — a hero is a few KB of vector, no network, no CDN origin
//     * honest         — abstract editorial art, never a fabricated photograph
//                        of a real job site, carrier document, or customer
//
//   The SVG is written to the public `blog-media` bucket by the seed pipeline
//   and served from there. Nothing here fetches or embeds a remote URL.
// ---------------------------------------------------------------------------

/** The Atlas Intelligence palette. Dark navy ground, cyan signal, restrained slate. */
export const ATLAS_VISUAL = {
  navy900: "#070d1a",
  navy800: "#0b1428",
  navy700: "#111c36",
  navy600: "#1a2748",
  slate500: "#64748b",
  slate400: "#94a3b8",
  cyan500: "#22d3ee",
  cyan400: "#38d9f0",
  cyan300: "#7ce8f8",
  green500: "#34d399",
  amber500: "#fbbf24",
} as const;

/**
 * Motifs. Each is a real editorial idea from the Atlas visual language, not a
 * decorative flourish:
 *
 *   ledger        — money already earned, sitting unclaimed in a ledger
 *   evidence      — claim files becoming structured, defensible evidence
 *   lineItems     — an estimate's line items being read and compared
 *   workflow      — a claim moving through ordered stages
 *   convergence   — disconnected systems becoming one intelligence layer
 *   analysis      — an evidence stream passing through an analysis engine
 *   coordination  — a restoration operation becoming coordinated
 *   leakage       — revenue leaking out of a claim unnoticed
 *   closedLoop    — recovery that returns to the work and closes the loop
 *   product       — Atlas itself: the operating surface
 */
export type Motif =
  | "ledger"
  | "evidence"
  | "lineItems"
  | "workflow"
  | "convergence"
  | "analysis"
  | "coordination"
  | "leakage"
  | "closedLoop"
  | "product";

/** Hero canvas: 16:9, the standard editorial and Open Graph ratio. */
export const HERO = { width: 1600, height: 900 } as const;

/** Social card: 1.91:1, the Open Graph recommendation. */
export const SOCIAL = { width: 1200, height: 628 } as const;

type Size = { width: number; height: number };

/**
 * Deterministic pseudo-random in [0,1) from a string seed.
 * A hash-based PRNG (not Math.random) so the same article always produces the
 * same artwork — re-seeding is a no-op and image URLs stay stable.
 */
function seededUnit(seed: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // xorshift finalisation
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Deterministic value in [min,max) for a given seed/salt. */
function seededRange(seed: string, salt: number, min: number, max: number): number {
  return min + seededUnit(seed, salt) * (max - min);
}

function grid(color: string, opacity: number, step: number, size: Size): string {
  const lines: string[] = [];
  for (let x = 0; x <= size.width; x += step) {
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${size.height}" />`);
  }
  for (let y = 0; y <= size.height; y += step) {
    lines.push(`<line x1="0" y1="${y}" x2="${size.width}" y2="${y}" />`);
  }
  return `<g stroke="${color}" stroke-width="1" opacity="${opacity}">${lines.join("")}</g>`;
}

/** Radial glow — the signature "subtle cyan illumination" of the brand. */
function glow(cx: number, cy: number, r: number, color: string, opacity: number, id: string): string {
  return `<defs><radialGradient id="${id}" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${color}" stop-opacity="${opacity}" />
      <stop offset="100%" stop-color="${color}" stop-opacity="0" />
    </radialGradient></defs>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${id})" />`;
}

function frame(size: Size, motif: Motif, seed: string): string {
  const g = ATLAS_VISUAL;
  const parts: string[] = [];

  parts.push(`<rect width="${size.width}" height="${size.height}" fill="${g.navy900}" />`);
  parts.push(grid(g.navy600, 0.5, 64, size));
  parts.push(glow(size.width * 0.72, size.height * 0.28, size.width * 0.5, g.cyan500, 0.2, "g1"));
  parts.push(glow(size.width * 0.18, size.height * 0.82, size.width * 0.45, g.cyan500, 0.1, "g2"));

  const w = size.width;
  const h = size.height;
  const stroke = g.cyan500;
  const dim = g.slate500;

  switch (motif) {
    // A claim ledger where rows of earned value sit unread, with one row
    // highlighted as recoverable.
    case "ledger": {
      const rows = 7;
      for (let i = 0; i < rows; i += 1) {
        const y = h * 0.24 + (i * h * 0.075);
        const wRow = w * seededRange(seed, i * 7 + 1, 0.3, 0.62);
        const hot = i === 4;
        parts.push(
          `<rect x="${w * 0.14}" y="${y}" width="${wRow}" height="${h * 0.035}" rx="${h * 0.017}" fill="${hot ? g.cyan500 : g.navy600}" opacity="${hot ? 0.85 : 0.75}" />`,
        );
        if (hot) {
          parts.push(
            `<rect x="${w * 0.14 + wRow + w * 0.02}" y="${y}" width="${w * 0.12}" height="${h * 0.035}" rx="${h * 0.017}" fill="${g.green500}" opacity="0.8" />`,
          );
        }
      }
      parts.push(
        `<line x1="${w * 0.14}" y1="${h * 0.2}" x2="${w * 0.86}" y2="${h * 0.2}" stroke="${dim}" stroke-width="2" opacity="0.6" />`,
      );
      break;
    }

    // A stack of claim files resolving into structured evidence nodes.
    case "evidence": {
      for (let i = 0; i < 5; i += 1) {
        const x = w * 0.16 + i * w * 0.045;
        const y = h * 0.3 - i * h * 0.03;
        parts.push(
          `<rect x="${x}" y="${y}" width="${w * 0.2}" height="${h * 0.36}" rx="${h * 0.02}" fill="${g.navy700}" stroke="${g.slate500}" stroke-width="1.5" opacity="${0.35 + i * 0.12}" />`,
        );
      }
      for (let i = 0; i < 6; i += 1) {
        const cx = w * (0.56 + (i % 3) * 0.11);
        const cy = h * (0.36 + Math.floor(i / 3) * 0.18);
        parts.push(`<circle cx="${cx}" cy="${cy}" r="${h * 0.035}" fill="${g.cyan400}" opacity="0.9" />`);
        if (i > 0) {
          const px = w * (0.56 + ((i - 1) % 3) * 0.11);
          const py = h * (0.36 + Math.floor((i - 1) / 3) * 0.18);
          parts.push(
            `<line x1="${px}" y1="${py}" x2="${cx}" y2="${cy}" stroke="${stroke}" stroke-width="1.5" opacity="0.45" />`,
          );
        }
      }
      break;
    }

    // An estimate's line items, with the missing ones detected.
    case "lineItems": {
      const items = 8;
      for (let i = 0; i < items; i += 1) {
        const y = h * 0.22 + i * h * 0.068;
        const missing = i === 2 || i === 5;
        parts.push(
          `<rect x="${w * 0.16}" y="${y}" width="${w * 0.46}" height="${h * 0.022}" rx="4" fill="${missing ? g.cyan500 : g.slate500}" opacity="${missing ? 0.9 : 0.5}" />`,
        );
        parts.push(
          `<rect x="${w * 0.66}" y="${y}" width="${w * 0.14}" height="${h * 0.022}" rx="4" fill="${missing ? g.green500 : g.navy600}" opacity="${missing ? 0.85 : 0.9}" />`,
        );
      }
      parts.push(
        `<rect x="${w * 0.16}" y="${h * 0.16}" width="${w * 0.64}" height="2" fill="${dim}" opacity="0.5" />`,
      );
      break;
    }

    // A claim moving through ordered stages.
    case "workflow": {
      const stages = 5;
      for (let i = 0; i < stages; i += 1) {
        const x = w * (0.14 + i * 0.16);
        parts.push(
          `<circle cx="${x}" cy="${h * 0.5}" r="${h * 0.045}" fill="${i < 3 ? g.cyan500 : g.navy600}" stroke="${stroke}" stroke-width="1.5" opacity="${i < 3 ? 0.9 : 0.6}" />`,
        );
        if (i < stages - 1) {
          parts.push(
            `<line x1="${x + h * 0.05}" y1="${h * 0.5}" x2="${x + w * 0.16 - h * 0.05}" y2="${h * 0.5}" stroke="${stroke}" stroke-width="2" opacity="0.5" />`,
          );
        }
      }
      break;
    }

    // Separate systems converging into a single intelligence layer.
    case "convergence": {
      for (let i = 0; i < 4; i += 1) {
        const y = h * (0.24 + i * 0.16);
        parts.push(
          `<rect x="${w * 0.08}" y="${y}" width="${w * 0.3}" height="${h * 0.08}" rx="${h * 0.02}" fill="${g.navy700}" stroke="${g.slate500}" stroke-width="1.5" opacity="0.7" />`,
        );
        parts.push(
          `<path d="M ${w * 0.4} ${y + h * 0.04} C ${w * 0.58} ${y + h * 0.04}, ${w * 0.6} ${h * 0.5}, ${w * 0.74} ${h * 0.5}" fill="none" stroke="${stroke}" stroke-width="1.5" opacity="0.5" />`,
        );
      }
      parts.push(
        `<rect x="${w * 0.74}" y="${h * 0.36}" width="${w * 0.18}" height="${h * 0.28}" rx="${h * 0.02}" fill="${g.cyan500}" opacity="0.2" stroke="${stroke}" stroke-width="1.5" />`,
      );
      break;
    }

    // An evidence stream passing through an analysis engine.
    case "analysis": {
      for (let i = 0; i < 9; i += 1) {
        const y = h * (0.2 + i * 0.07);
        const len = w * seededRange(seed, i * 13 + 3, 0.12, 0.34);
        parts.push(
          `<rect x="${w * 0.06}" y="${y}" width="${len}" height="${h * 0.02}" rx="4" fill="${g.slate500}" opacity="0.45" />`,
        );
        parts.push(
          `<line x1="${w * 0.06 + len + w * 0.02}" y1="${y + h * 0.01}" x2="${w * 0.42}" y2="${h * 0.5}" stroke="${stroke}" stroke-width="1" opacity="0.35" />`,
        );
      }
      parts.push(
        `<circle cx="${w * 0.52}" cy="${h * 0.5}" r="${h * 0.11}" fill="${g.cyan500}" opacity="0.22" stroke="${stroke}" stroke-width="2" />`,
      );
      parts.push(
        `<circle cx="${w * 0.52}" cy="${h * 0.5}" r="${h * 0.05}" fill="${g.cyan300}" opacity="0.9" />`,
      );
      for (let i = 0; i < 3; i += 1) {
        const y = h * (0.36 + i * 0.14);
        parts.push(
          `<rect x="${w * 0.72}" y="${y}" width="${w * 0.2}" height="${h * 0.045}" rx="${h * 0.02}" fill="${g.navy600}" stroke="${g.cyan500}" stroke-width="1" opacity="0.75" />`,
        );
      }
      break;
    }

    // A restoration operation becoming coordinated.
    case "coordination": {
      const cx = w * 0.5;
      const cy = h * 0.5;
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${h * 0.07}" fill="${g.cyan500}" opacity="0.85" />`);
      for (let i = 0; i < 6; i += 1) {
        const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
        const x = cx + Math.cos(a) * w * 0.28;
        const y = cy + Math.sin(a) * h * 0.3;
        parts.push(
          `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="${stroke}" stroke-width="1.5" opacity="0.45" />`,
        );
        parts.push(`<circle cx="${x}" cy="${y}" r="${h * 0.035}" fill="${g.navy600}" stroke="${g.cyan400}" stroke-width="1.5" />`);
      }
      break;
    }

    // Revenue draining out of a claim, unnoticed.
    case "leakage": {
      for (let i = 0; i < 5; i += 1) {
        const y = h * 0.22 + i * h * 0.1;
        const full = w * 0.5;
        parts.push(
          `<rect x="${w * 0.16}" y="${y}" width="${full}" height="${h * 0.05}" rx="${h * 0.025}" fill="${g.navy600}" opacity="0.8" />`,
        );
        const keep = w * seededRange(seed, i * 17 + 5, 0.2, 0.72);
        parts.push(
          `<rect x="${w * 0.16}" y="${y}" width="${keep}" height="${h * 0.05}" rx="${h * 0.025}" fill="${i === 3 ? g.amber500 : g.cyan500}" opacity="0.8" />`,
        );
        if (i === 3) {
          parts.push(
            `<text x="${w * 0.16 + keep + w * 0.02}" y="${y + h * 0.04}" font-family="ui-monospace, monospace" font-size="${h * 0.04}" fill="${g.amber500}" opacity="0.9">!</text>`,
          );
        }
      }
      break;
    }

    // Recovery returning to the work and closing the loop.
    case "closedLoop": {
      const cx = w * 0.5;
      const cy = h * 0.5;
      const r = Math.min(w, h) * 0.26;
      parts.push(
        `<path d="M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx} ${cy - r}" fill="none" stroke="${stroke}" stroke-width="3" opacity="0.8" />`,
      );
      parts.push(
        `<path d="M ${cx} ${cy - r} L ${cx - w * 0.03} ${cy - r - h * 0.05} L ${cx + w * 0.02} ${cy - r + h * 0.005} Z" fill="${stroke}" opacity="0.9" />`,
      );
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${h * 0.05}" fill="${g.green500}" opacity="0.9" />`);
      break;
    }

    // Atlas itself — the operating surface.
    case "product":
    default: {
      parts.push(
        `<rect x="${w * 0.28}" y="${h * 0.2}" width="${w * 0.44}" height="${h * 0.6}" rx="${h * 0.03}" fill="${g.navy700}" stroke="${stroke}" stroke-width="1.5" opacity="0.9" />`,
      );
      for (let i = 0; i < 4; i += 1) {
        parts.push(
          `<rect x="${w * 0.33}" y="${h * (0.3 + i * 0.12)}" width="${w * 0.34}" height="${h * 0.045}" rx="6" fill="${i === 0 ? g.cyan500 : g.navy600}" opacity="${i === 0 ? 0.85 : 0.9}" />`,
        );
      }
      break;
    }
  }

  // A thin cyan horizon rule anchors every composition to the brand.
  parts.push(
    `<rect x="0" y="${size.height - 4}" width="${size.width}" height="4" fill="${g.cyan500}" opacity="0.5" />`,
  );

  return parts.join("");
}

/**
 * Render an article hero (or social card) as a complete standalone SVG string.
 *
 * `seed` should be the article slug: it makes the output deterministic and
 * keeps the composition stable for a given article across re-seeds.
 */
export function renderAtlasArtwork(
  motif: Motif,
  seed: string,
  kind: "hero" | "social" = "hero",
): string {
  const size: Size = kind === "social" ? SOCIAL : HERO;
  const title = `Atlas Intelligence — ${motif}`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size.width} ${size.height}" width="${size.width}" height="${size.height}" role="img" aria-label="${title}">`,
    `<title>${title}</title>`,
    frame(size, motif, seed),
    `</svg>`,
  ].join("");
}
