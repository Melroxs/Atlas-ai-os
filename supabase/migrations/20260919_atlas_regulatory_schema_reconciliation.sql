-- ============================================================================
-- Atlas — regulatory schema reconciliation (20260919)
--
-- FORWARD-ONLY. Never rename 20260906_atlas_regulatory_intelligence.sql to the
-- production version key `20260906192230`, and never mark that production
-- version as applied from the repository draft. This migration does not claim
-- the draft has run anywhere; it makes the repository's chain reproducible and
-- compatible with what production already carries.
--
-- ----------------------------------------------------------------------------
-- THE DIVERGENCE (verified 2026-09)
-- ----------------------------------------------------------------------------
-- Production history contains version `20260906192230`, name
-- `atlas_regulatory_intelligence`, applied through the Management API
-- migrations endpoint (scripts/apply-regulatory-migration.mjs), which assigns a
-- server-generated 14-digit version instead of the filename version key. The
-- bodies are NOT equivalent:
--
--   * Production carries NINE prefixed tables — the shape
--     src/lib/regulatory/store.ts reads, src/lib/regulatory/legacy.ts types,
--     scripts/verify-regulatory-schema.ts verifies, and
--     supabase/verification/20260906_atlas_regulatory_verification.sql asserts:
--       atlas_regulatory_jurisdictions        (code PK, wave, wave_group, …)
--       atlas_regulatory_sources              (id PK, content_hash, …)
--       atlas_regulatory_source_versions      (source_id, version) unique
--       atlas_regulatory_propositions         (verification_state, …)
--       atlas_regulatory_proposition_versions (proposition_id, version) unique
--       atlas_regulatory_contradictions       (resolution_status, …)
--       atlas_regulatory_review_queue         (status, reviewer_id, …)
--       atlas_regulatory_coverage             (jurisdiction_code PK, …)
--       atlas_regulatory_acquisition_jobs     (status, requested_at, …)
--
--   * The repository draft creates FIVE unprefixed `regulatory_*` tables that
--     exist nowhere in production and that no application code reads.
--
-- ----------------------------------------------------------------------------
-- RESOLUTION
-- ----------------------------------------------------------------------------
--   1. Drop the five orphan unprefixed tables (they hold only the draft's seed
--      rows on a from-scratch replay; production has no data in them because
--      they were never created there). No production regulatory data is
--      touched.
--   2. (Re)create the nine canonical tables with `if not exists` — a no-op
--      where production already has them, the reproducible shape everywhere
--      else — with the indexes, RLS and `regulatory*` policies the verification
--      script asserts, and the 51-jurisdiction seed (10 Wave 1).
--   3. Re-create admin_prepare_user_deletion against the canonical schema so an
--      environment that already applied the old (obsolete-object) body is
--      repaired without editing history.
--
-- Additive and replay-safe: `if not exists`, `on conflict do nothing`, and
-- catalog-driven lookups only. It never deletes regulatory rows and never
-- renames a production table.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Remove the orphan unprefixed tables created only by the never-applied draft
-- ----------------------------------------------------------------------------
-- Child-first so no FK blocks the drop. `if exists` makes this a no-op in
-- production, which never had these objects.
drop table if exists public.regulatory_contradictions;
drop table if exists public.regulatory_acquisition_jobs;
drop table if exists public.regulatory_propositions;
drop table if exists public.regulatory_sources;
drop table if exists public.regulatory_jurisdictions;


-- ----------------------------------------------------------------------------
-- 2. The nine canonical tables
-- ----------------------------------------------------------------------------

-- 2.1 Jurisdictions (50 states + DC)
create table if not exists public.atlas_regulatory_jurisdictions (
  code                       text primary key,
  name                       text not null,
  country                    text not null default 'US',
  regulator                  text,
  insurance_department_url   text,
  legislature_url            text,
  administrative_code_url    text,
  wave                       int,
  wave_group                 text,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

-- 2.2 Source registry
create table if not exists public.atlas_regulatory_sources (
  id                  text primary key,
  jurisdiction_code   text,
  url                 text,
  canonical_url       text,
  title               text,
  publisher           text,
  kind                text,
  authority_tier      text,
  relationship        text,
  discovery_source_id text,
  citation            text,
  topics              text[] not null default '{}',
  content_type        text,
  content_hash        text,
  byte_length         bigint,
  status              text,
  http_status         int,
  raw_content         text,
  fetch_error         jsonb,
  version             int not null default 1,
  effective_from      bigint,
  effective_to        bigint,
  last_fetched_at     timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_reg_sources_jurisdiction
  on public.atlas_regulatory_sources (jurisdiction_code);
create index if not exists idx_reg_sources_hash
  on public.atlas_regulatory_sources (content_hash);
create index if not exists idx_reg_sources_relationship
  on public.atlas_regulatory_sources (relationship);

-- 2.3 Immutable source versions
create table if not exists public.atlas_regulatory_source_versions (
  id              uuid primary key default gen_random_uuid(),
  source_id       text not null,
  version         int not null default 1,
  content_hash    text,
  content_type    text,
  byte_length     bigint,
  raw_content     text,
  effective_from  bigint,
  effective_to    bigint,
  fetched_at      timestamptz,
  created_at      timestamptz not null default now(),
  unique (source_id, version)
);

-- 2.4 Regulatory propositions (versioned, never overwritten)
create table if not exists public.atlas_regulatory_propositions (
  id                    text primary key,
  jurisdiction_code     text not null,
  topic                 text not null,
  actor                 text,
  claim_type            text,
  activity              text,
  statement             text not null,
  normalized_value      text,
  citation              jsonb,
  source_id             text,
  discovery_source_id   text,
  authority_tier        text,
  verification_state    text not null default 'UNVERIFIED',
  supplement_finding    text,
  effective_from        bigint,
  effective_to          bigint,
  enacted_at            bigint,
  amended_at            bigint,
  repealed_at           bigint,
  superseded_by         text,
  previous_version_id   text,
  verified_at           timestamptz,
  evidence_text         text,
  evidence_location     text,
  confidence            numeric,
  requires_human_review boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists idx_reg_props_context
  on public.atlas_regulatory_propositions (jurisdiction_code, topic);
create index if not exists idx_reg_props_dates
  on public.atlas_regulatory_propositions (effective_from, effective_to);
create index if not exists idx_reg_props_source
  on public.atlas_regulatory_propositions (source_id);

-- 2.5 Proposition version history
create table if not exists public.atlas_regulatory_proposition_versions (
  id                uuid primary key default gen_random_uuid(),
  proposition_id    text not null,
  version           int not null default 1,
  statement         text,
  normalized_value  text,
  verification_state text,
  effective_from    bigint,
  effective_to      bigint,
  source_id         text,
  evidence_text     text,
  evidence_location text,
  created_at        timestamptz not null default now(),
  unique (proposition_id, version)
);

-- 2.6 Contradictions (recorded, never silently resolved)
create table if not exists public.atlas_regulatory_contradictions (
  id                uuid primary key default gen_random_uuid(),
  jurisdiction_code text,
  source_a_id       text,
  source_b_id       text,
  proposition_a_id  text,
  proposition_b_id  text,
  authority_tier_a  text,
  authority_tier_b  text,
  conflict_type     text,
  description       text,
  resolution_status text not null default 'NEEDS_HUMAN_REVIEW',
  resolved_by_id    uuid,
  resolved_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_reg_contradictions_jurisdiction
  on public.atlas_regulatory_contradictions (jurisdiction_code);

-- 2.7 Human review queue
create table if not exists public.atlas_regulatory_review_queue (
  id                uuid primary key default gen_random_uuid(),
  jurisdiction_code text,
  reason            text,
  source_id         text,
  proposition_id    text,
  contradiction_id  text,
  summary           text,
  status            text not null default 'OPEN',
  reviewer_id       uuid,
  reviewer_notes    text,
  resolved_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_reg_review_queue_status
  on public.atlas_regulatory_review_queue (status);

-- 2.8 Coverage report
create table if not exists public.atlas_regulatory_coverage (
  jurisdiction_code             text primary key,
  sources_discovered            int not null default 0,
  primary_sources               int not null default 0,
  secondary_sources             int not null default 0,
  sources_fetched               int not null default 0,
  propositions_extracted        int not null default 0,
  propositions_verified         int not null default 0,
  propositions_requiring_review int not null default 0,
  contradictions                int not null default 0,
  stale_sources                 int not null default 0,
  topics_covered                text[] not null default '{}',
  topics_incomplete             text[] not null default '{}',
  source_freshness              text,
  coverage_score                numeric,
  last_acquisition              text,
  last_verification             text,
  updated_at                    timestamptz not null default now()
);

-- 2.9 Acquisition jobs (observable pipeline)
create table if not exists public.atlas_regulatory_acquisition_jobs (
  id                uuid primary key default gen_random_uuid(),
  jurisdiction_code text,
  job_type          text,
  status            text not null default 'PENDING',
  priority          int not null default 3,
  attempt_count     int not null default 0,
  max_attempts      int not null default 3,
  requested_at      timestamptz not null default now(),
  started_at        timestamptz,
  completed_at      timestamptz,
  result            jsonb,
  error             jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_reg_acquisition_jobs_dequeue
  on public.atlas_regulatory_acquisition_jobs (status, requested_at);


-- ----------------------------------------------------------------------------
-- 3. Row-Level Security — shared industry knowledge
-- ----------------------------------------------------------------------------
-- Mirror of the 20260826 knowledge-layer model: authenticated users READ,
-- super_admin / atlas_admin MODIFY, service_role full access. anon has no
-- policy here, so its inherited table grants resolve to zero rows.

alter table public.atlas_regulatory_jurisdictions        enable row level security;
alter table public.atlas_regulatory_sources              enable row level security;
alter table public.atlas_regulatory_source_versions      enable row level security;
alter table public.atlas_regulatory_propositions         enable row level security;
alter table public.atlas_regulatory_proposition_versions enable row level security;
alter table public.atlas_regulatory_contradictions       enable row level security;
alter table public.atlas_regulatory_review_queue         enable row level security;
alter table public.atlas_regulatory_coverage             enable row level security;
alter table public.atlas_regulatory_acquisition_jobs     enable row level security;

do $$
declare
  t text;
  tables text[] := array[
    'atlas_regulatory_jurisdictions',
    'atlas_regulatory_sources',
    'atlas_regulatory_source_versions',
    'atlas_regulatory_propositions',
    'atlas_regulatory_proposition_versions',
    'atlas_regulatory_contradictions',
    'atlas_regulatory_review_queue',
    'atlas_regulatory_coverage',
    'atlas_regulatory_acquisition_jobs'
  ];
begin
  foreach t in array tables loop
    execute format('grant select, insert, update, delete on public.%I to authenticated, service_role', t);

    execute format('drop policy if exists regulatory_read on public.%I', t);
    execute format(
      'create policy regulatory_read on public.%I for select to authenticated using (true)', t
    );

    execute format('drop policy if exists regulatory_admin_write on public.%I', t);
    execute format(
      'create policy regulatory_admin_write on public.%I for all to authenticated '
      || 'using (exists (select 1 from public.profiles p where p._id = auth.uid() '
      || 'and p.platform_role in (''super_admin'', ''atlas_admin''))) '
      || 'with check (exists (select 1 from public.profiles p where p._id = auth.uid() '
      || 'and p.platform_role in (''super_admin'', ''atlas_admin'')))',
      t
    );
  end loop;
end $$;


-- ----------------------------------------------------------------------------
-- 4. Seed — 51 jurisdictions (50 states + DC), Wave 1 marked
-- ----------------------------------------------------------------------------
insert into public.atlas_regulatory_jurisdictions
  (code, name, country, wave, wave_group,
   insurance_department_url, legislature_url, administrative_code_url)
values
  ('AL','Alabama','US',2,'wave_2','https://www.aldoi.gov',null,null),
  ('AK','Alaska','US',2,'wave_2','https://www.commerce.alaska.gov/web/ins/',null,null),
  ('AZ','Arizona','US',1,'wave_1','https://insurance.az.gov','https://www.azleg.gov/ars/','https://www.azsos.gov/rules'),
  ('AR','Arkansas','US',2,'wave_2','https://www.arkansas.gov/insurance/',null,null),
  ('CA','California','US',1,'wave_1','https://www.insurance.ca.gov','https://leginfo.legislature.ca.gov','https://oal.ca.gov'),
  ('CO','Colorado','US',1,'wave_1','https://doi.colorado.gov','https://leg.colorado.gov/laws','https://www.sos.state.co.us/CCR/'),
  ('CT','Connecticut','US',2,'wave_2','https://portal.ct.gov/CID',null,null),
  ('DE','Delaware','US',2,'wave_2','https://insurance.delaware.gov',null,null),
  ('FL','Florida','US',1,'wave_1','https://www.floir.com','https://www.leg.state.fl.us/statutes/','https://www.flrules.org'),
  ('GA','Georgia','US',1,'wave_1','https://oci.georgia.gov','https://www.legis.ga.gov','https://rules.sos.ga.gov'),
  ('HI','Hawaii','US',2,'wave_2','https://cca.hawaii.gov/ins/',null,null),
  ('ID','Idaho','US',2,'wave_2','https://doi.idaho.gov',null,null),
  ('IL','Illinois','US',2,'wave_2','https://insurance.illinois.gov',null,null),
  ('IN','Indiana','US',2,'wave_2','https://www.in.gov/idoi/',null,null),
  ('IA','Iowa','US',2,'wave_2','https://iid.iowa.gov',null,null),
  ('KS','Kansas','US',2,'wave_2','https://insurance.kansas.gov',null,null),
  ('KY','Kentucky','US',2,'wave_2','https://insurance.ky.gov',null,null),
  ('LA','Louisiana','US',1,'wave_1','https://www.ldi.la.gov','https://www.legis.la.gov/legis/LawsToc.aspx','https://www.doa.la.gov/Pages/opr/LAC.aspx'),
  ('ME','Maine','US',2,'wave_2','https://www.maine.gov/pfr/insurance/',null,null),
  ('MD','Maryland','US',1,'wave_1','https://insurance.maryland.gov','https://mgaleg.maryland.gov/mgawebsite/Laws/Statutes','https://dsd.maryland.gov/Pages/COMARHome.aspx'),
  ('MA','Massachusetts','US',2,'wave_2','https://www.mass.gov/orgs/massachusetts-division-of-insurance',null,null),
  ('MI','Michigan','US',2,'wave_2','https://www.michigan.gov/difs',null,null),
  ('MN','Minnesota','US',2,'wave_2','https://mn.gov/commerce/industries/insurance/',null,null),
  ('MS','Mississippi','US',2,'wave_2','https://www.mid.ms.gov',null,null),
  ('MO','Missouri','US',2,'wave_2','https://insurance.mo.gov',null,null),
  ('MT','Montana','US',2,'wave_2','https://csimt.gov/insurance/',null,null),
  ('NE','Nebraska','US',2,'wave_2','https://doi.nebraska.gov',null,null),
  ('NV','Nevada','US',2,'wave_2','https://doi.nv.gov',null,null),
  ('NH','New Hampshire','US',2,'wave_2','https://www.nh.gov/insurance/',null,null),
  ('NJ','New Jersey','US',2,'wave_2','https://www.nj.gov/dobi/',null,null),
  ('NM','New Mexico','US',2,'wave_2','https://www.osi.state.nm.us',null,null),
  ('NY','New York','US',1,'wave_1','https://www.dfs.ny.gov','https://www.nysenate.gov/legislation/laws','https://dos.ny.gov/new-york-state-register'),
  ('NC','North Carolina','US',2,'wave_2','https://www.ncdoi.gov',null,null),
  ('ND','North Dakota','US',2,'wave_2','https://www.nd.gov/ndins/',null,null),
  ('OH','Ohio','US',2,'wave_2','https://insurance.ohio.gov',null,null),
  ('OK','Oklahoma','US',2,'wave_2','https://www.oid.ok.gov',null,null),
  ('OR','Oregon','US',2,'wave_2','https://dfr.oregon.gov/insurance/Pages/index.aspx',null,null),
  ('PA','Pennsylvania','US',2,'wave_2','https://www.insurance.pa.gov',null,null),
  ('RI','Rhode Island','US',2,'wave_2','https://dbr.ri.gov/divisions/insurance/',null,null),
  ('SC','South Carolina','US',2,'wave_2','https://doi.sc.gov',null,null),
  ('SD','South Dakota','US',2,'wave_2','https://dlr.sd.gov/insurance/',null,null),
  ('TN','Tennessee','US',2,'wave_2','https://www.tn.gov/commerce/insurance.html',null,null),
  ('TX','Texas','US',1,'wave_1','https://www.tdi.texas.gov','https://statutes.capitol.texas.gov','https://texreg.sos.state.tx.us'),
  ('UT','Utah','US',2,'wave_2','https://insurance.utah.gov',null,null),
  ('VT','Vermont','US',2,'wave_2','https://dfr.vermont.gov/insurance',null,null),
  ('VA','Virginia','US',2,'wave_2','https://www.scc.virginia.gov/pages/Bureau-of-Insurance',null,null),
  ('WA','Washington','US',1,'wave_1','https://www.insurance.wa.gov','https://app.leg.wa.gov/RCW/','https://apps.leg.wa.gov/wac/'),
  ('WV','West Virginia','US',2,'wave_2','https://www.wvinsurance.gov',null,null),
  ('WI','Wisconsin','US',2,'wave_2','https://oci.wi.gov',null,null),
  ('WY','Wyoming','US',2,'wave_2','https://insurance.wy.gov',null,null),
  ('DC','District of Columbia','US',2,'wave_2','https://disb.dc.gov',null,null)
on conflict (code) do nothing;


-- ----------------------------------------------------------------------------
-- 5. Repair admin_prepare_user_deletion (obsolete regulatory object)
-- ----------------------------------------------------------------------------
-- An environment that already applied the previous body of this function still
-- references the orphan public.regulatory_contradictions table, which does not
-- exist in production, so user-deletion preparation fails there. Re-declaring
-- the function here (rather than only editing 20260909) repairs those
-- environments without rewriting applied history. The resolved-by column is
-- resolved from the catalog, so the function works whether the canonical table
-- carries resolved_by_id or resolved_by. No regulatory row is ever deleted.
create or replace function public.admin_prepare_user_deletion(
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_reg_col text;
begin
  if not public.is_super_admin() then
    raise exception 'Access denied: super_admin required';
  end if;

  if p_user_id is null then
    raise exception 'User id is required.';
  end if;

  select email into v_email from public.profiles where _id = p_user_id;
  if not found then
    raise exception 'User not found.';
  end if;

  update public.memberships set "invitedBy" = null where "invitedBy" = p_user_id;
  update public."tenantPacks" set "activatedBy" = null where "activatedBy" = p_user_id;
  update public.documents set "uploadedBy" = null where "uploadedBy" = p_user_id;
  update public.recommendations set "decidedBy" = null where "decidedBy" = p_user_id;
  update public."toolActions" set "actorId" = null, "confirmedBy" = null
    where "actorId" = p_user_id or "confirmedBy" = p_user_id;
  update public.notifications set "recipientId" = null where "recipientId" = p_user_id;
  update public."workflowApprovals" set "decidedBy" = null where "decidedBy" = p_user_id;
  update public."impactAssessments" set "decidedBy" = null where "decidedBy" = p_user_id;
  update public."auditLogs" set "actorId" = null where "actorId" = p_user_id;
  update public."insuranceClaims" set "createdBy" = null where "createdBy" = p_user_id;
  update public."claimSupplements" set "createdBy" = null where "createdBy" = p_user_id;
  update public."archiveIngestions" set "uploadedBy" = null where "uploadedBy" = p_user_id;

  update public.pilot_applications set reviewed_by = null where reviewed_by = p_user_id;
  update public.atlas_audit_log set actor_id = null where actor_id = p_user_id;

  -- Canonical regulatory table only; column name resolved from the catalog.
  select c.column_name into v_reg_col
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = 'atlas_regulatory_contradictions'
    and c.column_name in ('resolved_by_id', 'resolved_by')
  order by case c.column_name when 'resolved_by_id' then 0 else 1 end
  limit 1;

  if v_reg_col is not null then
    execute format(
      'update public.atlas_regulatory_contradictions set %I = null where %I = $1',
      v_reg_col,
      v_reg_col
    ) using p_user_id;
  end if;

  delete from public.user_provisions
    where provisioned_by = p_user_id or provisioned_user = p_user_id;
  delete from public.invites where "invitedBy" = p_user_id or email = v_email;

  insert into public.atlas_audit_log (
    actor_id, actor_email, action, target_type, target_id, details
  ) values (
    auth.uid(),
    (select email from public.profiles where _id = auth.uid()),
    'user_deleted',
    'user',
    p_user_id,
    jsonb_build_object('email', v_email)
  );

  return jsonb_build_object('ok', true, 'user_id', p_user_id, 'email', v_email);
end;
$$;

revoke execute on function public.admin_prepare_user_deletion(uuid) from public, anon;
grant execute on function public.admin_prepare_user_deletion(uuid) to authenticated, service_role;
