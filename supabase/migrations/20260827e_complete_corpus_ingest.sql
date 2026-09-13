-- ---------------------------------------------------------------------------
-- Atlas Knowledge Corpus — Complete Ingestion (Single-Script)
--
-- This migration:
-- 1. Ensures the UNIQUE constraint on atlasIndustryKnowledge exists
-- 2. Ensures the UNIQUE constraint on atlasIndustryRelationships exists
-- 3. Recreates industry_ingest_corpus() with double-quoted identifiers
-- 4. GRANTs EXECUTE to authenticated
-- 5. Provides a verification query
--
-- After running this, execute the corpus data ingestion by calling:
--   SELECT public.industry_ingest_corpus(
--     '<knowledge_jsonb>',
--     '<provenance_jsonb>',
--     '<relationships_jsonb>',
--     '1.0.0'
--   );
-- Or run the TypeScript ingestion script.
-- ----------------------------------------------------------------===========

-- 1. Ensure UNIQUE constraint on (title, knowledgeType)
DO $$
BEGIN
  -- Drop old constraint if it exists (may have been created with wrong quoting)
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE c.conname = 'knowledge_title_type_unique'
      AND t.relname = 'atlasIndustryKnowledge'
  ) THEN
    ALTER TABLE "atlasIndustryKnowledge"
      DROP CONSTRAINT knowledge_title_type_unique;
  END IF;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "atlasIndustryKnowledge"
    ADD CONSTRAINT knowledge_title_type_unique
    UNIQUE ("title", "knowledgeType");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Ensure UNIQUE constraint on relationships
-- Drop-then-recreate, mirroring block 1, so the migration is replayable.
-- Postgres raises 42P07 duplicate_table (not 42710 duplicate_object) when the
-- constraint already exists, and PL/pgSQL's duplicate_object handler does not
-- catch it — re-running the file would abort here.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE c.conname = 'industry_rels_unique'
      AND lower(t.relname) = lower('atlasIndustryRelationships')
  ) THEN
    ALTER TABLE atlasIndustryRelationships
      DROP CONSTRAINT industry_rels_unique;
  END IF;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE atlasIndustryRelationships
    ADD CONSTRAINT industry_rels_unique
    UNIQUE (sourceId, targetId, relationship);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3. Recreate industry_ingest_corpus with double-quoted identifiers
DROP FUNCTION IF EXISTS public.industry_ingest_corpus(jsonb, jsonb, jsonb, text);

CREATE OR REPLACE FUNCTION public.industry_ingest_corpus(
  p_knowledge jsonb DEFAULT '[]'::jsonb,
  p_provenance jsonb DEFAULT '[]'::jsonb,
  p_relationships jsonb DEFAULT '[]'::jsonb,
  p_corpus_version text DEFAULT '1.0.0'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_item jsonb;
  v_prov jsonb;
  v_rel jsonb;
  v_seeded_know int := 0;
  v_updated_know int := 0;
  v_seeded_prov int := 0;
  v_updated_prov int := 0;
  v_seeded_rels int := 0;
  v_updated_rels int := 0;
  v_existing int;
BEGIN
  -- A. Provenance (idempotent via sourceId UNIQUE)
  FOR v_prov IN SELECT * FROM jsonb_array_elements(coalesce(p_provenance, '[]'::jsonb))
  LOOP
    SELECT count(*) INTO v_existing FROM "atlasIndustryProvenance"
      WHERE "sourceId" = v_prov->>'sourceId';
    INSERT INTO "atlasIndustryProvenance" (
      "sourceId", "sourceName", "organization", "authorityTier", "sourceType",
      "canonicalUrl", "status", "jurisdiction", "industry", "version"
    ) VALUES (
      v_prov->>'sourceId', v_prov->>'sourceName', v_prov->>'organization',
      coalesce(v_prov->>'authorityTier', 'tier3_industry'),
      coalesce(v_prov->>'sourceType', 'curated'),
      v_prov->>'canonicalUrl',
      coalesce(v_prov->>'status', 'active'),
      v_prov->>'jurisdiction', v_prov->>'industry',
      coalesce(v_prov->>'version', p_corpus_version)
    )
    ON CONFLICT ("sourceId") DO UPDATE SET
      "sourceName" = EXCLUDED."sourceName",
      "organization" = EXCLUDED."organization",
      "authorityTier" = EXCLUDED."authorityTier",
      "sourceType" = EXCLUDED."sourceType",
      "status" = EXCLUDED."status",
      "canonicalUrl" = coalesce(EXCLUDED."canonicalUrl", "atlasIndustryProvenance"."canonicalUrl");
    IF v_existing = 0 THEN v_seeded_prov := v_seeded_prov + 1;
    ELSE v_updated_prov := v_updated_prov + 1; END IF;
  END LOOP;

  -- B. Knowledge (idempotent via title+knowledgeType UNIQUE)
  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_knowledge, '[]'::jsonb))
  LOOP
    SELECT count(*) INTO v_existing FROM "atlasIndustryKnowledge"
      WHERE "title" = v_item->>'title' AND "knowledgeType" = v_item->>'knowledgeType';
    INSERT INTO "atlasIndustryKnowledge" (
      "title", "statement", "interpretation", "knowledgeType",
      "sourceClassification", "industry", "jurisdiction", "version",
      "confidence", "status", "isInference", "tags", "publishedAt"
    ) VALUES (
      v_item->>'title', v_item->>'statement', v_item->>'interpretation',
      v_item->>'knowledgeType',
      coalesce(v_item->>'sourceClassification', 'ATLAS_CURATED')::source_classification,
      v_item->>'industry', v_item->>'jurisdiction',
      coalesce(v_item->>'version', p_corpus_version),
      coalesce((v_item->>'confidence')::double precision, 0.7),
      coalesce(v_item->>'status', 'active'),
      coalesce((v_item->>'isInference')::boolean, false),
      coalesce(v_item->'tags', '[]'::jsonb),
      public.epoch_ms()
    )
    ON CONFLICT ("title", "knowledgeType") DO UPDATE SET
      "statement" = EXCLUDED."statement",
      "interpretation" = coalesce(EXCLUDED."interpretation", "atlasIndustryKnowledge"."interpretation"),
      "sourceClassification" = EXCLUDED."sourceClassification",
      "industry" = coalesce(EXCLUDED."industry", "atlasIndustryKnowledge"."industry"),
      "jurisdiction" = coalesce(EXCLUDED."jurisdiction", "atlasIndustryKnowledge"."jurisdiction"),
      "confidence" = EXCLUDED."confidence",
      "status" = EXCLUDED."status",
      "isInference" = EXCLUDED."isInference",
      "tags" = EXCLUDED."tags",
      "version" = EXCLUDED."version",
      "updatedAt" = public.epoch_ms();
    IF v_existing = 0 THEN v_seeded_know := v_seeded_know + 1;
    ELSE v_updated_know := v_updated_know + 1; END IF;
  END LOOP;

  -- C. Relationships (unquoted table = lowercase in PG)
  FOR v_rel IN SELECT * FROM jsonb_array_elements(coalesce(p_relationships, '[]'::jsonb))
  LOOP
    SELECT count(*) INTO v_existing FROM atlasIndustryRelationships
      WHERE sourceId = v_rel->>'sourceId'
        AND targetId = v_rel->>'targetId'
        AND relationship = v_rel->>'relationship';
    INSERT INTO atlasIndustryRelationships (
      sourceId, targetId, relationship, metadata, corpusVersion
    ) VALUES (
      v_rel->>'sourceId', v_rel->>'targetId', v_rel->>'relationship',
      coalesce(v_rel->'metadata', '{}'::jsonb),
      p_corpus_version
    )
    ON CONFLICT (sourceId, targetId, relationship) DO NOTHING;
    IF v_existing = 0 THEN v_seeded_rels := v_seeded_rels + 1;
    ELSE v_updated_rels := v_updated_rels + 1; END IF;
  END LOOP;

  -- D. Report
  RETURN jsonb_build_object(
    'corpusVersion', p_corpus_version,
    'seededKnowledge', v_seeded_know,
    'updatedKnowledge', v_updated_know,
    'seededProvenance', v_seeded_prov,
    'updatedProvenance', v_updated_prov,
    'seededRelationships', v_seeded_rels,
    'updatedRelationships', v_updated_rels,
    'totalKnowledge', (SELECT count(*)::int FROM "atlasIndustryKnowledge"),
    'totalProvenance', (SELECT count(*)::int FROM "atlasIndustryProvenance"),
    'totalRelationships', (SELECT count(*)::int FROM atlasIndustryRelationships)
  );
END;
$func$;

-- 4. Grant execute
GRANT EXECUTE ON FUNCTION public.industry_ingest_corpus(jsonb, jsonb, jsonb, text) TO authenticated;

-- 5. Verify
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'industry_ingest_corpus') THEN
    RAISE EXCEPTION 'industry_ingest_corpus function was not created';
  END IF;
  RAISE NOTICE 'industry_ingest_corpus function created successfully';
END $$;

SELECT 'Migration complete. Now run the ingestion script: bun run scripts/ingest-corpus.ts' AS status;
