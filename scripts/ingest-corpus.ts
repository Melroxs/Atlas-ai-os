// Atlas Knowledge Corpus Ingestion Script
// Usage: bun run scripts/ingest-corpus.ts
//
// Prerequisites:
// 1. Apply migration 20260826_atlas_knowledge_layer.sql (creates tables)
// 2. Apply migration 20260827_atlas_knowledge_seed_internal.sql (baseline seed)
// 3. Apply migration 20260827b_atlas_corpus_ingestion.sql (relationships table + function skeleton)
// 4. Apply migration 20260827d_fix_ingest_corpus_quoted.sql (fixes function with quoted identifiers)
// 5. Run this script

import { getSupabaseClient } from '../src/lib/supabase';
import { CORPUS_PROVENANCE } from '../src/lib/knowledge/corpus/sources';
import { FEDERAL_REGULATIONS } from '../src/lib/knowledge/corpus/regulations';
import { WORKFLOW_STAGES } from '../src/lib/knowledge/corpus/workflows';
import { DOCUMENTATION_EVIDENCE } from '../src/lib/knowledge/corpus/evidence';
import { JURISDICTION_PROFILES } from '../src/lib/knowledge/corpus/jurisdictions';
import { STANDARDS_METADATA } from '../src/lib/knowledge/corpus/standards';
import { RISK_PATTERNS } from '../src/lib/knowledge/corpus/risks';
import { REVENUE_RECOVERY } from '../src/lib/knowledge/corpus/revenue';
import { GRAPH_RELATIONSHIPS } from '../src/lib/knowledge/corpus/graph';
import { CORPUS_MANIFEST } from '../src/lib/knowledge/corpus/manifest';
import { validateCorpus } from '../src/lib/knowledge/corpus/importer';

async function main() {
  console.log("=== Atlas Knowledge Corpus Ingestion ===");
  console.log("Corpus: " + CORPUS_MANIFEST.corpusName + " v" + CORPUS_MANIFEST.version);

  // Step 1: Validate locally
  const validation = validateCorpus();
  console.log("Validation: " + validation.validRecords + "/" + validation.totalRecords + " valid");
  if (!validation.valid) {
    console.error("FATAL: " + validation.errors.join(", "));
    process.exit(1);
  }

  // Step 2: Build payload
  const allKnowledge = [
    ...FEDERAL_REGULATIONS,
    ...WORKFLOW_STAGES,
    ...DOCUMENTATION_EVIDENCE,
    ...JURISDICTION_PROFILES,
    ...STANDARDS_METADATA,
    ...RISK_PATTERNS,
    ...REVENUE_RECOVERY,
  ];
  console.log("Payload: " + allKnowledge.length + " knowledge, " + CORPUS_PROVENANCE.length + " provenance, " + GRAPH_RELATIONSHIPS.length + " relationships");

  // Step 3: Connect
  const supabase = getSupabaseClient();
  if (!supabase) { console.error("No Supabase client"); process.exit(1); }

  // Step 4: Check pre-ingestion counts
  const { count: preK } = await supabase.from("atlasIndustryKnowledge").select("*", { count: "exact", head: true });
  const { count: preP } = await supabase.from("atlasIndustryProvenance").select("*", { count: "exact", head: true });
  console.log("Pre-ingestion: " + (preK ?? 0) + " knowledge, " + (preP ?? 0) + " provenance");

  // Step 5: Try RPC first, fall back to direct inserts
  console.log("\nAttempting RPC: industry_ingest_corpus()...");
  const { data: rpcData, error: rpcError } = await supabase.rpc("industry_ingest_corpus", {
    p_knowledge: allKnowledge,
    p_provenance: CORPUS_PROVENANCE,
    p_relationships: GRAPH_RELATIONSHIPS,
    p_corpus_version: CORPUS_MANIFEST.version,
  });

  if (rpcError) {
    console.log("RPC failed (" + rpcError.message + "), falling back to direct inserts...");
    await directInsert(supabase, allKnowledge, CORPUS_PROVENANCE, GRAPH_RELATIONSHIPS);
  } else {
    console.log("\nIngestion Report:");
    console.log(JSON.stringify(rpcData, null, 2));
  }

  // Step 6: Verify
  console.log("\n=== Post-Ingestion Verification ===");
  const { count: postK } = await supabase.from("atlasIndustryKnowledge").select("*", { count: "exact", head: true });
  const { count: postP } = await supabase.from("atlasIndustryProvenance").select("*", { count: "exact", head: true });
  const { count: postR } = await supabase.from("atlasIndustryRelationships").select("*", { count: "exact", head: true });
  console.log("Knowledge: " + postK + " (expected: 168)");
  console.log("Provenance: " + postP + " (expected: 12)");
  console.log("Relationships: " + postR + " (expected: 50+)");

  // Jurisdiction check
  const { count: jC } = await supabase.from("atlasIndustryKnowledge").select("*", { count: "exact", head: true }).eq("knowledgeType", "jurisdiction");
  console.log("Jurisdictions: " + jC + " (expected: 51, all placeholders)");

  // Type distribution via the stats RPC
  const { data: stats } = await supabase.rpc("industry_knowledge_stats");
  if (stats) {
    console.log("\nType distribution:");
    if (stats.byType) {
      for (const [t, c] of Object.entries(stats.byType as Record<string, number>)) {
        console.log("  " + t + ": " + c);
      }
    }
  }

  // Step 7: Idempotency check — run RPC again
  console.log("\n=== Idempotency Check ===");
  console.log("Running RPC again...");
  const { data: rpc2, error: rpc2Err } = await supabase.rpc("industry_ingest_corpus", {
    p_knowledge: allKnowledge,
    p_provenance: CORPUS_PROVENANCE,
    p_relationships: GRAPH_RELATIONSHIPS,
    p_corpus_version: CORPUS_MANIFEST.version,
  });
  if (rpc2Err) {
    console.log("Second RPC failed: " + rpc2Err.message);
  } else {
    const r = rpc2 as Record<string, number>;
    console.log("Second run: seeded=" + r.seededKnowledge + " updated=" + r.updatedKnowledge + " (should be 0 seeded)");
    console.log("Post-idempotency counts:");
    const { count: idK } = await supabase.from("atlasIndustryKnowledge").select("*", { count: "exact", head: true });
    const { count: idP } = await supabase.from("atlasIndustryProvenance").select("*", { count: "exact", head: true });
    const { count: idR } = await supabase.from("atlasIndustryRelationships").select("*", { count: "exact", head: true });
    console.log("  Knowledge: " + idK + " (should be same as before)");
    console.log("  Provenance: " + idP + " (should be same as before)");
    console.log("  Relationships: " + idR + " (should be same as before)");
  }

  console.log("\n=== Done ===");
}

/**
 * Direct insert fallback using the Supabase client.
 * Column names must match the exact PostgreSQL column names (quoted camelCase).
 * The knowledge table has a UNIQUE constraint on (title, knowledgeType) so we
 * use upsert. The provenance table has a UNIQUE on (sourceId).
 */
async function directInsert(supabase: any, knowledge: any[], provenance: any[], relationships: any[]) {
  const BATCH = 20;

  // Provenance — column names match the quoted PostgreSQL identifiers
  console.log("Inserting provenance...");
  for (const p of provenance) {
    const { error } = await supabase.from("atlasIndustryProvenance").upsert({
      sourceId: p.sourceId,
      sourceName: p.sourceName,
      organization: p.organization,
      authorityTier: p.authorityTier,
      sourceType: p.sourceType,
      canonicalUrl: p.canonicalUrl ?? null,
      status: p.status,
      version: CORPUS_MANIFEST.version,
    }, { onConflict: "sourceId" });
    if (error) console.error("  Prov error: " + error.message);
  }

  // Knowledge — column names match the quoted PostgreSQL identifiers
  console.log("Inserting knowledge...");
  for (let i = 0; i < knowledge.length; i += BATCH) {
    const batch = knowledge.slice(i, i + BATCH);
    const rows = batch.map(k => ({
      title: k.title,
      statement: k.statement,
      interpretation: k.interpretation ?? null,
      knowledgeType: k.knowledgeType,
      sourceClassification: k.sourceClassification,
      industry: k.industry ?? null,
      jurisdiction: k.jurisdiction ?? null,
      version: k.corpusVersion ?? CORPUS_MANIFEST.version,
      confidence: k.confidence,
      status: k.status,
      isInference: k.isInference,
      tags: k.tags,
    }));
    const { error } = await supabase.from("atlasIndustryKnowledge").upsert(rows, {
      onConflict: "title,knowledgeType",
    });
    if (error) console.error("  Knowledge batch error: " + error.message);
  }

  // Relationships — the table was created WITHOUT double quotes, so PostgREST
  // exposes it as "atlasIndustryRelationships" but the actual PG table is
  // atlasindustryrelationships (lowercase). PostgREST matches case-insensitively
  // for table names but column names must match the actual PG column names.
  // Since the columns were created without quotes, they're lowercase in PG.
  console.log("Inserting relationships...");
  for (let i = 0; i < relationships.length; i += BATCH) {
    const batch = relationships.slice(i, i + BATCH);
    const rows = batch.map(r => ({
      sourceid: r.sourceId,
      targetid: r.targetId,
      relationship: r.relationship,
      metadata: r.metadata ?? {},
      corpusversion: CORPUS_MANIFEST.version,
    }));
    const { error } = await supabase.from("atlasIndustryRelationships").upsert(rows, {
      onConflict: "sourceid,targetid,relationship",
    });
    if (error) console.error("  Rel batch error: " + error.message);
  }
}

main().catch((err) => { console.error("Unhandled error:", err); process.exit(1); });
