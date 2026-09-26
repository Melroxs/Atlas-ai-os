// Exported so the content-quality test can assert that every article assigns a
// motif the renderer actually knows how to draw, without importing a .test file.
import type { Motif } from "./visuals";

export const MOTIFS_FOR_TEST: readonly Motif[] = [
  "ledger",
  "evidence",
  "lineItems",
  "workflow",
  "convergence",
  "analysis",
  "coordination",
  "leakage",
  "closedLoop",
  "product",
];
