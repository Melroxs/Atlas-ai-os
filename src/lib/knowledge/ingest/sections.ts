// ---------------------------------------------------------------------------
// Atlas Knowledge Layer — section detection
//
// Sections are inferred from the ACTUAL extracted text with deterministic
// signals and a confidence score. When no signal is confident the section is
// left UNKNOWN — never invented. A page number alone is sufficient provenance,
// so an uncertain section degrades safely; a fabricated section does not.
//
// Signals, strongest first:
//   1. A numbered heading line (`3.2 Estimating`) — high confidence.
//   2. An ALL-CAPS heading line — high confidence when it survives the
//      digit/letter mix test (a data row of numbers is not a heading).
//   3. A heading that also appears in a detected table of contents — the
//      strongest signal, because the document itself named it.
// ---------------------------------------------------------------------------

export interface PageTextInput {
  pageNumber: number;
  text: string;
}

export interface SectionAssignment {
  pageNumber: number;
  /** Detected section heading, or undefined when none was confident enough. */
  section?: string;
  /** Detected subsection heading, or undefined. */
  subsection?: string;
  /** 0..1 — how strongly the text supported the assignment. */
  confidence: number;
  /** True when detection was possible but below the confidence floor. */
  uncertain: boolean;
}

/** A heading line that will be tested for TOC membership. */
interface HeadingCandidate {
  kind: "numbered" | "caps";
  text: string;
  /** Numbering depth (1 = top level, 2 = subsection). */
  depth: number;
}

const NUMBERED_HEADING = /^\s*(\d+(?:\.\d+)*)[.)]?\s+([A-Z][^\n]{1,70})$/;
const CAPS_HEADING = /^[A-Z0-9][A-Z0-9 ,.'&/()\-]{3,70}$/;
const TOC_ENTRY = /^\s*(\d+(?:\.\d+)*)[.)]?\s+([A-Z][^\n]{1,70}?)\s*\.{2,}\s*\d+\s*$/;

/** Confidence assigned to each signal. */
const CONFIDENCE = {
  toc_member: 0.92,
  numbered: 0.82,
  caps: 0.7,
  /** Floor below which a detected heading is reported as uncertain. */
  floor: 0.6,
};

/** Split a page's text into trimmed non-empty lines. */
function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** True when a caps string is actually a heading rather than a row of data. */
function looksLikeHeading(text: string): boolean {
  const t = text.trim();
  if (t.length < 4 || t.length > 71) return false;
  const letters = (t.match(/[A-Za-z]/g) ?? []).length;
  const digits = (t.match(/\d/g) ?? []).length;
  if (letters < 3) return false;
  // Predominantly numeric => a data row, not a heading.
  if (digits > letters) return false;
  // Ends mid-sentence with a comma => not a heading.
  if (/,$/.test(t)) return false;
  return true;
}

/** Detect the table-of-contents headings the document itself names. */
export function detectTableOfContents(pages: PageTextInput[]): Set<string> {
  const toc = new Set<string>();
  for (const page of pages) {
    for (const line of lines(page.text)) {
      const m = line.match(TOC_ENTRY);
      if (m) toc.add(normalizeHeading(m[2]));
    }
  }
  return toc;
}

function normalizeHeading(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Find the first heading-shaped line on a page. */
function firstHeading(text: string): HeadingCandidate | null {
  for (const line of lines(text)) {
    const numbered = line.match(NUMBERED_HEADING);
    if (numbered) {
      const depth = (numbered[1].match(/\./g) ?? []).length + 1;
      return { kind: "numbered", text: numbered[2].trim(), depth };
    }
    if (CAPS_HEADING.test(line) && looksLikeHeading(line)) {
      // Title-case it for readability while keeping the document's words.
      return { kind: "caps", text: toTitleCase(line), depth: 1 };
    }
  }
  return null;
}

function toTitleCase(s: string): string {
  const small = new Set(["of", "and", "the", "for", "to", "in", "on", "a", "an", "or"]);
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w, i) => (i > 0 && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * Assign a section (and optional subsection) to every page, carrying the last
 * confidently detected heading forward. A page that itself has no heading
 * inherits the section in force; if none has been seen yet, section stays
 * undefined and `uncertain` is true.
 */
export function detectSections(pages: PageTextInput[]): SectionAssignment[] {
  const toc = detectTableOfContents(pages);
  const assignments: SectionAssignment[] = [];

  let currentSection: string | undefined;
  let currentSubsection: string | undefined;

  for (const page of pages) {
    const heading = firstHeading(page.text);
    let confidence = 0;
    let uncertain = false;

    if (heading) {
      const tocMember = toc.has(normalizeHeading(heading.text));
      confidence = tocMember
        ? CONFIDENCE.toc_member
        : heading.kind === "numbered"
          ? CONFIDENCE.numbered
          : CONFIDENCE.caps;

      if (confidence >= CONFIDENCE.floor) {
        if (heading.depth <= 1) {
          currentSection = heading.text;
          currentSubsection = undefined;
        } else {
          currentSubsection = heading.text;
        }
      } else {
        // Detected something heading-like but not confidently. Do not adopt it;
        // keep the section in force but record that the page was ambiguous.
        uncertain = true;
      }
    } else if (currentSection) {
      // A continuation page: inherit the section in force. Not uncertain.
      confidence = CONFIDENCE.floor;
    } else {
      // No heading anywhere yet and none inherited: section genuinely unknown.
      uncertain = true;
    }

    assignments.push({
      pageNumber: page.pageNumber,
      section: currentSection,
      subsection: currentSubsection,
      confidence,
      uncertain,
    });
  }

  return assignments;
}
