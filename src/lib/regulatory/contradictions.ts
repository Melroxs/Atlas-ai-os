// ---------------------------------------------------------------------------
// Atlas Regulatory Intelligence — Contradiction Engine
//
// Contradictions are explicit records, never silently resolved. Detection is
// deterministic: same-jurisdiction same-topic conflicting deadlines,
// superseded sources, effective-window anomalies, and secondary-vs-primary
// conflicts. When two sources conflict, Atlas surfaces the contradiction and
// keeps BOTH — it never picks one.
// ---------------------------------------------------------------------------

import type {
  RegulatoryContradiction,
  RegulatoryProposition,
  RegulatorySource,
} from "./types";
import { SOURCE_TYPE_TIERS } from "./types";

let _seq = 0;
function nextId(): string {
  _seq += 1;
  return `contra_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

export interface ContradictionInput {
  propositions: RegulatoryProposition[];
  sources: RegulatorySource[];
  now?: number;
}

/**
 * Detect contradictions across a proposition set.
 * Kinds:
 *  - same topic/actor/jurisdiction, two different deadlines → deadline conflict
 *  - superseded source still contributing propositions → superseded source
 *  - tier-4-derived proposition that would claim primary authority → secondary_vs_primary
 *  - two primary sources with overlapping effective windows but different text → effective_date_overlap
 */
export function detectRegulatoryContradictions(
  input: ContradictionInput,
): RegulatoryContradiction[] {
  const { propositions, sources, now = Date.now() } = input;
  const out: RegulatoryContradiction[] = [];
  const sourceById = new Map(sources.map((s) => [s.sourceId, s]));

  const push = (c: Omit<RegulatoryContradiction, "contradictionId" | "createdAt" | "status">) => {
    out.push({ ...c, contradictionId: nextId(), status: "OPEN", createdAt: now });
  };

  // 1. Deadline conflicts: same jurisdiction + topic + actor, both have
  //    deadlines, different amounts (or different units).
  const byTopicActor = new Map<string, RegulatoryProposition[]>();
  for (const p of propositions) {
    if (p.deadline === undefined || p.deadlineUnit === "none") continue;
    const key = `${p.jurisdictionId}|${p.topic}|${p.actor}`;
    const list = byTopicActor.get(key) ?? [];
    list.push(p);
    byTopicActor.set(key, list);
  }
  for (const [key, group] of byTopicActor) {
    const [jurisdictionId, topic, actor] = key.split("|");
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const aVal = a.deadline ?? 0;
        const bVal = b.deadline ?? 0;
        const conflict =
          a.deadlineUnit !== b.deadlineUnit ||
          aVal !== bVal ||
          a.ruleText.trim().toLowerCase() !== b.ruleText.trim().toLowerCase();
        if (!conflict) continue;
        // Skip versions of the same chain (same dedup key = same rule lineage).
        if (a.dedupKey === b.dedupKey) continue;
        const aSrc = sourceById.get(a.sourceId);
        const bSrc = sourceById.get(b.sourceId);
        const aTier = aSrc ? SOURCE_TYPE_TIERS[aSrc.sourceType] ?? aSrc.authorityTier : a.authorityTier;
        const bTier = bSrc ? SOURCE_TYPE_TIERS[bSrc.sourceType] ?? bSrc.authorityTier : b.authorityTier;
        push({
          kind: "primary_vs_primary",
          jurisdictionId,
          propositionAId: a.propositionId,
          propositionBId: b.propositionId,
          sourceAId: a.sourceId,
          sourceBId: b.sourceId,
          detail:
            `"${a.ruleText.slice(0, 120)}" (${a.deadline} ${a.deadlineUnit}) vs ` +
            `"${b.ruleText.slice(0, 120)}" (${b.deadline} ${b.deadlineUnit}) in ${jurisdictionId} ` +
            `(topic: ${topic}, actor: ${actor}). Both sources are preserved; requires resolution.`,
          severity: aTier === 1 && bTier === 1 ? "HIGH" : "MEDIUM",
        });
      }
    }
  }

  // 2. Superseded source still supplying propositions.
  for (const p of propositions) {
    const src = sourceById.get(p.sourceId);
    if (src?.status === "SUPERSEDED") {
      push({
        kind: "superseded_source",
        jurisdictionId: p.jurisdictionId,
        propositionAId: p.propositionId,
        sourceAId: p.sourceId,
        sourceBId: src.supersededBySourceId ?? "unknown",
        detail: `Proposition "${p.ruleText.slice(0, 100)}" still references superseded source "${src.title}".`,
        severity: "HIGH",
      });
    }
  }

  // 3. Secondary-derived proposition presented as primary authority.
  for (const p of propositions) {
    const src = sourceById.get(p.sourceId);
    if (!src) continue;
    const tier = SOURCE_TYPE_TIERS[src.sourceType] ?? src.authorityTier;
    if (tier >= 4 && p.authorityTier <= 2) {
      push({
        kind: "secondary_vs_primary",
        jurisdictionId: p.jurisdictionId,
        propositionAId: p.propositionId,
        sourceAId: p.sourceId,
        sourceBId: p.sourceId,
        detail:
          `Proposition cites secondary source "${src.title}" as authority tier ${p.authorityTier}. ` +
          `Secondary research can drive discovery but can never become controlling authority.`,
        severity: "HIGH",
      });
    }
  }

  // 4. Effective-window overlap between distinct rules on the same topic.
  const seenOverlap = new Set<string>();
  for (const p of propositions) {
    if (p.effectiveFrom === undefined || p.effectiveTo === undefined) continue;
    for (const q of propositions) {
      if (p.propositionId === q.propositionId) continue;
      if (p.dedupKey === q.dedupKey) continue;
      if (p.jurisdictionId !== q.jurisdictionId || p.topic !== q.topic) continue;
      if (q.effectiveFrom === undefined) continue;
      // p fully contains q and both are "current" simultaneously.
      if (p.effectiveFrom <= q.effectiveFrom && q.effectiveFrom <= (p.effectiveTo ?? Infinity)) {
        const key = [p.propositionId, q.propositionId].sort().join("|");
        if (seenOverlap.has(key)) continue;
        seenOverlap.add(key);
        if (p.ruleText.trim() === q.ruleText.trim()) continue;
        push({
          kind: "effective_date_overlap",
          jurisdictionId: p.jurisdictionId,
          propositionAId: p.propositionId,
          propositionBId: q.propositionId,
          sourceAId: p.sourceId,
          sourceBId: q.sourceId,
          detail:
            `Two distinct rules on topic "${p.topic}" overlap in effective window. ` +
            `Overlapping rules are not necessarily wrong (one may be narrower), but require review.`,
          severity: "LOW",
        });
      }
    }
  }

  return out.sort((a, b) => {
    const sev = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
    return (sev[a.severity] ?? 3) - (sev[b.severity] ?? 3);
  });
}

// ---------------------------------------------------------------------------
// Model-law vs state rule check
// ---------------------------------------------------------------------------

/**
 * Compare a model-law (tier 3) proposition against a state (tier 1/2)
 * proposition on the same topic. A state rule that differs from the model
 * law is NOT automatically a contradiction — state law controls — but the
 * difference should be visible. Returns a LOW-severity informational record
 * only when both exist for the same jurisdiction+topic.
 */
export function detectModelLawDivergence(
  stateProps: RegulatoryProposition[],
  modelLawProps: RegulatoryProposition[],
  now: number = Date.now(),
): RegulatoryContradiction[] {
  const out: RegulatoryContradiction[] = [];
  for (const state of stateProps) {
    for (const model of modelLawProps) {
      if (state.topic !== model.topic) continue;
      if (state.deadline === undefined || model.deadline === undefined) continue;
      if (state.deadline === model.deadline && state.deadlineUnit === model.deadlineUnit) continue;
      out.push({
        contradictionId: nextId(),
        kind: "state_vs_model_law",
        jurisdictionId: state.jurisdictionId,
        propositionAId: state.propositionId,
        propositionBId: model.propositionId,
        sourceAId: state.sourceId,
        sourceBId: model.sourceId,
        detail:
          `State rule (${state.deadline} ${state.deadlineUnit}) differs from model-law baseline ` +
          `(${model.deadline} ${model.deadlineUnit}) on topic "${state.topic}". State law controls; ` +
          `divergence is informational, not an error.`,
        severity: "LOW",
        status: "OPEN",
        createdAt: now,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Extraction vs source text
// ---------------------------------------------------------------------------

/**
 * Verify that an extracted proposition's rule text is supported by the
 * source text. Support means: the source contains either the exact rule text
 * or enough shared content that a direct quote is plausible. This is the
 * "AI extraction conflicts with source text" check.
 */
export function assessExtractionSupport(
  ruleText: string,
  sourceText: string,
): { supported: boolean; score: number } {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const rule = norm(ruleText);
  const source = norm(sourceText);
  if (!rule) return { supported: false, score: 0 };

  if (source.includes(rule)) return { supported: true, score: 1 };

  // Token-overlap heuristic: 60%+ of significant rule tokens present in order.
  const significant = rule
    .split(" ")
    .filter((t) => t.length > 3 && !/^(the|and|or|for|with|shall|must|may)$/.test(t));
  if (significant.length === 0) return { supported: false, score: 0 };

  let hits = 0;
  let idx = 0;
  for (const token of significant) {
    const found = source.indexOf(token, idx);
    if (found >= 0) {
      hits += 1;
      idx = found + token.length;
    }
  }
  const score = hits / significant.length;
  return { supported: score >= 0.6, score: Math.round(score * 100) / 100 };
}