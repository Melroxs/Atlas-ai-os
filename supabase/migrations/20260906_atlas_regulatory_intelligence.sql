-- ---------------------------------------------------------------------------
-- Atlas Regulatory Intelligence — 20260906
--
-- Additive, non-destructive migration for the 51-jurisdiction regulatory
-- intelligence layer: jurisdiction registry, source registry, regulatory
-- propositions (temporal versioning), contradiction records, and observable
-- acquisition jobs.
--
-- Conventions followed:
--   * Shared industry knowledge (global, not tenant-scoped) — same RLS model
--     as 20260826_atlas_knowledge_layer.sql: authenticated users READ,
--     super_admin / atlas_admin MODIFY, service_role full access.
--   * Append-only semantics: propositions are versioned, never overwritten;
--     effective_from / effective_to windows drive claim-date resolution.
--   * Every proposition requires provenance (source_id NOT NULL, FK).
--
-- Status: PENDING APPLY. Do NOT run `supabase db push` (known migration
-- history divergence in this repo); apply this file via the repo's
-- scripts/run-db-sql.mjs convention after review, like the governance
-- migration (20260904) was applied.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Jurisdictions (50 states + DC)
-- ---------------------------------------------------------------------------

create table if not exists public.regulatory_jurisdictions (
  jurisdiction_id text primary key,
  jurisdiction_type text not null check (jurisdiction_type in ('state', 'district')),
  state_code text not null unique check (length(state_code) = 2),
  name text not null,
  active boolean not null default true,
  official_insurance_department_url text,
  official_legislature_url text,
  official_admin_code_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. Source registry
-- ---------------------------------------------------------------------------

create table if not exists public.regulatory_sources (
  source_id text primary key,
  jurisdiction_id text references public.regulatory_jurisdictions (jurisdiction_id) on delete restrict,
  source_type text not null check (source_type in (
    'statute', 'regulation', 'administrative_code', 'regulator_bulletin',
    'regulator_guidance', 'regulator_order', 'court_decision',
    'federal_statute', 'federal_regulation', 'model_law', 'industry_standard',
    'government_manual', 'secondary_reference', 'consumer_guidance'
  )),
  authority_tier int not null check (authority_tier between 1 and 4),
  publisher text not null,
  title text not null,
  canonical_url text,
  source_identifier text,
  citation text,
  document_date timestamptz,
  effective_date timestamptz,
  expiration_date timestamptz,
  retrieved_at timestamptz,
  last_verified_at timestamptz,
  content_hash text,
  status text not null check (status in (
    'REGISTERED', 'DISCOVERED', 'FETCHED', 'PARSED', 'EXTRACTED',
    'VERIFIED', 'FAILED', 'SUPERSEDED', 'STALE'
  )),
  reliability_score numeric(3,2) not null default 0.5 check (reliability_score between 0 and 1),
  accessibility_status text not null default 'unknown' check (accessibility_status in ('unknown', 'reachable', 'unreachable')),
  supersedes_source_id text references public.regulatory_sources (source_id),
  superseded_by_source_id text references public.regulatory_sources (source_id),
  discovery_source_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_reg_sources_jurisdiction on public.regulatory_sources (jurisdiction_id);
create index if not exists idx_reg_sources_status on public.regulatory_sources (status);

-- ---------------------------------------------------------------------------
-- 3. Regulatory propositions (versioned, never overwritten)
-- ---------------------------------------------------------------------------

create table if not exists public.regulatory_propositions (
  proposition_id text primary key,
  jurisdiction_id text not null references public.regulatory_jurisdictions (jurisdiction_id) on delete restrict,
  source_id text not null references public.regulatory_sources (source_id) on delete restrict,
  topic text not null,
  subtopic text,
  rule_text text not null,
  normalized_rule text,
  applicability text,
  actor text not null check (actor in (
    'insurer', 'insured', 'contractor', 'restoration_contractor',
    'public_adjuster', 'independent_adjuster', 'attorney', 'mortgagee',
    'third_party', 'regulator'
  )),
  claim_phase text,
  peril text,
  insurance_type text,
  trigger text,
  requirement text,
  prohibition text,
  exception text,
  deadline int,
  deadline_unit text not null default 'none' check (deadline_unit in (
    'hours', 'business_days', 'calendar_days', 'months', 'years', 'none'
  )),
  condition text,
  effective_from timestamptz,
  effective_to timestamptz,
  citation text,
  authority_tier int not null check (authority_tier between 1 and 4),
  confidence numeric(3,2) not null default 0.5 check (confidence between 0 and 1),
  verification_status text not null default 'UNVERIFIED' check (verification_status in (
    'DISCOVERED', 'FETCHED', 'EXTRACTED', 'UNVERIFIED', 'VERIFIED',
    'PARTIALLY_VERIFIED', 'CONTRADICTED', 'SUPERSEDED', 'STALE', 'FAILED',
    'NEEDS_HUMAN_REVIEW', 'INSUFFICIENT_EVIDENCE'
  )),
  last_verified_at timestamptz,
  supplement_state text check (supplement_state in (
    'explicitly_regulated', 'indirectly_regulated', 'no_identified_specific_provision',
    'insufficient_evidence', 'research_incomplete'
  )),
  dedup_key text not null,
  lineage_key text not null,
  version int not null default 1,
  previous_version_id text references public.regulatory_propositions (proposition_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_reg_prop_jurisdiction on public.regulatory_propositions (jurisdiction_id);
create index if not exists idx_reg_prop_topic on public.regulatory_propositions (topic);
create index if not exists idx_reg_prop_lineage on public.regulatory_propositions (lineage_key, version);
create index if not exists idx_reg_prop_temporal on public.regulatory_propositions (jurisdiction_id, effective_from, effective_to);
create index if not exists idx_reg_prop_status on public.regulatory_propositions (verification_status);

-- ---------------------------------------------------------------------------
-- 4. Contradictions (explicit records, never silently resolved)
-- ---------------------------------------------------------------------------

create table if not exists public.regulatory_contradictions (
  contradiction_id text primary key,
  kind text not null check (kind in (
    'secondary_vs_primary', 'primary_vs_primary', 'old_vs_new_regulation',
    'superseded_source', 'effective_date_overlap', 'state_vs_model_law',
    'extraction_vs_source_text'
  )),
  jurisdiction_id text references public.regulatory_jurisdictions (jurisdiction_id) on delete restrict,
  proposition_a_id text references public.regulatory_propositions (proposition_id) on delete cascade,
  proposition_b_id text references public.regulatory_propositions (proposition_id) on delete cascade,
  source_a_id text not null references public.regulatory_sources (source_id) on delete restrict,
  source_b_id text not null references public.regulatory_sources (source_id) on delete restrict,
  detail text not null,
  severity text not null check (severity in ('HIGH', 'MEDIUM', 'LOW')),
  status text not null default 'OPEN' check (status in ('OPEN', 'RESOLVED')),
  resolution text,
  resolved_by_id uuid references auth.users (id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_reg_contra_jurisdiction on public.regulatory_contradictions (jurisdiction_id);
create index if not exists idx_reg_contra_status on public.regulatory_contradictions (status);

-- ---------------------------------------------------------------------------
-- 5. Acquisition jobs (observable pipeline)
-- ---------------------------------------------------------------------------

create table if not exists public.regulatory_acquisition_jobs (
  job_id text primary key,
  jurisdiction_id text references public.regulatory_jurisdictions (jurisdiction_id) on delete restrict,
  source_id text references public.regulatory_sources (source_id) on delete cascade,
  stage text not null check (stage in (
    'DISCOVERY', 'FETCH', 'PARSE', 'CLASSIFY', 'EXTRACT', 'NORMALIZE',
    'RESOLVE_CITATION', 'VERIFY', 'VERSION', 'INDEX', 'EMBED',
    'QUALITY_CHECK', 'PUBLISH'
  )),
  started_at timestamptz,
  completed_at timestamptz,
  status text not null check (status in ('queued', 'running', 'completed', 'failed', 'partial', 'cancelled')),
  error text,
  retry_count int not null default 0,
  content_hash text,
  previous_hash text,
  change_detected boolean not null default false,
  initiated_by text not null default 'system',
  model_used text,
  created_at timestamptz not null default now()
);

create index if not exists idx_reg_jobs_jurisdiction on public.regulatory_acquisition_jobs (jurisdiction_id);
create index if not exists idx_reg_jobs_status on public.regulatory_acquisition_jobs (status, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS — shared industry knowledge (mirrors 20260826 pattern)
-- ---------------------------------------------------------------------------

alter table public.regulatory_jurisdictions enable row level security;
alter table public.regulatory_sources enable row level security;
alter table public.regulatory_propositions enable row level security;
alter table public.regulatory_contradictions enable row level security;
alter table public.regulatory_acquisition_jobs enable row level security;

-- Read: any authenticated user (the layer is global industry knowledge).
drop policy if exists "regulatory_read" on public.regulatory_jurisdictions;
create policy "regulatory_read" on public.regulatory_jurisdictions
  for select to authenticated using (true);

drop policy if exists "regulatory_sources_read" on public.regulatory_sources;
create policy "regulatory_sources_read" on public.regulatory_sources
  for select to authenticated using (true);

drop policy if exists "regulatory_propositions_read" on public.regulatory_propositions;
create policy "regulatory_propositions_read" on public.regulatory_propositions
  for select to authenticated using (true);

drop policy if exists "regulatory_contradictions_read" on public.regulatory_contradictions;
create policy "regulatory_contradictions_read" on public.regulatory_contradictions
  for select to authenticated using (true);

drop policy if exists "regulatory_jobs_read" on public.regulatory_acquisition_jobs;
create policy "regulatory_jobs_read" on public.regulatory_acquisition_jobs
  for select to authenticated using (true);

-- Modify: super_admin / atlas_admin only (admin curation, acquisition, review).
drop policy if exists "regulatory_admin_write" on public.regulatory_jurisdictions;
create policy "regulatory_admin_write" on public.regulatory_jurisdictions
  for all to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role in ('super_admin', 'atlas_admin')
  ))
  with check (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role in ('super_admin', 'atlas_admin')
  ));

drop policy if exists "regulatory_sources_admin_write" on public.regulatory_sources;
create policy "regulatory_sources_admin_write" on public.regulatory_sources
  for all to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role in ('super_admin', 'atlas_admin')
  ))
  with check (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role in ('super_admin', 'atlas_admin')
  ));

drop policy if exists "regulatory_propositions_admin_write" on public.regulatory_propositions;
create policy "regulatory_propositions_admin_write" on public.regulatory_propositions
  for all to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role in ('super_admin', 'atlas_admin')
  ))
  with check (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role in ('super_admin', 'atlas_admin')
  ));

drop policy if exists "regulatory_contradictions_admin_write" on public.regulatory_contradictions;
create policy "regulatory_contradictions_admin_write" on public.regulatory_contradictions
  for all to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role in ('super_admin', 'atlas_admin')
  ))
  with check (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role in ('super_admin', 'atlas_admin')
  ));

drop policy if exists "regulatory_jobs_admin_write" on public.regulatory_acquisition_jobs;
create policy "regulatory_jobs_admin_write" on public.regulatory_acquisition_jobs
  for all to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role in ('super_admin', 'atlas_admin')
  ))
  with check (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role in ('super_admin', 'atlas_admin')
  ));

-- ---------------------------------------------------------------------------
-- Seed: 51 jurisdictions (50 states + DC)
-- ---------------------------------------------------------------------------

insert into public.regulatory_jurisdictions
  (jurisdiction_id, jurisdiction_type, state_code, name,
   official_insurance_department_url, official_legislature_url, official_admin_code_url)
values
  ('al', 'state', 'AL', 'Alabama', 'https://www.aldoi.gov', null, null),
  ('ak', 'state', 'AK', 'Alaska', 'https://www.commerce.alaska.gov/web/ins/', null, null),
  ('az', 'state', 'AZ', 'Arizona', 'https://insurance.az.gov', 'https://www.azleg.gov/ars/', 'https://www.azsos.gov/rules'),
  ('ar', 'state', 'AR', 'Arkansas', 'https://www.arkansas.gov/insurance/', null, null),
  ('ca', 'state', 'CA', 'California', 'https://www.insurance.ca.gov', 'https://leginfo.legislature.ca.gov', 'https://oal.ca.gov'),
  ('co', 'state', 'CO', 'Colorado', 'https://doi.colorado.gov', 'https://leg.colorado.gov/laws', 'https://www.sos.state.co.us/CCR/'),
  ('ct', 'state', 'CT', 'Connecticut', 'https://portal.ct.gov/CID', null, null),
  ('de', 'state', 'DE', 'Delaware', 'https://insurance.delaware.gov', null, null),
  ('fl', 'state', 'FL', 'Florida', 'https://www.floir.com', 'https://www.leg.state.fl.us/statutes/', 'https://www.flrules.org'),
  ('ga', 'state', 'GA', 'Georgia', 'https://oci.georgia.gov', 'https://www.legis.ga.gov', 'https://rules.sos.ga.gov'),
  ('hi', 'state', 'HI', 'Hawaii', 'https://cca.hawaii.gov/ins/', null, null),
  ('id', 'state', 'ID', 'Idaho', 'https://doi.idaho.gov', null, null),
  ('il', 'state', 'IL', 'Illinois', 'https://insurance.illinois.gov', null, null),
  ('in', 'state', 'IN', 'Indiana', 'https://www.in.gov/idoi/', null, null),
  ('ia', 'state', 'IA', 'Iowa', 'https://iid.iowa.gov', null, null),
  ('ks', 'state', 'KS', 'Kansas', 'https://insurance.kansas.gov', null, null),
  ('ky', 'state', 'KY', 'Kentucky', 'https://insurance.ky.gov', null, null),
  ('la', 'state', 'LA', 'Louisiana', 'https://www.ldi.la.gov', 'https://www.legis.la.gov/legis/LawsToc.aspx', 'https://www.doa.la.gov/Pages/opr/LAC.aspx'),
  ('me', 'state', 'ME', 'Maine', 'https://www.maine.gov/pfr/insurance/', null, null),
  ('md', 'state', 'MD', 'Maryland', 'https://insurance.maryland.gov', 'https://mgaleg.maryland.gov/mgawebsite/Laws/Statutes', 'https://dsd.maryland.gov/Pages/COMARHome.aspx'),
  ('ma', 'state', 'MA', 'Massachusetts', 'https://www.mass.gov/orgs/massachusetts-division-of-insurance', null, null),
  ('mi', 'state', 'MI', 'Michigan', 'https://www.michigan.gov/difs', null, null),
  ('mn', 'state', 'MN', 'Minnesota', 'https://mn.gov/commerce/industries/insurance/', null, null),
  ('ms', 'state', 'MS', 'Mississippi', 'https://www.mid.ms.gov', null, null),
  ('mo', 'state', 'MO', 'Missouri', 'https://insurance.mo.gov', null, null),
  ('mt', 'state', 'MT', 'Montana', 'https://csimt.gov/insurance/', null, null),
  ('ne', 'state', 'NE', 'Nebraska', 'https://doi.nebraska.gov', null, null),
  ('nv', 'state', 'NV', 'Nevada', 'https://doi.nv.gov', null, null),
  ('nh', 'state', 'NH', 'New Hampshire', 'https://www.nh.gov/insurance/', null, null),
  ('nj', 'state', 'NJ', 'New Jersey', 'https://www.nj.gov/dobi/', null, null),
  ('nm', 'state', 'NM', 'New Mexico', 'https://www.osi.state.nm.us', null, null),
  ('ny', 'state', 'NY', 'New York', 'https://www.dfs.ny.gov', 'https://www.nysenate.gov/legislation/laws', 'https://dos.ny.gov/new-york-state-register'),
  ('nc', 'state', 'NC', 'North Carolina', 'https://www.ncdoi.gov', null, null),
  ('nd', 'state', 'ND', 'North Dakota', 'https://www.nd.gov/ndins/', null, null),
  ('oh', 'state', 'OH', 'Ohio', 'https://insurance.ohio.gov', null, null),
  ('ok', 'state', 'OK', 'Oklahoma', 'https://www.oid.ok.gov', null, null),
  ('or', 'state', 'OR', 'Oregon', 'https://dfr.oregon.gov/insurance/Pages/index.aspx', null, null),
  ('pa', 'state', 'PA', 'Pennsylvania', 'https://www.insurance.pa.gov', null, null),
  ('ri', 'state', 'RI', 'Rhode Island', 'https://dbr.ri.gov/divisions/insurance/', null, null),
  ('sc', 'state', 'SC', 'South Carolina', 'https://doi.sc.gov', null, null),
  ('sd', 'state', 'SD', 'South Dakota', 'https://dlr.sd.gov/insurance/', null, null),
  ('tn', 'state', 'TN', 'Tennessee', 'https://www.tn.gov/commerce/insurance.html', null, null),
  ('tx', 'state', 'TX', 'Texas', 'https://www.tdi.texas.gov', 'https://statutes.capitol.texas.gov', 'https://texreg.sos.state.tx.us'),
  ('ut', 'state', 'UT', 'Utah', 'https://insurance.utah.gov', null, null),
  ('vt', 'state', 'VT', 'Vermont', 'https://dfr.vermont.gov/insurance', null, null),
  ('va', 'state', 'VA', 'Virginia', 'https://www.scc.virginia.gov/pages/Bureau-of-Insurance', null, null),
  ('wa', 'state', 'WA', 'Washington', 'https://www.insurance.wa.gov', 'https://app.leg.wa.gov/RCW/', 'https://apps.leg.wa.gov/wac/'),
  ('wv', 'state', 'WV', 'West Virginia', 'https://www.wvinsurance.gov', null, null),
  ('wi', 'state', 'WI', 'Wisconsin', 'https://oci.wi.gov', null, null),
  ('wy', 'state', 'WY', 'Wyoming', 'https://insurance.wy.gov', null, null),
  ('dc', 'district', 'DC', 'District of Columbia', 'https://disb.dc.gov', null, null)
on conflict (jurisdiction_id) do nothing;

-- ---------------------------------------------------------------------------
-- Seed: 51 insurance-department source registry entries + 3 federal sources
-- (REGISTERED — none treated as fetched/verified until the acquisition
-- pipeline runs against them.)
-- ---------------------------------------------------------------------------

insert into public.regulatory_sources
  (source_id, jurisdiction_id, source_type, authority_tier, publisher, title, canonical_url, status, reliability_score)
select lower(state_code) || '-insurance-department', jurisdiction_id, 'regulator_guidance', 2,
       name || ' Department of Insurance', name || ' Insurance Department — Official Registry',
       official_insurance_department_url, 'REGISTERED', 0.9
from public.regulatory_jurisdictions
on conflict (source_id) do nothing;

insert into public.regulatory_sources
  (source_id, jurisdiction_id, source_type, authority_tier, publisher, title, canonical_url, status, reliability_score)
values
  ('us-osha-construction', null, 'federal_regulation', 1,
   'US Occupational Safety and Health Administration (OSHA)',
   'OSHA Construction Standards (29 CFR 1926)',
   'https://www.osha.gov/laws-regs/regulations/standardnumber/1926', 'VERIFIED', 0.95),
  ('us-epa-regulations', null, 'federal_regulation', 1,
   'US Environmental Protection Agency (EPA)',
   'EPA Lead RRP Rule & Asbestos Regulations (40 CFR)',
   'https://www.epa.gov/lead', 'VERIFIED', 0.95),
  ('us-fema-flood-insurance', null, 'federal_regulation', 1,
   'US Federal Emergency Management Agency (FEMA)',
   'FEMA National Flood Insurance Program (NFIP)',
   'https://www.fema.gov/flood-insurance', 'VERIFIED', 0.95)
on conflict (source_id) do nothing;