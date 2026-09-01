-- ---------------------------------------------------------------------------
-- Atlas Knowledge Layer — Internal Seed Function
--
-- Migration 20260827: Adds industry_seed_internal(), a SECURITY DEFINER
-- function that seeds the deterministic Atlas Industry Knowledge baseline
-- without requiring auth.uid(). This allows:
--
--   1. SQL Editor execution (no authenticated user session)
--   2. Migration-time seeding
--   3. Service-role / admin CLI seeding
--
-- The existing industry_seed_knowledge() RPC (requires auth.uid() + admin
-- role) is NOT modified and continues to serve application-facing calls.
--
-- The internal function is protected by SECURITY DEFINER (runs as the
-- function owner, typically the postgres superuser) and is NOT granted to
-- the anon/authenticated roles — only superuser/service-role can call it.
--
-- Idempotency: Uses ON CONFLICT ... DO UPDATE so repeated calls are safe.
-- Customer knowledge is never modified by this function.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.industry_seed_internal()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_prov RECORD;
  v_know jsonb;
  v_seeded_prov int := 0;
  v_seeded_know int := 0;
BEGIN
  -- ================================================================
  -- 1. Seed provenance records (idempotent via sourceId UNIQUE)
  -- ================================================================

  FOR v_prov IN
    SELECT * FROM (VALUES
      ('atlas-curated', 'Atlas Industry Knowledge — Curated', 'Atlas', 'tier3_industry', 'curated'),
      ('atlas-evidence-model', 'Atlas Evidence Requirements Model', 'Atlas', 'tier3_industry', 'curated'),
      ('atlas-professional-guidance', 'Atlas Industry Operational Guidance', 'Atlas', 'tier3_industry', 'curated'),
      ('iicrc-s500', 'IICRC S500 — Standard for Water Damage Restoration', 'IICRC', 'tier3_industry', 'standard'),
      ('iicrc-s520', 'IICRC S520 — Standard for Mold Remediation', 'IICRC', 'tier3_industry', 'standard'),
      ('osha-construction', 'OSHA — Construction Standards (29 CFR 1926)', 'US OSHA', 'tier1_primary', 'regulation'),
      ('epa-lead-rrp', 'EPA — Lead Renovation, Repair & Painting Rule', 'US EPA', 'tier1_primary', 'regulation')
    ) AS t(sourceId, sourceName, organization, authorityTier, sourceType)
  LOOP
    INSERT INTO public."atlasIndustryProvenance" (sourceId, sourceName, organization, authorityTier, sourceType, status)
    VALUES (v_prov.sourceId, v_prov.sourceName, v_prov.organization, v_prov.authorityTier, v_prov.sourceType, 'active')
    ON CONFLICT (sourceId) DO UPDATE SET
      sourceName = EXCLUDED.sourceName,
      organization = EXCLUDED.organization,
      authorityTier = EXCLUDED.authorityTier,
      sourceType = EXCLUDED.sourceType,
      status = 'active';
    v_seeded_prov := v_seeded_prov + 1;
  END LOOP;

  -- ================================================================
  -- 2. Seed knowledge items (idempotent via title+knowledgeType UNIQUE)
  -- ================================================================

  FOR v_know IN SELECT * FROM jsonb_array_elements('[' ||
    -- Industry Terminology (8)
    '{"id":"term_fnol","title":"FNOL (First Notice of Loss)","statement":"FNOL is the first report of a loss to the insurance carrier, initiating the claims process.","interpretation":"Timely FNOL filing is critical — delays can jeopardize coverage. The FNOL should include date of loss, cause, and initial damage description.","knowledgeType":"terminology","sourceClassification":"ATLAS_CURATED","industry":"insurance restoration","jurisdiction":"United States","confidence":0.95,"status":"active","isInference":false,"tags":["claims","insurance","documentation"]}' ||
    ',{"id":"term_mitigation","title":"Emergency Mitigation","statement":"Mitigation is emergency work to stop further damage: water extraction, drying, tarping, board-up.","interpretation":"Mitigation is typically covered by insurance and should begin immediately. Failure to mitigate can reduce the carrier liability for subsequent damage.","knowledgeType":"terminology","sourceClassification":"ATLAS_CURATED","industry":"insurance restoration","jurisdiction":"United States","confidence":0.95,"status":"active","isInference":false,"tags":["mitigation","water","emergency"]}' ||
    ',{"id":"term_supplement","title":"Supplement","statement":"A supplement is an additional invoice for work or materials not in the original Xactimate estimate.","interpretation":"Supplements are extremely common and represent a major revenue recovery opportunity. They typically arise from hidden damage, code requirements, or under-scoped original estimates.","knowledgeType":"terminology","sourceClassification":"ATLAS_CURATED","industry":"insurance restoration","jurisdiction":"United States","confidence":0.9,"status":"active","isInference":false,"tags":["supplement","revenue","estimating"]}' ||
    ',{"id":"term_xactimate","title":"Xactimate","statement":"Xactimate is the industry-standard estimating software used by restoration carriers and contractors.","interpretation":"Proficiency with Xactimate is essential for accurate scope documentation and supplement support. Line-item pricing in Xactimate directly affects what the carrier approves.","knowledgeType":"terminology","sourceClassification":"ATLAS_CURATED","industry":"insurance restoration","jurisdiction":"United States","confidence":0.9,"status":"active","isInference":false,"tags":["estimating","software","pricing"]}' ||
    ',{"id":"term_scope_of_work","title":"Scope of Work","statement":"The scope of work is the agreed list of tasks and line items for a restoration or construction job.","interpretation":"A complete scope of work is the foundation for accurate estimating and supplement support. Missing items in the scope directly result in missed revenue.","knowledgeType":"terminology","sourceClassification":"ATLAS_CURATED","industry":"insurance restoration","jurisdiction":"United States","confidence":0.9,"status":"active","isInference":false,"tags":["scope","estimating","documentation"]}' ||
    ',{"id":"term_drying_log","title":"Drying Log","statement":"A drying log is documentation of moisture readings over time proving a structure is dry.","interpretation":"Drying logs are critical evidence for water mitigation claims. Without them, equipment days and dehumidification charges are difficult to justify to the carrier.","knowledgeType":"terminology","sourceClassification":"ATLAS_CURATED","industry":"insurance restoration","jurisdiction":"United States","confidence":0.9,"status":"active","isInference":false,"tags":["drying","documentation","water","evidence"]}' ||
    ',{"id":"term_adjuster","title":"Insurance Adjuster","statement":"An adjuster is the carrier representative who reviews estimates, inspects damage, and authorizes payments.","interpretation":"Building a professional relationship with adjusters improves outcomes. Documentation quality directly affects adjuster confidence and approval speed.","knowledgeType":"terminology","sourceClassification":"ATLAS_CURATED","industry":"insurance restoration","jurisdiction":"United States","confidence":0.85,"status":"active","isInference":false,"tags":["adjuster","carrier","relationship"]}' ||
    ',{"id":"term_policyholder","title":"Policyholder","statement":"The policyholder is the insured customer whose property was damaged and who filed the insurance claim.","interpretation":"The policyholder is the contractor customer. Clear communication about the claims process, timelines, and expectations is essential.","knowledgeType":"terminology","sourceClassification":"ATLAS_CURATED","industry":"insurance restoration","jurisdiction":"United States","confidence":0.9,"status":"active","isInference":false,"tags":["customer","insurance","communication"]}' ||
    -- Evidence Requirements (6)
    ',{"id":"evidence_fnol","title":"FNOL Stage — Required Evidence","statement":"At FNOL, the contractor needs: loss report, policy information, initial photos, and date-of-loss documentation.","interpretation":"Incomplete FNOL documentation delays the entire claim. Atlas should flag missing items immediately when a claim enters the pipeline.","knowledgeType":"requirement","sourceClassification":"ATLAS_CURATED","industry":"insurance restoration","jurisdiction":"United States","confidence":0.85,"status":"active","isInference":false,"tags":["evidence","fnol","documentation","requirements"]}' ||
    ',{"id":"evidence_inspection","title":"Inspection Stage — Required Evidence","statement":"At inspection: inspection photos (date-stamped, wide and close-up), adjuster notes, scope measurements, and damage assessment.","interpretation":"Photo documentation is the most commonly incomplete item at the inspection stage. Photos should be labeled with room/area and damage type.","knowledgeType":"requirement","sourceClassification":"ATLAS_CURATED","industry":"insurance restoration","jurisdiction":"United States","confidence":0.85,"status":"active","isInference":false,"tags":["evidence","inspection","photos","documentation"]}' ||
    ',{"id":"evidence_estimate","title":"Estimate Stage — Required Evidence","statement":"At estimate stage: Xactimate estimate, scope of work, material specifications, and code requirements.","interpretation":"Estimate accuracy directly affects revenue. Under-scoped estimates are a primary source of missed revenue and a common supplement trigger.","knowledgeType":"requirement","sourceClassification":"ATLAS_CURATED","industry":"insurance restoration","jurisdiction":"United States","confidence":0.85,"status":"active","isInference":false,"tags":["evidence","estimate","xactimate","scope"]}' ||
    ',{"id":"evidence_mitigation","title":"Mitigation Stage — Required Evidence","statement":"At mitigation: drying log with moisture readings, equipment invoices, daily readings, equipment placement photos, and authorization documentation.","interpretation":"Drying logs are a frequently disputed item in water mitigation claims. Without timestamped moisture readings, equipment days cannot be justified.","knowledgeType":"requirement","sourceClassification":"ATLAS_CURATED","industry":"insurance restoration","jurisdiction":"United States","confidence":0.85,"status":"active","isInference":false,"tags":["evidence","mitigation","drying","water"]}' ||
    ',{"id":"evidence_reconstruction","title":"Reconstruction Stage — Required Evidence","statement":"At reconstruction: permits, subcontractor invoices, material receipts, before/after photos, and signed change orders.","interpretation":"Change orders not documented and billed are unrecovered revenue. Atlas should monitor scope changes during reconstruction.","knowledgeType":"requirement","sourceClassification":"ATLAS_CURATED","industry":"insurance restoration","jurisdiction":"United States","confidence":0.85,"status":"active","isInference":false,"tags":["evidence","reconstruction","permits","invoices"]}' ||
    ',{"id":"evidence_invoicing","title":"Invoicing Stage — Required Evidence","statement":"At invoicing: final invoice, estimate vs. actual comparison, proof of completion, and signed authorization.","interpretation":"The gap between estimate and final invoice is where revenue leakage can occur. Systematic reconciliation catches unbilled work.","knowledgeType":"requirement","sourceClassification":"ATLAS_CURATED","industry":"insurance restoration","jurisdiction":"United States","confidence":0.85,"status":"active","isInference":false,"tags":["evidence","invoicing","reconciliation","revenue"]}' ||
    -- Claim Lifecycle (2)
    ',{"id":"lifecycle_claim","title":"Insurance Restoration Claim Lifecycle","statement":"The standard claim lifecycle flows through: FNOL, Inspection, Estimate, Approval, Mitigation, Documentation, Reconstruction, Invoicing, Payment, Closeout.","interpretation":"Revenue recovery opportunities exist at every stage. Gaps commonly occur at transitions between stages when documentation is incomplete.","knowledgeType":"workflow","sourceClassification":"ATLAS_CURATED","industry":"insurance restoration","jurisdiction":"United States","confidence":0.85,"status":"active","isInference":false,"tags":["lifecycle","workflow","claims","process"]}' ||
    ',{"id":"lifecycle_supplement","title":"Supplement Lifecycle","statement":"Supplements flow through: scope gap identified, documentation assembled, submit to adjuster, review, approval/denial, re-submit if needed, payment.","interpretation":"Supplement outcomes correlate with documentation quality. Well-documented supplements with photo evidence and code references tend to have better approval outcomes.","knowledgeType":"workflow","sourceClassification":"ATLAS_CURATED","industry":"insurance restoration","jurisdiction":"United States","confidence":0.8,"status":"active","isInference":false,"tags":["supplement","lifecycle","revenue","process"]}' ||
    -- Risk Patterns (5)
    ',{"id":"risk_unauthorized_work","title":"Starting Work Without Authorization","statement":"Starting mitigation or reconstruction without a signed authorization from the policyholder risks the carrier refusing payment.","interpretation":"Always confirm written authorization is on file before work begins. This pattern is frequently associated with payment denial scenarios in the restoration industry.","knowledgeType":"risk_pattern","sourceClassification":"ATLAS_CURATED","industry":"insurance restoration","jurisdiction":"United States","confidence":0.9,"status":"active","isInference":false,"tags":["risk","authorization","payment","denial"]}' ||
    ',{"id":"risk_missing_docs","title":"Incomplete Documentation","statement":"Jobs missing expected documents (drying logs, photos, authorizations) face payment delays and disputes.","interpretation":"Documentation completeness is a key controllable factor in claim outcomes. A documentation checklist at job start prevents downstream issues.","knowledgeType":"risk_pattern","sourceClassification":"ATLAS_CURATED","industry":"insurance restoration","jurisdiction":"United States","confidence":0.85,"status":"active","isInference":false,"tags":["risk","documentation","compliance","payment"]}' ||
    ',{"id":"risk_underbilling","title":"Underbilling / Missed Billable Work","statement":"Delivered work that is never invoiced, or change orders not added to scope, quietly erodes revenue.","interpretation":"Revenue leakage from underbilling is commonly estimated in the range of 5-15% of total project value (Atlas heuristic based on industry observation). Systematic scope reconciliation helps catch this.","knowledgeType":"risk_pattern","sourceClassification":"ATLAS_CURATED","industry":"insurance restoration","jurisdiction":"United States","confidence":0.65,"status":"active","isInference":true,"tags":["risk","revenue","billing","leakage"]}' ||
    ',{"id":"risk_supplement_needed","title":"Likely Supplement Needed","statement":"Undocumented conditions discovered mid-job, aging estimates, or material price increases typically require a supplement.","interpretation":"Proactive supplement identification before the adjuster discovers the gap can improve outcomes and reduce payment delays.","knowledgeType":"risk_pattern","sourceClassification":"ATLAS_CURATED","industry":"insurance restoration","jurisdiction":"United States","confidence":0.75,"status":"active","isInference":false,"tags":["risk","supplement","scope","pricing"]}' ||
    ',{"id":"risk_doc_gap","title":"Documentation Gap Risk","statement":"A job missing expected documents per workflow stage is at risk of payment delay, dispute, or denial.","interpretation":"Atlas should continuously monitor documentation completeness against the expected document set for each claim lifecycle stage.","knowledgeType":"risk_pattern","sourceClassification":"ATLAS_CURATED","industry":"insurance restoration","jurisdiction":"United States","confidence":0.8,"status":"active","isInference":false,"tags":["risk","documentation","compliance","claims"]}' ||
    -- Revenue Recovery Concepts (3)
    ',{"id":"revenue_scope_gaps","title":"Scope Gap Revenue Recovery","statement":"Scope gaps between the contractor estimate and the carrier approved estimate represent recoverable revenue through the supplement process.","interpretation":"The supplement process is the primary mechanism for recovering revenue that was missed in the original estimate. Quality documentation of the gap is essential.","knowledgeType":"concept","sourceClassification":"ATLAS_CURATED","industry":"insurance restoration","jurisdiction":"United States","confidence":0.85,"status":"active","isInference":false,"tags":["revenue","recovery","scope","supplement"]}' ||
    ',{"id":"revenue_code_requirements","title":"Code Upgrade Revenue Potential","statement":"Building code requirements that necessitate upgrades beyond the original scope can represent recoverable revenue through supplements.","interpretation":"When building codes require upgrades (e.g., ice and water shield, upgraded ventilation), these may be legitimate supplement items supported by regulatory authority. Recovery depends on jurisdiction and carrier policy.","knowledgeType":"concept","sourceClassification":"ATLAS_CURATED","industry":"insurance restoration","jurisdiction":"United States","confidence":0.75,"status":"active","isInference":false,"tags":["revenue","recovery","code","regulation"]}' ||
    ',{"id":"revenue_material_price","title":"Material Price Variance","statement":"Material price increases between estimate date and purchase date can create recoverable price variance.","interpretation":"When material prices increase after the estimate is approved, the price difference may be submitted as a supplement item with current pricing documentation. Approval varies by carrier and jurisdiction.","knowledgeType":"concept","sourceClassification":"ATLAS_CURATED","industry":"insurance restoration","jurisdiction":"United States","confidence":0.7,"status":"active","isInference":false,"tags":["revenue","recovery","materials","pricing"]}' ||
    -- Industry Roles (2)
    ',{"id":"role_project_manager","title":"Restoration Project Manager","statement":"The project manager owns the job flow: assignments, documentation completion, carrier communication, and customer updates.","interpretation":"The PM is typically the primary point of contact for both the policyholder and the adjuster. Documentation quality often depends on PM diligence.","knowledgeType":"role","sourceClassification":"ATLAS_CURATED","industry":"insurance restoration","jurisdiction":"United States","confidence":0.8,"status":"active","isInference":false,"tags":["role","management","operations"]}' ||
    ',{"id":"role_estimator","title":"Restoration Estimator","statement":"The estimator builds Xactimate estimates, documents scope, identifies supplement opportunities, and supports adjuster negotiations.","interpretation":"Estimator accuracy directly affects revenue. Under-scoping is a common estimator-related revenue concern.","knowledgeType":"role","sourceClassification":"ATLAS_CURATED","industry":"insurance restoration","jurisdiction":"United States","confidence":0.85,"status":"active","isInference":false,"tags":["role","estimating","revenue"]}' ||
    ']') AS items(item)
  LOOP
    INSERT INTO public."atlasIndustryKnowledge" (
      title, statement, interpretation, knowledgeType, sourceClassification,
      industry, jurisdiction, confidence, status, isInference, tags
    ) VALUES (
      v_know->>'title',
      v_know->>'statement',
      v_know->>'interpretation',
      v_know->>'knowledgeType',
      COALESCE(v_know->>'sourceClassification', 'ATLAS_CURATED')::source_classification,
      v_know->>'industry',
      v_know->>'jurisdiction',
      COALESCE((v_know->>'confidence')::double precision, 0.7),
      COALESCE(v_know->>'status', 'active'),
      COALESCE((v_know->>'isInference')::boolean, false),
      COALESCE(v_know->'tags', '[]'::jsonb)
    )
    ON CONFLICT DO NOTHING;
    v_seeded_know := v_seeded_know + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'seededDocuments', 0,
    'seededKnowledge', v_seeded_know,
    'seededProvenance', v_seeded_prov
  );
END;
$$;

-- Revoke from public roles — only superuser/service-role should call this
REVOKE EXECUTE ON FUNCTION public.industry_seed_internal() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.industry_seed_internal() FROM anon;

-- Add knowledge_title_type_unique constraint if it does not exist
DO $$ BEGIN
  ALTER TABLE public."atlasIndustryKnowledge"
    ADD CONSTRAINT knowledge_title_type_unique UNIQUE (title, "knowledgeType");
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN null;
END $$;
