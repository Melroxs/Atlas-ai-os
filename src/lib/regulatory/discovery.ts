import { sourceCandidatesFor } from "./catalog";
import type { DiscoverySourceAdapter, JurisdictionRecord, ResearchTopic, SourceCandidate } from "./types";

export interface SecondaryDiscoveryRecord {
  url: string;
  title: string;
  jurisdictionCode: string;
  topics: ResearchTopic[];
}

export class RegulatorySourceDiscovery {
  private readonly secondarySources: SecondaryDiscoveryRecord[];
  private readonly primaryAdapter: DiscoverySourceAdapter;

  constructor(
    secondarySources: SecondaryDiscoveryRecord[] = [],
    primaryAdapter: DiscoverySourceAdapter = { discover: async (jurisdiction) => sourceCandidatesFor(jurisdiction) },
  ) {
    this.secondarySources = secondarySources;
    this.primaryAdapter = primaryAdapter;
  }

  async discover(jurisdiction: JurisdictionRecord): Promise<SourceCandidate[]> {
    const secondary = this.secondarySources
      .filter((source) => source.jurisdictionCode === jurisdiction.code)
      .map((source, index): SourceCandidate => ({
        jurisdictionCode: jurisdiction.code,
        url: source.url,
        title: source.title,
        kind: "secondary",
        authorityTier: "secondary_reference",
        relationship: "DISCOVERY_SOURCE",
        topics: source.topics,
        id: `discovery_${jurisdiction.code}_${index}`,
      }));
    const primary = await this.primaryAdapter.discover(jurisdiction);
    const primaryByTopic = new Map<ResearchTopic, SourceCandidate>();
    for (const source of primary) for (const topic of source.topics) if (!primaryByTopic.has(topic)) primaryByTopic.set(topic, source);
    return [
      ...secondary,
      ...primary.map((source) => {
        const matchingDiscovery = secondary.find((candidate) => candidate.topics.some((topic) => source.topics.includes(topic)));
        return matchingDiscovery ? { ...source, discoverySourceId: matchingDiscovery.id } : source;
      }),
    ].map((source) => ({ ...source, relationship: source.kind === "secondary" ? "DISCOVERY_SOURCE" : "CONTROLLING_AUTHORITY" }));
  }
}
