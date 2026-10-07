// ---------------------------------------------------------------------------
// Atlas — deterministic thumbnail compositor: embedded production font
//
// WHY THIS FILE EXISTS ON ITS OWN
//   The font is the one asset whose licensing and identity must be explicit and
//   swappable. The compositor asks this module for the font bytes and the family
//   name; it never reaches into the base64 blob itself. Replacing the production
//   face is therefore a one-file change with no compositor redesign.
//
// PRODUCTION FONT (licence recorded, redistribution verified)
//   Font:      Liberation Sans Bold (unmodified)
//   Licence:   SIL Open Font License, Version 1.1
//   Copyright: Digitized data copyright (c) 2010 Google Corporation (Reserved
//              Font Names Arimo, Tinos, Cousine);
//              Copyright (c) 2012 Red Hat, Inc. (Reserved Font Name Liberation).
//   The full licence text ships beside this file as LICENSE_LIBERATION.txt.
//
//   OFL 1.1 explicitly permits the font to be "bundled, embedded, redistributed"
//   alongside software provided (a) the copyright notice and licence accompany
//   it, (b) the font is not sold by itself, and (c) a MODIFIED version does not
//   use a Reserved Font Name. This copy is unmodified, so (c) is satisfied; (a)
//   is satisfied by the licence file and this notice; (b) is satisfied because
//   the font is bundled with Atlas, not sold on its own.
//
// WHY BOLD: the overlay is a short piece of publication artwork that must stay
// legible when the thumbnail is shrunk to a small card, so a single heavy weight
// is embedded rather than a variable family.
// ---------------------------------------------------------------------------

import { decodeBase64ToBytes } from "./base64.ts";
import { LIBERATION_SANS_BOLD_BASE64 } from "./liberation-sans-bold-b64.ts";

/** The family name resvg must be told to resolve, and the SVG must name. */
export const FONT_FAMILY = "Liberation Sans";
/** Recorded in provenance/logs; a deterministic render depends on it. */
export const FONT_LICENSE = "SIL Open Font License 1.1";
export const FONT_SOURCE = "Liberation Sans Bold (unmodified)";

let cached: Uint8Array[] | null = null;

/**
 * The embedded font, decoded once. A fresh array is NOT returned on every call;
 * resvg only reads the buffer, and decoding 182 KB repeatedly would be wasteful.
 */
export function embeddedFontBuffers(): Uint8Array[] {
  if (!cached) cached = [decodeBase64ToBytes(LIBERATION_SANS_BOLD_BASE64)];
  return cached;
}
