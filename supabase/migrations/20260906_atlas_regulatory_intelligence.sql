-- Atlas Regulatory Intelligence Wave 1 persistence.
-- Apply through the repository's normal Supabase migration workflow.
-- Raw source content is retained; propositions never replace their evidence.

CREATE TABLE IF NOT EXISTS public.atlas_regulatory_jurisdictions (
  code text PRIMARY KEY,
  name text NOT NULL,
  country text NOT NULL DEFAULT 'US' CHECK (country = 'US'),
  regulator text,
  insurance_department_url text,
  legislature_url text,
  administrative_code_url text,
  wave smallint CHECK (wave IS NULL OR wave = 1),
  wave_group text CHECK (wave_group IS NULL OR wave_group IN ('1A', '1B')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.atlas_regulatory_sources (
  id text PRIMARY KEY,
  jurisdiction_code text NOT NULL REFERENCES public.atlas_regulatory_jurisdictions(code),
  url text NOT NULL,
  canonical_url text NOT NULL,
  title text,
  publisher text,
  kind text NOT NULL CHECK (kind IN ('state_insurance_department','state_legislature','administrative_code','official_bulletin','official_guidance','official_order','official_court','federal','secondary')),
  authority_tier text NOT NULL CHECK (authority_tier IN ('current_enacted_statute','current_administrative_regulation','official_regulator_material','controlling_court_authority','recognized_official_guidance','model_law_or_standard','secondary_reference')),
  relationship text NOT NULL CHECK (relationship IN ('CONTROLLING_AUTHORITY','DISCOVERY_SOURCE','CORROBORATING_SOURCE')),
  discovery_source_id text REFERENCES public.atlas_regulatory_sources(id),
  citation text,
  topics jsonb NOT NULL DEFAULT '[]'::jsonb,
  content_type text,
  content_hash text,
  byte_length bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'DISCOVERED' CHECK (status IN ('DISCOVERED','FETCHED','BLOCKED','FAILED','UNCHANGED')),
  http_status integer,
  raw_content text,
  fetch_error jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  effective_from date,
  effective_to date,
  last_fetched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (canonical_url, version)
);

CREATE TABLE IF NOT EXISTS public.atlas_regulatory_source_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL REFERENCES public.atlas_regulatory_sources(id) ON DELETE CASCADE,
  version integer NOT NULL,
  content_hash text NOT NULL,
  content_type text,
  byte_length bigint NOT NULL DEFAULT 0,
  raw_content text,
  effective_from date,
  effective_to date,
  fetched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, version),
  UNIQUE (source_id, content_hash)
);

CREATE TABLE IF NOT EXISTS public.atlas_regulatory_propositions (
  id text PRIMARY KEY,
  jurisdiction_code text NOT NULL REFERENCES public.atlas_regulatory_jurisdictions(code),
  topic text NOT NULL,
  actor text,
  claim_type text,
  activity text,
  statement text NOT NULL,
  normalized_value jsonb,
  citation jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_id text NOT NULL REFERENCES public.atlas_regulatory_sources(id),
  discovery_source_id text REFERENCES public.atlas_regulatory_sources(id),
  authority_tier text NOT NULL CHECK (authority_tier IN ('current_enacted_statute','current_administrative_regulation','official_regulator_material','controlling_court_authority','recognized_official_guidance','model_law_or_standard','secondary_reference')),
  verification_state text NOT NULL CHECK (verification_state IN ('VERIFIED','UNVERIFIED','PARTIALLY_VERIFIED','INSUFFICIENT_EVIDENCE','NEEDS_HUMAN_REVIEW','CONTRADICTED','SUPERSEDED','STALE')),
  supplement_finding text CHECK (supplement_finding IS NULL OR supplement_finding IN ('EXPLICIT','INDIRECT','NO_SPECIFIC_RULE_IDENTIFIED','INCOMPLETE')),
  effective_from date,
  effective_to date,
  enacted_at date,
  amended_at date,
  repealed_at date,
  superseded_by text REFERENCES public.atlas_regulatory_propositions(id),
  previous_version_id text REFERENCES public.atlas_regulatory_propositions(id),
  verified_at timestamptz,
  evidence_text text,
  evidence_location text,
  confidence numeric CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  requires_human_review boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (verification_state <> 'VERIFIED' OR (evidence_text IS NOT NULL AND citation <> '{}'::jsonb AND authority_tier <> 'secondary_reference'))
);

CREATE TABLE IF NOT EXISTS public.atlas_regulatory_proposition_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposition_id text NOT NULL REFERENCES public.atlas_regulatory_propositions(id) ON DELETE CASCADE,
  version integer NOT NULL,
  statement text NOT NULL,
  normalized_value jsonb,
  verification_state text NOT NULL,
  effective_from date,
  effective_to date,
  source_id text NOT NULL REFERENCES public.atlas_regulatory_sources(id),
  evidence_text text,
  evidence_location text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proposition_id, version)
);

CREATE TABLE IF NOT EXISTS public.atlas_regulatory_contradictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction_code text NOT NULL REFERENCES public.atlas_regulatory_jurisdictions(code),
  source_a_id text NOT NULL REFERENCES public.atlas_regulatory_sources(id),
  source_b_id text NOT NULL REFERENCES public.atlas_regulatory_sources(id),
  proposition_a_id text REFERENCES public.atlas_regulatory_propositions(id),
  proposition_b_id text REFERENCES public.atlas_regulatory_propositions(id),
  authority_tier_a text NOT NULL,
  authority_tier_b text NOT NULL,
  conflict_type text NOT NULL CHECK (conflict_type IN ('DEADLINE','VERSION','AUTHORITY_TIER','SCOPE','OTHER')),
  description text NOT NULL,
  resolution_status text NOT NULL DEFAULT 'OPEN' CHECK (resolution_status IN ('OPEN','RESOLVED_PRIMARY_PREVAILS','NEEDS_HUMAN_REVIEW')),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.atlas_regulatory_review_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction_code text NOT NULL REFERENCES public.atlas_regulatory_jurisdictions(code),
  reason text NOT NULL CHECK (reason IN ('AMBIGUOUS_CITATION','CONFLICTING_AUTHORITIES','UNCLEAR_EFFECTIVE_DATE','INACCESSIBLE_PRIMARY_SOURCE','EXTRACTION_UNCERTAINTY','POSSIBLE_SUPERSESSION','UNUSUAL_JURISDICTION_RULE')),
  source_id text REFERENCES public.atlas_regulatory_sources(id),
  proposition_id text REFERENCES public.atlas_regulatory_propositions(id),
  contradiction_id uuid REFERENCES public.atlas_regulatory_contradictions(id),
  summary text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','APPROVED','REJECTED')),
  reviewer_id uuid REFERENCES auth.users(id),
  reviewer_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.atlas_regulatory_coverage (
  jurisdiction_code text PRIMARY KEY REFERENCES public.atlas_regulatory_jurisdictions(code),
  sources_discovered integer NOT NULL DEFAULT 0,
  primary_sources integer NOT NULL DEFAULT 0,
  secondary_sources integer NOT NULL DEFAULT 0,
  sources_fetched integer NOT NULL DEFAULT 0,
  propositions_extracted integer NOT NULL DEFAULT 0,
  propositions_verified integer NOT NULL DEFAULT 0,
  propositions_requiring_review integer NOT NULL DEFAULT 0,
  contradictions integer NOT NULL DEFAULT 0,
  stale_sources integer NOT NULL DEFAULT 0,
  topics_covered jsonb NOT NULL DEFAULT '[]'::jsonb,
  topics_incomplete jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_freshness text,
  coverage_score numeric NOT NULL DEFAULT 0 CHECK (coverage_score >= 0 AND coverage_score <= 1),
  last_acquisition timestamptz,
  last_verification timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reg_sources_jurisdiction ON public.atlas_regulatory_sources(jurisdiction_code);
CREATE INDEX IF NOT EXISTS idx_reg_sources_hash ON public.atlas_regulatory_sources(content_hash) WHERE content_hash IS NOT NULL AND content_hash <> '';
CREATE INDEX IF NOT EXISTS idx_reg_sources_relationship ON public.atlas_regulatory_sources(relationship, authority_tier);
CREATE INDEX IF NOT EXISTS idx_reg_props_context ON public.atlas_regulatory_propositions(jurisdiction_code, topic, verification_state);
CREATE INDEX IF NOT EXISTS idx_reg_props_dates ON public.atlas_regulatory_propositions(jurisdiction_code, effective_from, effective_to);
CREATE INDEX IF NOT EXISTS idx_reg_props_source ON public.atlas_regulatory_propositions(source_id);
CREATE INDEX IF NOT EXISTS idx_reg_contradictions_jurisdiction ON public.atlas_regulatory_contradictions(jurisdiction_code, resolution_status);
CREATE INDEX IF NOT EXISTS idx_reg_review_queue_status ON public.atlas_regulatory_review_queue(status, jurisdiction_code);

CREATE OR REPLACE FUNCTION public.atlas_regulatory_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reg_jurisdictions_updated_at ON public.atlas_regulatory_jurisdictions;
CREATE TRIGGER trg_reg_jurisdictions_updated_at BEFORE UPDATE ON public.atlas_regulatory_jurisdictions FOR EACH ROW EXECUTE FUNCTION public.atlas_regulatory_set_updated_at();
DROP TRIGGER IF EXISTS trg_reg_sources_updated_at ON public.atlas_regulatory_sources;
CREATE TRIGGER trg_reg_sources_updated_at BEFORE UPDATE ON public.atlas_regulatory_sources FOR EACH ROW EXECUTE FUNCTION public.atlas_regulatory_set_updated_at();
DROP TRIGGER IF EXISTS trg_reg_props_updated_at ON public.atlas_regulatory_propositions;
CREATE TRIGGER trg_reg_props_updated_at BEFORE UPDATE ON public.atlas_regulatory_propositions FOR EACH ROW EXECUTE FUNCTION public.atlas_regulatory_set_updated_at();

ALTER TABLE public.atlas_regulatory_jurisdictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.atlas_regulatory_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.atlas_regulatory_source_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.atlas_regulatory_propositions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.atlas_regulatory_proposition_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.atlas_regulatory_contradictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.atlas_regulatory_review_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.atlas_regulatory_coverage ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'atlas_regulatory_jurisdictions','atlas_regulatory_sources','atlas_regulatory_source_versions',
    'atlas_regulatory_propositions','atlas_regulatory_proposition_versions','atlas_regulatory_contradictions',
    'atlas_regulatory_review_queue','atlas_regulatory_coverage'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "regulatory_authenticated_read" ON public.%I', table_name);
    EXECUTE format('CREATE POLICY "regulatory_authenticated_read" ON public.%I FOR SELECT TO authenticated USING (true)', table_name);
    EXECUTE format('DROP POLICY IF EXISTS "regulatory_service_write" ON public.%I', table_name);
    EXECUTE format('CREATE POLICY "regulatory_service_write" ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', table_name);
    EXECUTE format('DROP POLICY IF EXISTS "regulatory_admin_write" ON public.%I', table_name);
    EXECUTE format($policy$CREATE POLICY "regulatory_admin_write" ON public.%I FOR ALL TO authenticated USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles._id = auth.uid() AND profiles.platform_role IN ('super_admin','atlas_admin'))) WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE profiles._id = auth.uid() AND profiles.platform_role IN ('super_admin','atlas_admin')))$policy$, table_name);
  END LOOP;
END;
$$;

INSERT INTO public.atlas_regulatory_jurisdictions (code, name, country, regulator, insurance_department_url, legislature_url, administrative_code_url, wave, wave_group) VALUES
('AL','Alabama','US',NULL,NULL,NULL,NULL,NULL,NULL),
('AK','Alaska','US',NULL,NULL,NULL,NULL,NULL,NULL),
('AZ','Arizona','US','Arizona Department of Insurance and Financial Institutions','https://difi.az.gov/','https://www.azleg.gov/','https://apps.azsos.gov/public_services/Title_20/20-04.pdf',1,'1B'),
('AR','Arkansas','US',NULL,NULL,NULL,NULL,NULL,NULL),
('CA','California','US','California Department of Insurance','https://www.insurance.ca.gov/','https://leginfo.legislature.ca.gov/','https://oal.ca.gov/publications/ccr/',1,'1A'),
('CO','Colorado','US','Colorado Division of Insurance','https://doi.colorado.gov/','https://leg.colorado.gov/','https://www.sos.state.co.us/CCR/',1,'1A'),
('CT','Connecticut','US',NULL,NULL,NULL,NULL,NULL,NULL),
('DE','Delaware','US',NULL,NULL,NULL,NULL,NULL,NULL),
('FL','Florida','US','Florida Office of Insurance Regulation','https://www.floir.com/','https://www.leg.state.fl.us/','https://www.flrules.org/',1,'1A'),
('GA','Georgia','US','Office of the Georgia Insurance Commissioner','https://oci.georgia.gov/','https://www.legis.ga.gov/','https://rules.sos.ga.gov/',1,'1B'),
('HI','Hawaii','US',NULL,NULL,NULL,NULL,NULL,NULL),
('ID','Idaho','US',NULL,NULL,NULL,NULL,NULL,NULL),
('IL','Illinois','US',NULL,NULL,NULL,NULL,NULL,NULL),
('IN','Indiana','US',NULL,NULL,NULL,NULL,NULL,NULL),
('IA','Iowa','US',NULL,NULL,NULL,NULL,NULL,NULL),
('KS','Kansas','US',NULL,NULL,NULL,NULL,NULL,NULL),
('KY','Kentucky','US',NULL,NULL,NULL,NULL,NULL,NULL),
('LA','Louisiana','US','Louisiana Department of Insurance','https://ldi.la.gov/','https://legis.la.gov/','https://www.doa.la.gov/doa/osr/louisiana-administrative-code/',1,'1B'),
('ME','Maine','US',NULL,NULL,NULL,NULL,NULL,NULL),
('MD','Maryland','US','Maryland Insurance Administration','https://insurance.maryland.gov/','https://mgaleg.maryland.gov/','https://dsd.maryland.gov/Pages/COMARHome.aspx',1,'1B'),
('MA','Massachusetts','US',NULL,NULL,NULL,NULL,NULL,NULL),
('MI','Michigan','US',NULL,NULL,NULL,NULL,NULL,NULL),
('MN','Minnesota','US',NULL,NULL,NULL,NULL,NULL,NULL),
('MS','Mississippi','US',NULL,NULL,NULL,NULL,NULL,NULL),
('MO','Missouri','US',NULL,NULL,NULL,NULL,NULL,NULL),
('MT','Montana','US',NULL,NULL,NULL,NULL,NULL,NULL),
('NE','Nebraska','US',NULL,NULL,NULL,NULL,NULL,NULL),
('NV','Nevada','US',NULL,NULL,NULL,NULL,NULL,NULL),
('NH','New Hampshire','US',NULL,NULL,NULL,NULL,NULL,NULL),
('NJ','New Jersey','US',NULL,NULL,NULL,NULL,NULL,NULL),
('NM','New Mexico','US',NULL,NULL,NULL,NULL,NULL,NULL),
('NY','New York','US','New York Department of Financial Services','https://www.dfs.ny.gov/','https://www.nysenate.gov/legislation/laws/ISC','https://govt.westlaw.com/nycrr/',1,'1A'),
('NC','North Carolina','US',NULL,NULL,NULL,NULL,NULL,NULL),
('ND','North Dakota','US',NULL,NULL,NULL,NULL,NULL,NULL),
('OH','Ohio','US',NULL,NULL,NULL,NULL,NULL,NULL),
('OK','Oklahoma','US',NULL,NULL,NULL,NULL,NULL,NULL),
('OR','Oregon','US',NULL,NULL,NULL,NULL,NULL,NULL),
('PA','Pennsylvania','US',NULL,NULL,NULL,NULL,NULL,NULL),
('RI','Rhode Island','US',NULL,NULL,NULL,NULL,NULL,NULL),
('SC','South Carolina','US',NULL,NULL,NULL,NULL,NULL,NULL),
('SD','South Dakota','US',NULL,NULL,NULL,NULL,NULL,NULL),
('TN','Tennessee','US',NULL,NULL,NULL,NULL,NULL,NULL),
('TX','Texas','US','Texas Department of Insurance','https://www.tdi.texas.gov/','https://statutes.capitol.texas.gov/','https://texreg.sos.state.tx.us/',1,'1A'),
('UT','Utah','US',NULL,NULL,NULL,NULL,NULL,NULL),
('VT','Vermont','US',NULL,NULL,NULL,NULL,NULL,NULL),
('VA','Virginia','US',NULL,NULL,NULL,NULL,NULL,NULL),
('WA','Washington','US','Washington Office of the Insurance Commissioner','https://www.insurance.wa.gov/','https://app.leg.wa.gov/rcw/','https://app.leg.wa.gov/wac/',1,'1B'),
('WV','West Virginia','US',NULL,NULL,NULL,NULL,NULL,NULL),
('WI','Wisconsin','US',NULL,NULL,NULL,NULL,NULL,NULL),
('WY','Wyoming','US',NULL,NULL,NULL,NULL,NULL,NULL),
('DC','District of Columbia','US',NULL,NULL,NULL,NULL,NULL,NULL)
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, regulator = EXCLUDED.regulator, insurance_department_url = EXCLUDED.insurance_department_url, legislature_url = EXCLUDED.legislature_url, administrative_code_url = EXCLUDED.administrative_code_url, wave = EXCLUDED.wave, wave_group = EXCLUDED.wave_group;

GRANT SELECT ON public.atlas_regulatory_jurisdictions, public.atlas_regulatory_sources, public.atlas_regulatory_source_versions, public.atlas_regulatory_propositions, public.atlas_regulatory_proposition_versions, public.atlas_regulatory_contradictions, public.atlas_regulatory_review_queue, public.atlas_regulatory_coverage TO authenticated;
GRANT ALL ON public.atlas_regulatory_jurisdictions, public.atlas_regulatory_sources, public.atlas_regulatory_source_versions, public.atlas_regulatory_propositions, public.atlas_regulatory_proposition_versions, public.atlas_regulatory_contradictions, public.atlas_regulatory_review_queue, public.atlas_regulatory_coverage TO service_role;

-- Durable acquisition queue. A server-side worker claims these jobs and runs the
-- network-capable pipeline; the browser never performs source acquisition.
CREATE TABLE IF NOT EXISTS public.atlas_regulatory_acquisition_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction_code text NOT NULL REFERENCES public.atlas_regulatory_jurisdictions(code),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','COMPLETED','FAILED','RETRYING','CANCELLED')),
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  error jsonb,
  result jsonb,
  requested_by uuid REFERENCES auth.users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_reg_acquisition_jobs_dequeue ON public.atlas_regulatory_acquisition_jobs(status, requested_at) WHERE status IN ('PENDING','RETRYING');
ALTER TABLE public.atlas_regulatory_acquisition_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "regulatory_jobs_read" ON public.atlas_regulatory_acquisition_jobs;
CREATE POLICY "regulatory_jobs_read" ON public.atlas_regulatory_acquisition_jobs FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "regulatory_jobs_service_write" ON public.atlas_regulatory_acquisition_jobs;
CREATE POLICY "regulatory_jobs_service_write" ON public.atlas_regulatory_acquisition_jobs FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "regulatory_jobs_admin_write" ON public.atlas_regulatory_acquisition_jobs;
CREATE POLICY "regulatory_jobs_admin_write" ON public.atlas_regulatory_acquisition_jobs FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE profiles._id = auth.uid() AND profiles.platform_role IN ('super_admin','atlas_admin')) AND requested_by = auth.uid());

CREATE OR REPLACE FUNCTION public.atlas_regulatory_enqueue(p_jurisdiction_code text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  result_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE profiles._id = auth.uid() AND profiles.platform_role IN ('super_admin','atlas_admin')) THEN
    RAISE EXCEPTION 'Regulatory acquisition requires super_admin or atlas_admin';
  END IF;
  INSERT INTO public.atlas_regulatory_acquisition_jobs (jurisdiction_code, requested_by)
  VALUES (upper(p_jurisdiction_code), auth.uid())
  RETURNING id INTO result_id;
  RETURN result_id;
END;
$$;
REVOKE ALL ON FUNCTION public.atlas_regulatory_enqueue(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.atlas_regulatory_enqueue(text) TO authenticated;
GRANT SELECT ON public.atlas_regulatory_acquisition_jobs TO authenticated;
GRANT ALL ON public.atlas_regulatory_acquisition_jobs TO service_role;
