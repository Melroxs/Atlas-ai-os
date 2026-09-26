// ---------------------------------------------------------------------------
// Atlas Intelligence — the CTA system
//
// Three reusable closing calls to action, defined once and referenced by id
// from each article (Article.cta). The point of a shared definition is that
// the copy stays consistent and can be revised in one place, and that the
// choice per article is explicit rather than an accident.
//
// CTAs are used selectively. Articles marked `cta: "none"` end without one,
// because a publication where every article is an advertisement is not a
// publication.
// ---------------------------------------------------------------------------

import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import type { CtaId } from "./articles/types";

export interface Cta {
  id: Exclude<CtaId, "none">;
  /** The headline — a position, not a command. */
  headline: string;
  /** One or two sentences on what Atlas actually does. */
  body: string;
  /** The button label. */
  action: string;
  /** Where the button goes. */
  to: string;
}

export const CTAS: Record<Exclude<CtaId, "none">, Cta> = {
  A: {
    id: "A",
    headline: "Know Everything. Miss Nothing.",
    body: "Atlas helps restoration companies turn claims, evidence, estimates and operational data into actionable intelligence — surfacing the differences between what was approved and what the work actually required.",
    action: "See how Atlas works",
    to: "/pricing",
  },
  B: {
    id: "B",
    headline: "Recover More From the Work You've Already Done.",
    body: "The revenue described in this article was already earned. Atlas organizes the claim record, compares scope against what was performed, and puts the recoverable differences in front of the person who can act on them.",
    action: "Explore Atlas",
    to: "/pricing",
  },
  C: {
    id: "C",
    headline: "Your Claims Already Contain the Evidence.",
    body: "Atlas organizes it, analyzes it, and surfaces the recovery opportunities hiding in it — so the work your team has already done gets paid for.",
    action: "See what Atlas finds",
    to: "/pricing",
  },
};

export function ctaById(id: CtaId): Cta | null {
  return id === "none" ? null : (CTAS[id] ?? null);
}
