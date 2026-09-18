-- ============================================================================
-- Atlas Platform Infrastructure
-- Migration: 20260913_atlas_platform_infrastructure.sql
--
-- DESIGN CONSTRAINTS (this migration is EXTENSION ONLY):
--   * The durable job system already exists  -> public.atlas_jobs (0020).
--     This migration reuses it. It does NOT create a second job system.
--   * The authoritative-source registry, knowledge versioning and human review
--     already exist -> public.authoritativeSources / authoritativeKnowledge /
--     impactAssessments (0001) and the everest_* RPCs (0005).
--     This migration EXTENDS those tables/ RPCs. It does NOT duplicate them.
--   * Freshness semantics already exist client-side (src/lib/atlas-data/
--     excellence.ts). This migration persists freshness/check state so the
--     server can drive the check loop.
--
-- What is genuinely new here:
--   1. public.atlas_schedules        — one reusable scheduling model that fires
--                                      jobs into the EXISTING atlas_jobs queue.
--   2. public.authoritativeSourceChecks — append-only source check log
--                                      (record-a-check without reprocessing).
--   3. knowledge version groups      — historical "what applied on date X".
--   4. public.atlasContentItems / atlasContentProvenance — the content engine
--                                      foundation (blog + LinkedIn), which does
--                                      not exist anywhere else today.
--
-- Everything is additive and safe to re-run. No existing row is deleted and
-- no existing column is retyped.
-- ============================================================================

create extension if not exists pgcrypto;


-- ============================================================================
-- 1. PLATFORM-SCOPE JOBS
--
-- Knowledge source checks are global (not tenant-owned) work. atlas_jobs
-- required a tenant, which made platform work impossible without inventing a
-- second queue. We relax that single constraint; RLS is unchanged and simply
-- never exposes NULL-tenant rows to authenticated users.
-- ============================================================================

alter table public.atlas_jobs
  alter column tenant_id drop not null;

comment on column public.atlas_jobs.tenant_id is
  'Owning tenant. NULL = platform-scope job (global knowledge work). Platform jobs carry no tenant data and are visible only to service_role.';

-- The existing idempotency index is (tenant_id, idempotency_key); Postgres
-- treats NULLs as distinct, so platform jobs need their own dedupe index.
create unique index if not exists idx_atlas_jobs_platform_idempotency
  on public.atlas_jobs (idempotency_key)
  where tenant_id is null
    and status not in ('completed', 'cancelled');


-- ============================================================================
-- 2. CANONICAL SCHEDULING MODEL
--
-- One table for every recurring Atlas task. A schedule never executes work
-- itself — it enqueues into atlas_jobs, so retries, backoff, concurrency
-- safety and observability are all inherited from the existing job system.
-- ============================================================================

create table if not exists public.atlas_schedules (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null unique,
  job_type             text not null,
  payload              jsonb not null default '{}'::jsonb,
  priority             int not null default 4
                       check (priority between 1 and 5),
  interval_seconds     bigint not null check (interval_seconds >= 30),
  max_attempts         int not null default 3,
  enabled              boolean not null default true,
  -- NULL = platform-scope schedule (global knowledge work).
  tenant_id            uuid references public.tenants (_id) on delete cascade,
  tags                 text[] not null default '{}',
  next_run_at          timestamptz not null default now(),
  last_run_at          timestamptz,
  last_job_id          uuid,
  consecutive_failures int not null default 0,
  description          text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists idx_atlas_schedules_due
  on public.atlas_schedules (next_run_at)
  where enabled;

create index if not exists idx_atlas_schedules_tenant
  on public.atlas_schedules (tenant_id, name);

alter table public.atlas_schedules enable row level security;

drop policy if exists atlas_schedules_service_all on public.atlas_schedules;
create policy atlas_schedules_service_all on public.atlas_schedules
  for all to service_role using (true) with check (true);

-- Platform-scope schedules are operational metadata; only platform admins read
-- them. Tenant-scope schedules are readable by that tenant.
drop policy if exists atlas_schedules_read on public.atlas_schedules;
create policy atlas_schedules_read on public.atlas_schedules
  for select to authenticated
  using (
    (tenant_id is not null and tenant_id = public.my_tenant_id())
    or exists (
      select 1 from public.profiles p
      where p."_id" = auth.uid()
        and p.platform_role in ('super_admin', 'atlas_admin')
    )
  );


-- ----------------------------------------------------------------------------
-- schedules_upsert — register or update a recurring task (idempotent by name).
-- ----------------------------------------------------------------------------
create or replace function public.schedules_upsert(
  p_name             text,
  p_job_type         text,
  p_interval_seconds bigint,
  p_payload          jsonb default '{}'::jsonb,
  p_priority         int default 4,
  p_max_attempts     int default 3,
  p_tenant_id        uuid default null,
  p_tags             text[] default '{}',
  p_enabled          boolean default true,
  p_description      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_next timestamptz;
begin
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'Schedule name is required.';
  end if;
  if p_interval_seconds is null or p_interval_seconds < 30 then
    raise exception 'Schedule interval must be at least 30 seconds.';
  end if;

  select id, next_run_at into v_id, v_next
  from public.atlas_schedules where name = p_name;

  if v_id is null then
    insert into public.atlas_schedules (
      name, job_type, interval_seconds, payload, priority, max_attempts,
      tenant_id, tags, enabled, description, next_run_at
    ) values (
      p_name, p_job_type, p_interval_seconds, coalesce(p_payload, '{}'::jsonb),
      p_priority, p_max_attempts, p_tenant_id, coalesce(p_tags, '{}'),
      p_enabled, p_description, now()
    )
    returning id into v_id;
  else
    update public.atlas_schedules
    set job_type = p_job_type,
        interval_seconds = p_interval_seconds,
        payload = coalesce(p_payload, payload),
        priority = p_priority,
        max_attempts = p_max_attempts,
        tenant_id = p_tenant_id,
        tags = coalesce(p_tags, tags),
        enabled = p_enabled,
        description = coalesce(p_description, description),
        -- If the schedule was disabled, start the clock again on re-enable.
        next_run_at = case when v_next < now() then now() else v_next end,
        updated_at = now()
    where id = v_id;
  end if;

  return jsonb_build_object('ok', true, 'schedule_id', v_id);
end;
$$;


-- ----------------------------------------------------------------------------
-- schedules_list — read the registry (platform + caller's tenant).
-- ----------------------------------------------------------------------------
create or replace function public.schedules_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return coalesce((
    select jsonb_agg(to_jsonb(s) order by s.name)
    from (
      select id, name, job_type, interval_seconds, priority, enabled, tenant_id,
             tags, next_run_at, last_run_at, last_job_id, consecutive_failures,
             description, updated_at
      from public.atlas_schedules
      where tenant_id is null
         or tenant_id = public.my_tenant_id()
         or exists (
              select 1 from public.profiles p
              where p."_id" = auth.uid()
                and p.platform_role in ('super_admin', 'atlas_admin')
            )
    ) s
  ), '[]'::jsonb);
end;
$$;


-- ----------------------------------------------------------------------------
-- schedules_set_enabled — pause / resume without deleting history.
-- ----------------------------------------------------------------------------
create or replace function public.schedules_set_enabled(
  p_name    text,
  p_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.atlas_schedules
  set enabled = p_enabled,
      next_run_at = case when p_enabled then now() else next_run_at end,
      updated_at = now()
  where name = p_name;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'schedule_not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;


-- ----------------------------------------------------------------------------
-- schedules_fire_due — claim due schedules and enqueue their jobs.
--
-- Concurrency safety comes from FOR UPDATE SKIP LOCKED plus the single
-- transaction that both creates the job and advances next_run_at, so two
-- schedulers can never double-fire the same schedule occurrence.
-- ----------------------------------------------------------------------------
create or replace function public.schedules_fire_due(p_limit int default 20)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row     record;
  v_job_id  uuid;
  v_key     text;
  v_fired   jsonb := '[]'::jsonb;
begin
  for v_row in
    select *
    from public.atlas_schedules
    where enabled
      and next_run_at <= now()
    order by next_run_at asc
    limit greatest(1, least(coalesce(p_limit, 20), 200))
    for update skip locked
  loop
    v_key := v_row.name || ':' || to_char(v_row.next_run_at, 'YYYYMMDDHH24MISS');

    insert into public.atlas_jobs (
      tenant_id, user_id, job_type, status, priority,
      idempotency_key, payload, max_attempts, scheduled_at, tags
    ) values (
      v_row.tenant_id, null, v_row.job_type, 'pending', v_row.priority,
      v_key, v_row.payload, v_row.max_attempts, now(), v_row.tags
    )
    on conflict do nothing
    returning id into v_job_id;

    if v_job_id is not null then
      insert into public.atlas_job_events (job_id, event_type, payload, actor)
      values (v_job_id, 'job_created',
        jsonb_build_object('schedule', v_row.name, 'job_type', v_row.job_type),
        'scheduler');

      update public.atlas_jobs set status = 'queued' where id = v_job_id;

      insert into public.atlas_job_events (job_id, event_type, payload, actor)
      values (v_job_id, 'job_queued',
        jsonb_build_object('schedule', v_row.name), 'scheduler');

      v_fired := v_fired || jsonb_build_object(
        'schedule', v_row.name,
        'job_id', v_job_id,
        'job_type', v_row.job_type
      );
    end if;

    update public.atlas_schedules
    set last_run_at = now(),
        last_job_id = v_job_id,
        next_run_at = now() + make_interval(secs => v_row.interval_seconds),
        updated_at = now()
    where id = v_row.id;
  end loop;

  return jsonb_build_object(
    'fired', coalesce(v_fired, '[]'::jsonb),
    'count', jsonb_array_length(coalesce(v_fired, '[]'::jsonb))
  );
end;
$$;


-- ----------------------------------------------------------------------------
-- schedules_record_result — record success/failure and back off on failure.
--
-- Called by the scheduler after a fired job terminalises. Backoff is
-- exponential from the base interval, capped at 24h, and never disables the
-- schedule — a failing schedule stays visible instead of silently vanishing.
-- ----------------------------------------------------------------------------
create or replace function public.schedules_record_result(
  p_name    text,
  p_success boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_seconds bigint;
begin
  select * into v_row from public.atlas_schedules where name = p_name;
  if v_row.id is null then
    return jsonb_build_object('ok', false, 'error', 'schedule_not_found');
  end if;

  if p_success then
    update public.atlas_schedules
    set consecutive_failures = 0,
        next_run_at = now() + make_interval(secs => v_row.interval_seconds),
        updated_at = now()
    where id = v_row.id;
    return jsonb_build_object('ok', true, 'consecutive_failures', 0);
  end if;

  v_seconds := least(
    v_row.interval_seconds * power(2, least(v_row.consecutive_failures + 1, 6))::bigint,
    86400
  );

  update public.atlas_schedules
  set consecutive_failures = v_row.consecutive_failures + 1,
      next_run_at = now() + make_interval(secs => v_seconds),
      updated_at = now()
  where id = v_row.id;

  return jsonb_build_object(
    'ok', true,
    'consecutive_failures', v_row.consecutive_failures + 1,
    'next_run_at_seconds', v_seconds
  );
end;
$$;


-- ============================================================================
-- 3. SOURCE REGISTRY EXTENSIONS (Everest — extended, not replaced)
-- ============================================================================

alter table public.authoritativeSources
  add column if not exists "checkFrequencySeconds" bigint,
  add column if not exists "nextCheckAt" bigint,
  add column if not exists freshness text,
  add column if not exists "reviewStatus" text,
  add column if not exists "lastHashAlgorithm" text;

comment on column public.authoritativeSources.freshness is
  'Persisted freshness state: current | stale | changed | needs_review | verified | superseded | failed | unchecked. Derived client-side by freshnessState(); persisted here so the server check loop can act on it.';

create index if not exists authoritativesources_due_idx
  on public.authoritativeSources ("nextCheckAt")
  where enabled and active;

-- ----------------------------------------------------------------------------
-- authoritativeSourceChecks — append-only log of every source check.
--
-- A check that finds NO change is recorded here and stops; it must never
-- trigger reprocessing. Only a changed result creates follow-on work.
-- ----------------------------------------------------------------------------
create table if not exists public."authoritativeSourceChecks" (
  "_id"             uuid primary key default gen_random_uuid(),
  "_creationTime"   bigint not null default public.epoch_ms(),
  "sourceId"        text not null
                    references public."authoritativeSources" ("sourceId")
                    on delete cascade,
  "checkedAt"       bigint not null,
  "status"          text not null
                    check ("status" in (
                      'unchanged', 'changed', 'failed', 'unavailable', 'skipped'
                    )),
  "httpStatus"      int,
  "contentHash"     text,
  "previousHash"    text,
  "changeType"      text,
  "latencyMs"       double precision,
  "normalizedLength" int,
  "error"           text,
  "jobId"           uuid,
  "checker"         text,
  "metadata"        jsonb not null default '{}'::jsonb
);

create index if not exists sourcechecks_by_source_idx
  on public."authoritativeSourceChecks" ("sourceId", "checkedAt" desc);

create index if not exists sourcechecks_by_status_idx
  on public."authoritativeSourceChecks" ("status", "checkedAt" desc);

alter table public."authoritativeSourceChecks" enable row level security;

drop policy if exists sourcechecks_read on public."authoritativeSourceChecks";
create policy sourcechecks_read on public."authoritativeSourceChecks"
  for select to authenticated using (true);

drop policy if exists sourcechecks_service_all on public."authoritativeSourceChecks";
create policy sourcechecks_service_all on public."authoritativeSourceChecks"
  for all to service_role using (true) with check (true);

drop policy if exists sourcechecks_admin_all on public."authoritativeSourceChecks";
create policy sourcechecks_admin_all on public."authoritativeSourceChecks"
  for all to authenticated
  using (exists (
    select 1 from public.profiles p
    where p."_id" = auth.uid()
      and p.platform_role in ('super_admin', 'atlas_admin')
  ))
  with check (exists (
    select 1 from public.profiles p
    where p."_id" = auth.uid()
      and p.platform_role in ('super_admin', 'atlas_admin')
  ));


-- ----------------------------------------------------------------------------
-- sources_list_due — sources whose freshness window has elapsed.
-- ----------------------------------------------------------------------------
create or replace function public.sources_list_due(p_limit int default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return coalesce((
    select jsonb_agg(to_jsonb(s) order by s."nextCheckAt" nulls first)
    from (
      select "sourceId", name, organization, "authorityTier", "sourceType",
             "canonicalUrl", "retrievalMethod", "updateFrequency",
             "checkFrequencySeconds", "lastCheckedAt", "lastChangedAt",
             "contentHash", "lastKnownVersion", freshness, "nextCheckAt",
             "consecutiveFailures", "lastFetchError", enabled
      from public."authoritativeSources"
      where enabled
        and active
        and (
          "nextCheckAt" is null
          or "nextCheckAt" <= public.epoch_ms()
          or freshness in ('stale', 'failed', 'changed')
        )
      order by "nextCheckAt" nulls first
      limit greatest(1, least(coalesce(p_limit, 50), 500))
    ) s
  ), '[]'::jsonb);
end;
$$;


-- ----------------------------------------------------------------------------
-- sources_get — read one registered source (needed by a targeted check job).
-- ----------------------------------------------------------------------------
create or replace function public.sources_get(p_source_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return (
    select to_jsonb(s)
    from (
      select "sourceId", name, organization, "authorityTier", "sourceType",
             "canonicalUrl", "retrievalMethod", "updateFrequency",
             "checkFrequencySeconds", "lastCheckedAt", "lastChangedAt",
             "contentHash", "lastKnownVersion", freshness, "nextCheckAt",
             "consecutiveFailures", "lastFetchError", enabled, active
      from public."authoritativeSources"
      where "sourceId" = p_source_id
    ) s
  );
end;
$$;


-- ----------------------------------------------------------------------------
-- sources_set_check_frequency — declare how often a source must be rechecked.
-- ----------------------------------------------------------------------------
create or replace function public.sources_set_check_frequency(
  p_source_id text,
  p_seconds   bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_seconds is null or p_seconds < 300 then
    raise exception 'Check frequency must be at least 300 seconds.';
  end if;

  update public."authoritativeSources"
  set "checkFrequencySeconds" = p_seconds,
      "nextCheckAt" = public.epoch_ms() + (p_seconds * 1000),
      "lastHashAlgorithm" = coalesce("lastHashAlgorithm", 'sha256')
  where "sourceId" = p_source_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'source_not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;


-- ----------------------------------------------------------------------------
-- sources_record_check — persist ONE check outcome.
--
-- Transient failures increment consecutiveFailures and mark the source
-- 'failed'; they never mark work complete. A changed result records the
-- change and marks the source 'changed' so a versioning job can be enqueued.
-- ----------------------------------------------------------------------------
create or replace function public.sources_record_check(
  p_source_id       text,
  p_status          text,
  p_content_hash    text default null,
  p_previous_hash   text default null,
  p_change_type     text default null,
  p_http_status     int default null,
  p_latency_ms      double precision default null,
  p_error           text default null,
  p_job_id          uuid default null,
  p_normalized_length int default null,
  p_checker         text default 'worker'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now bigint := public.epoch_ms();
  v_seconds bigint;
  v_check_id uuid;
  v_failures double precision;
begin
  if p_status not in ('unchanged', 'changed', 'failed', 'unavailable', 'skipped') then
    raise exception 'Invalid check status: %', p_status;
  end if;

  select coalesce("checkFrequencySeconds", 86400), coalesce("consecutiveFailures", 0)
    into v_seconds, v_failures
  from public."authoritativeSources"
  where "sourceId" = p_source_id;

  if v_seconds is null then
    return jsonb_build_object('ok', false, 'error', 'source_not_found');
  end if;

  insert into public."authoritativeSourceChecks" (
    "sourceId", "checkedAt", "status", "httpStatus", "contentHash",
    "previousHash", "changeType", "latencyMs", "normalizedLength",
    "error", "jobId", "checker"
  ) values (
    p_source_id, v_now, p_status, p_http_status, p_content_hash,
    p_previous_hash, p_change_type, p_latency_ms, p_normalized_length,
    p_error, p_job_id, p_checker
  )
  returning "_id" into v_check_id;

  if p_status = 'changed' then
    update public."authoritativeSources"
    set "lastCheckedAt" = v_now,
        "lastChangedAt" = v_now,
        "lastSuccessfulSyncAt" = v_now,
        "contentHash" = coalesce(p_content_hash, "contentHash"),
        "lastChangeType" = coalesce(p_change_type, 'content_changed'),
        freshness = 'changed',
        "reviewStatus" = null,
        "consecutiveFailures" = 0,
        "lastFetchError" = null,
        "nextCheckAt" = v_now + (v_seconds * 1000),
        "lastHashAlgorithm" = coalesce("lastHashAlgorithm", 'sha256')
    where "sourceId" = p_source_id;
  elsif p_status = 'unchanged' then
    update public."authoritativeSources"
    set "lastCheckedAt" = v_now,
        "lastSuccessfulSyncAt" = v_now,
        "contentHash" = coalesce(p_content_hash, "contentHash"),
        "lastChangeType" = null,
        "consecutiveFailures" = 0,
        "lastFetchError" = null,
        freshness = 'current',
        "nextCheckAt" = v_now + (v_seconds * 1000),
        "lastHashAlgorithm" = coalesce("lastHashAlgorithm", 'sha256')
    where "sourceId" = p_source_id;
  elsif p_status = 'failed' then
    update public."authoritativeSources"
    set "lastCheckedAt" = v_now,
        "consecutiveFailures" = v_failures + 1,
        "lastFetchError" = p_error,
        freshness = 'failed',
        -- Back off on repeated failure but keep the source scheduled.
        "nextCheckAt" = v_now + (
          least(v_seconds * power(2, least(v_failures + 1, 6)::int), 604800) * 1000
        )
    where "sourceId" = p_source_id;
  else
    update public."authoritativeSources"
    set "lastCheckedAt" = v_now,
        "lastFetchError" = p_error,
        freshness = case when p_status = 'unavailable' then 'stale' else freshness end,
        "nextCheckAt" = v_now + (v_seconds * 1000)
    where "sourceId" = p_source_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'check_id', v_check_id,
    'status', p_status,
    'freshness', case
      when p_status = 'changed' then 'changed'
      when p_status = 'unchanged' then 'current'
      when p_status = 'failed' then 'failed'
      else 'stale'
    end
  );
end;
$$;


-- ----------------------------------------------------------------------------
-- sources_list_checks — recent check history for one source (bounded).
-- ----------------------------------------------------------------------------
create or replace function public.sources_list_checks(
  p_source_id text,
  p_limit     int default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return coalesce((
    select jsonb_agg(to_jsonb(c) order by c."checkedAt" desc)
    from (
      select "_id", "sourceId", "checkedAt", "status", "httpStatus",
             "contentHash", "previousHash", "changeType", "latencyMs",
             "error", "jobId", "checker"
      from public."authoritativeSourceChecks"
      where "sourceId" = p_source_id
      order by "checkedAt" desc
      limit greatest(1, least(coalesce(p_limit, 50), 200))
    ) c
  ), '[]'::jsonb);
end;
$$;


-- ============================================================================
-- 4. KNOWLEDGE VERSION GROUPS
--
-- Existing columns (supersedesId / supersededById / supersedes / supersededBy)
-- already express a chain, and supersession logic already exists client-side
-- (applySupersession). We add the fields required to answer time-travel
-- questions: "what requirement applied on the date of loss?".
-- ============================================================================

alter table public.authoritativeKnowledge
  add column if not exists "versionGroup" text,
  add column if not exists "versionNumber" int not null default 1,
  add column if not exists "effectiveTo" bigint,
  add column if not exists "verifiedAt" bigint,
  add column if not exists "verifiedBy" uuid references public.profiles (_id) on delete set null,
  add column if not exists "sourceCheckId" uuid;

-- Existing rows form a group of one.
update public.authoritativeKnowledge
set "versionGroup" = "knowledgeId"
where "versionGroup" is null;

create index if not exists authknowledge_by_version_group_idx
  on public.authoritativeKnowledge ("versionGroup", "versionNumber" desc);

create index if not exists authknowledge_as_of_idx
  on public.authoritativeKnowledge ("effectiveDate", "effectiveTo");


-- ----------------------------------------------------------------------------
-- knowledge_versions — the full chain for a version group, oldest first.
-- ----------------------------------------------------------------------------
create or replace function public.knowledge_versions(p_version_group text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return coalesce((
    select jsonb_agg(to_jsonb(k) order by k."versionNumber" asc)
    from (
      select "knowledgeId", "versionGroup", "versionNumber", title, statement,
             interpretation, "sourceId", status, "reviewStatus", version,
             "effectiveDate", "effectiveTo", "contentHash", freshness,
             "supersedesId", "supersededById", confidence, "_creationTime"
      from public.authoritativeKnowledge
      where "versionGroup" = p_version_group
         or "knowledgeId" = p_version_group
    ) k
  ), '[]'::jsonb);
end;
$$;


-- ----------------------------------------------------------------------------
-- knowledge_as_of — the version that APPLIED at a point in time.
--
-- This is the historical-claim question: current knowledge is not necessarily
-- the knowledge that applied on the date of loss.
-- ----------------------------------------------------------------------------
create or replace function public.knowledge_as_of(
  p_as_of        bigint,
  p_jurisdiction text default null,
  p_industry     text default null,
  p_limit        int default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_as_of is null then
    raise exception 'p_as_of is required.';
  end if;

  return coalesce((
    select jsonb_agg(to_jsonb(k) order by k."effectiveDate" desc)
    from (
      select "knowledgeId", "versionGroup", "versionNumber", title, statement,
             interpretation, "sourceId", "knowledgeType", jurisdiction, industry,
             status, "reviewStatus", version, "effectiveDate", "effectiveTo",
             freshness, confidence
      from public.authoritativeKnowledge
      where status in ('active', 'superseded')
        and "effectiveDate" is not null
        and "effectiveDate" <= p_as_of
        and ("effectiveTo" is null or "effectiveTo" > p_as_of)
        and (p_jurisdiction is null or jurisdiction ilike '%' || p_jurisdiction || '%')
        and (p_industry is null or industry = p_industry)
      order by "effectiveDate" desc
      limit greatest(1, least(coalesce(p_limit, 50), 200))
    ) k
  ), '[]'::jsonb);
end;
$$;


-- ----------------------------------------------------------------------------
-- knowledge_create_version — append a new version; supersede the previous one.
--
-- Never overwrites history. The previous row becomes 'superseded' with an
-- explicit effectiveTo boundary and a link forward; the new row links back.
-- ----------------------------------------------------------------------------
create or replace function public.knowledge_create_version(
  p_version_group  text,
  p_source_id      text,
  p_title          text,
  p_statement      text,
  p_effective_date bigint,
  p_knowledge_id   text default null,
  p_interpretation text default null,
  p_knowledge_type text default 'requirement',
  p_jurisdiction   text default null,
  p_industry       text default null,
  p_version        text default null,
  p_confidence     double precision default 0.7,
  p_review_status  text default 'needs_review',
  p_content_hash   text default null,
  p_source_check_id uuid default null,
  p_job_id         uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev record;
  v_next_number int;
  v_new_id text;
  v_now bigint := public.epoch_ms();
begin
  if p_version_group is null or length(trim(p_version_group)) = 0 then
    raise exception 'p_version_group is required.';
  end if;
  if p_effective_date is null then
    raise exception 'p_effective_date is required for a verifiable version.';
  end if;
  if not exists (
    select 1 from public."authoritativeSources" where "sourceId" = p_source_id
  ) then
    raise exception 'Unknown source: %', p_source_id;
  end if;

  select * into v_prev
  from public.authoritativeKnowledge
  where "versionGroup" = p_version_group
  order by "versionNumber" desc
  limit 1
  for update;

  v_next_number := coalesce(v_prev."versionNumber", 0) + 1;
  v_new_id := coalesce(p_knowledge_id, p_version_group || ':v' || v_next_number);

  -- Supersede the previous version WITHOUT deleting anything, and only if the
  -- new version is effective at or after it (never rewrite the past silently).
  if v_prev."knowledgeId" is not null then
    if v_prev."effectiveDate" is not null and p_effective_date < v_prev."effectiveDate" then
      raise exception 'A new version cannot become effective before the version it supersedes.';
    end if;

    update public.authoritativeKnowledge
    set status = 'superseded',
        "effectiveTo" = p_effective_date,
        "supersededById" = v_new_id,
        "supersededBy" = coalesce("supersededBy", '[]'::jsonb) || to_jsonb(v_new_id),
        freshness = 'superseded',
        "lastCheckedAt" = v_now
    where "knowledgeId" = v_prev."knowledgeId";
  end if;

  insert into public.authoritativeKnowledge (
    "knowledgeId", "sourceId", title, statement, interpretation, "knowledgeType",
    jurisdiction, industry, status, "reviewStatus", "effectiveDate",
    "retrievalDate", version, "contentHash", freshness, confidence,
    "versionGroup", "versionNumber", "supersedesId", supersedes,
    "sourceCheckId"
  ) values (
    v_new_id, p_source_id, p_title, p_statement, p_interpretation,
    p_knowledge_type, p_jurisdiction, p_industry, 'active', p_review_status,
    p_effective_date, v_now, p_version, p_content_hash, 'needs_review',
    coalesce(p_confidence, 0.7), p_version_group, v_next_number,
    v_prev."knowledgeId",
    case when v_prev."knowledgeId" is null then '[]'::jsonb
         else jsonb_build_array(v_prev."knowledgeId") end,
    p_source_check_id
  );

  perform public.log_audit(
    'knowledge_version_created', 'authoritative_knowledge', v_new_id,
    jsonb_build_object(
      'version_group', p_version_group,
      'version_number', v_next_number,
      'superseded', v_prev."knowledgeId",
      'source_check_id', p_source_check_id,
      'job_id', p_job_id
    )
  );

  return jsonb_build_object(
    'ok', true,
    'knowledge_id', v_new_id,
    'version_group', p_version_group,
    'version_number', v_next_number,
    'superseded', v_prev."knowledgeId"
  );
end;
$$;


-- ----------------------------------------------------------------------------
-- knowledge_verify — record human verification of a version (review workflow).
-- ----------------------------------------------------------------------------
create or replace function public.knowledge_verify(
  p_knowledge_id text,
  p_decision     text,
  p_note         text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_role text;
  v_now bigint := public.epoch_ms();
begin
  if v_user is null then
    raise exception 'You must be signed in.';
  end if;
  select platform_role into v_role from public.profiles where "_id" = v_user;
  if coalesce(v_role, '') not in ('super_admin', 'atlas_admin') then
    raise exception 'Atlas administrator role required to verify knowledge.';
  end if;
  if p_decision not in ('verified', 'needs_review', 'rejected') then
    raise exception 'Invalid verification decision.';
  end if;

  update public.authoritativeKnowledge
  set "reviewStatus" = p_decision,
      status = case
        when p_decision = 'verified' then 'active'
        when p_decision = 'rejected' then 'rejected'
        else status
      end,
      freshness = case
        when p_decision = 'verified' then 'verified'
        when p_decision = 'needs_review' then 'needs_review'
        else freshness
      end,
      "verifiedAt" = v_now,
      "verifiedBy" = v_user,
      confidence = case when p_decision = 'verified'
                        then greatest(confidence, 0.85) else confidence end
  where "knowledgeId" = p_knowledge_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'knowledge_not_found');
  end if;

  perform public.log_audit(
    'knowledge_' || p_decision, 'authoritative_knowledge', p_knowledge_id,
    jsonb_build_object('note', p_note)
  );

  return jsonb_build_object('ok', true, 'review_status', p_decision);
end;
$$;


-- ============================================================================
-- 5. CONTENT ENGINE FOUNDATION (blog + LinkedIn)
--
-- Nothing in the repository models publishable content today. This is a new
-- subsystem, but it deliberately references the EXISTING knowledge tables so
-- the provenance chain is:
--     authoritative source -> knowledge version -> verified intelligence
--       -> content research -> blog article -> LinkedIn post
-- Nothing here publishes automatically; every state transition is explicit.
-- ============================================================================

create table if not exists public."atlasContentItems" (
  "_id"              uuid primary key default gen_random_uuid(),
  "_creationTime"    bigint not null default public.epoch_ms(),

  "contentType"      text not null
                     check ("contentType" in ('blog', 'linkedin_post')),
  "status"           text not null default 'opportunity'
                     check ("status" in (
                       'opportunity', 'researching', 'drafted', 'in_review',
                       'approved', 'published', 'failed', 'archived'
                     )),

  slug               text unique,
  title              text not null,
  summary            text,
  body               text,

  -- SEO contract for the future public blog.
  seo                jsonb not null default '{}'::jsonb,

  jurisdiction       text,
  industry           text,
  "effectiveDate"    bigint,

  -- Provenance references (knowledge lives in the Everest registry).
  "knowledgeIds"     jsonb not null default '[]'::jsonb,
  "knowledgeVersionIds" jsonb not null default '[]'::jsonb,
  "sourceIds"        jsonb not null default '[]'::jsonb,

  "researchJobId"    uuid,
  "draftJobId"       uuid,
  -- Blog article -> its native LinkedIn post.
  "parentContentId"  uuid references public."atlasContentItems" ("_id") on delete set null,

  "approvalStatus"   text not null default 'pending'
                     check ("approvalStatus" in ('pending', 'approved', 'rejected', 'needs_changes')),
  "approvedBy"       uuid references public.profiles ("_id") on delete set null,
  "approvedAt"       bigint,
  "publishedAt"      bigint,
  "publishTarget"    text,
  "failureReason"    text,

  "updatedAt"        bigint not null default public.epoch_ms()
);

create index if not exists contentitems_by_status_idx
  on public."atlasContentItems" ("status", "_creationTime" desc);

create index if not exists contentitems_by_type_idx
  on public."atlasContentItems" ("contentType", "status");

create index if not exists contentitems_by_parent_idx
  on public."atlasContentItems" ("parentContentId")
  where "parentContentId" is not null;

create index if not exists contentitems_published_slug_idx
  on public."atlasContentItems" (slug)
  where "status" = 'published';


-- Provenance edges: content item -> the exact knowledge version it was built on.
create table if not exists public."atlasContentProvenance" (
  "_id"            uuid primary key default gen_random_uuid(),
  "_creationTime"  bigint not null default public.epoch_ms(),
  "contentId"      uuid not null
                   references public."atlasContentItems" ("_id") on delete cascade,
  "knowledgeId"    text not null,
  "sourceId"       text,
  version          text,
  "effectiveDate"  bigint,
  contribution     text,
  confidence       double precision not null default 0.5
);

create index if not exists contentprovenance_by_content_idx
  on public."atlasContentProvenance" ("contentId");

alter table public."atlasContentItems" enable row level security;
alter table public."atlasContentProvenance" enable row level security;

-- The public blog may read published blog articles anonymously.
drop policy if exists contentitems_public_read on public."atlasContentItems";
create policy contentitems_public_read on public."atlasContentItems"
  for select to anon, authenticated
  using ("status" = 'published' and "contentType" = 'blog');

-- Signed-in users can read approved/published content (drafts stay admin-only).
drop policy if exists contentitems_auth_read on public."atlasContentItems";
create policy contentitems_auth_read on public."atlasContentItems"
  for select to authenticated
  using ("status" in ('approved', 'published'));

drop policy if exists contentitems_admin_all on public."atlasContentItems";
create policy contentitems_admin_all on public."atlasContentItems"
  for all to authenticated
  using (exists (
    select 1 from public.profiles p
    where p."_id" = auth.uid()
      and p.platform_role in ('super_admin', 'atlas_admin')
  ))
  with check (exists (
    select 1 from public.profiles p
    where p."_id" = auth.uid()
      and p.platform_role in ('super_admin', 'atlas_admin')
  ));

drop policy if exists contentitems_service_all on public."atlasContentItems";
create policy contentitems_service_all on public."atlasContentItems"
  for all to service_role using (true) with check (true);

drop policy if exists contentprovenance_read on public."atlasContentProvenance";
create policy contentprovenance_read on public."atlasContentProvenance"
  for select to anon, authenticated using (true);

drop policy if exists contentprovenance_admin_all on public."atlasContentProvenance";
create policy contentprovenance_admin_all on public."atlasContentProvenance"
  for all to authenticated
  using (exists (
    select 1 from public.profiles p
    where p."_id" = auth.uid()
      and p.platform_role in ('super_admin', 'atlas_admin')
  ))
  with check (exists (
    select 1 from public.profiles p
    where p."_id" = auth.uid()
      and p.platform_role in ('super_admin', 'atlas_admin')
  ));

drop policy if exists contentprovenance_service_all on public."atlasContentProvenance";
create policy contentprovenance_service_all on public."atlasContentProvenance"
  for all to service_role using (true) with check (true);


-- ----------------------------------------------------------------------------
-- content_create — create an opportunity/draft with its provenance edges.
-- ----------------------------------------------------------------------------
create or replace function public.content_create(
  p_content_type   text,
  p_title          text,
  p_slug           text default null,
  p_summary        text default null,
  p_body           text default null,
  p_seo            jsonb default '{}'::jsonb,
  p_jurisdiction   text default null,
  p_industry       text default null,
  p_effective_date bigint default null,
  p_knowledge_ids  jsonb default '[]'::jsonb,
  p_source_ids     jsonb default '[]'::jsonb,
  p_parent_content_id uuid default null,
  p_research_job_id uuid default null,
  p_status         text default 'opportunity'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_kid text;
  v_prov jsonb;
begin
  if p_content_type not in ('blog', 'linkedin_post') then
    raise exception 'Invalid content type.';
  end if;
  if p_status not in ('opportunity','researching','drafted','in_review','approved','published','failed','archived') then
    raise exception 'Invalid content status.';
  end if;
  if p_title is null or length(trim(p_title)) = 0 then
    raise exception 'Content title is required.';
  end if;
  -- A LinkedIn post must descend from approved research, never from nothing.
  if p_content_type = 'linkedin_post' and p_parent_content_id is null then
    raise exception 'A LinkedIn post must reference a parent content item.';
  end if;

  insert into public."atlasContentItems" (
    "contentType", "status", slug, title, summary, body, seo, jurisdiction,
    industry, "effectiveDate", "knowledgeIds", "sourceIds", "parentContentId",
    "researchJobId"
  ) values (
    p_content_type, p_status, p_slug, p_title, p_summary, p_body,
    coalesce(p_seo, '{}'::jsonb), p_jurisdiction, p_industry, p_effective_date,
    coalesce(p_knowledge_ids, '[]'::jsonb), coalesce(p_source_ids, '[]'::jsonb),
    p_parent_content_id, p_research_job_id
  )
  returning "_id" into v_id;

  -- Record a provenance edge for every knowledge item referenced.
  for v_kid in
    select jsonb_array_elements_text(coalesce(p_knowledge_ids, '[]'::jsonb))
  loop
    select jsonb_build_object(
      'knowledgeId', k."knowledgeId",
      'sourceId', k."sourceId",
      'version', k.version,
      'effectiveDate', k."effectiveDate",
      'confidence', k.confidence
    )
    into v_prov
    from public.authoritativeKnowledge k
    where k."knowledgeId" = v_kid;

    if v_prov is not null then
      insert into public."atlasContentProvenance" (
        "contentId", "knowledgeId", "sourceId", version, "effectiveDate",
        contribution, confidence
      ) values (
        v_id, v_prov ->> 'knowledgeId', v_prov ->> 'sourceId',
        v_prov ->> 'version', (v_prov ->> 'effectiveDate')::bigint,
        'knowledge_reference', coalesce((v_prov ->> 'confidence')::double precision, 0.5)
      );
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'content_id', v_id);
end;
$$;


-- ----------------------------------------------------------------------------
-- content_transition — the only way content status changes.
--
-- Enforces the approval chain: nothing reaches 'published' without an explicit
-- human 'approved' decision. Publishing itself is NOT performed here.
-- ----------------------------------------------------------------------------
create or replace function public.content_transition(
  p_content_id uuid,
  p_status     text,
  p_actor      uuid default null,
  p_note       text default null,
  p_publish_target text default null,
  p_failure_reason text default null,
  p_body       text default null,
  p_seo        jsonb default null,
  p_draft_job_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public."atlasContentItems";
  v_now bigint := public.epoch_ms();
  v_allowed text[];
begin
  if p_status not in ('opportunity','researching','drafted','in_review','approved','published','failed','archived') then
    raise exception 'Invalid content status.';
  end if;

  select * into v_row from public."atlasContentItems" where "_id" = p_content_id;
  if v_row."_id" is null then
    return jsonb_build_object('ok', false, 'error', 'content_not_found');
  end if;

  v_allowed := case v_row."status"
    when 'opportunity' then array['researching', 'archived', 'failed']
    when 'researching' then array['drafted', 'failed', 'archived']
    when 'drafted'     then array['in_review', 'failed', 'archived']
    when 'in_review'   then array['approved', 'failed', 'archived']
    when 'approved'    then array['published', 'failed', 'archived']
    when 'published'   then array['archived']
    when 'failed'      then array['researching', 'drafted', 'archived']
    else array['archived']
  end;

  if not (p_status = any(v_allowed)) then
    raise exception 'Invalid content transition: % -> %', v_row."status", p_status;
  end if;

  -- Hard gate: publishing requires a prior human approval.
  if p_status = 'published' and v_row."approvalStatus" <> 'approved' then
    raise exception 'Content must be approved before it can be published.';
  end if;

  update public."atlasContentItems"
  set status = p_status,
      -- Only an explicit approval advances the approval state; a failure keeps
      -- whatever decision a human already recorded.
      "approvalStatus" = case when p_status = 'approved' then 'approved' else "approvalStatus" end,
      "approvedBy" = case when p_status = 'approved' then coalesce(p_actor, "approvedBy") else "approvedBy" end,
      "approvedAt" = case when p_status = 'approved' then v_now else "approvedAt" end,
      "publishedAt" = case when p_status = 'published' then v_now else "publishedAt" end,
      "publishTarget" = coalesce(p_publish_target, "publishTarget"),
      "failureReason" = case when p_status = 'failed' then p_failure_reason else null end,
      body = coalesce(p_body, body),
      seo = coalesce(p_seo, seo),
      "updatedAt" = v_now,
      "draftJobId" = coalesce(p_draft_job_id, "draftJobId")
  where "_id" = p_content_id;

  perform public.log_audit(
    'content_' || p_status, 'content_item', p_content_id::text,
    jsonb_build_object('note', p_note, 'content_type', v_row."contentType")
  );

  return jsonb_build_object('ok', true, 'status', p_status);
end;
$$;


-- ----------------------------------------------------------------------------
-- content_list / content_get / content_list_provenance
-- ----------------------------------------------------------------------------
create or replace function public.content_list(
  p_content_type text default null,
  p_status       text default null,
  p_limit        int default 50,
  p_offset       int default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return coalesce((
    select jsonb_agg(to_jsonb(c) order by c."_creationTime" desc)
    from (
      select "_id", "contentType", "status", slug, title, summary, jurisdiction,
             industry, "effectiveDate", "knowledgeIds", "sourceIds",
             "approvalStatus", "publishedAt", "publishTarget", "failureReason",
             "parentContentId", "updatedAt", "_creationTime"
      from public."atlasContentItems"
      where (p_content_type is null or "contentType" = p_content_type)
        and (p_status is null or "status" = p_status)
      order by "_creationTime" desc
      limit greatest(1, least(coalesce(p_limit, 50), 200))
      offset greatest(0, coalesce(p_offset, 0))
    ) c
  ), '[]'::jsonb);
end;
$$;

create or replace function public.content_get(p_content_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_prov jsonb;
begin
  select to_jsonb(c) into v_item
  from public."atlasContentItems" c where c."_id" = p_content_id;

  if v_item is null then
    return null;
  end if;

  select coalesce(jsonb_agg(to_jsonb(p) order by p."_creationTime"), '[]'::jsonb)
  into v_prov
  from public."atlasContentProvenance" p
  where p."contentId" = p_content_id;

  return v_item || jsonb_build_object('provenance', v_prov);
end;
$$;

create or replace function public.content_list_provenance(p_content_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return coalesce((
    select jsonb_agg(
      to_jsonb(p) || jsonb_build_object(
        'sourceName', (
          select s.name from public."authoritativeSources" s
          where s."sourceId" = p."sourceId"
        ),
        'authorityTier', (
          select s."authorityTier" from public."authoritativeSources" s
          where s."sourceId" = p."sourceId"
        ),
        'knowledgeTitle', (
          select k.title from public.authoritativeKnowledge k
          where k."knowledgeId" = p."knowledgeId"
        )
      ) order by p."_creationTime"
    )
    from public."atlasContentProvenance" p
    where p."contentId" = p_content_id
  ), '[]'::jsonb);
end;
$$;


-- ----------------------------------------------------------------------------
-- content_public_list — the public blog index (published blogs only).
-- ----------------------------------------------------------------------------
create or replace function public.content_public_list(p_limit int default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'slug', c.slug,
        'title', c.title,
        'summary', c.summary,
        'seo', c.seo,
        'jurisdiction', c.jurisdiction,
        'industry', c.industry,
        'publishedAt', c."publishedAt",
        'updatedAt', c."updatedAt"
      ) order by c."publishedAt" desc
    )
    from (
      select * from public."atlasContentItems"
      where "status" = 'published' and "contentType" = 'blog'
      order by "publishedAt" desc
      limit greatest(1, least(coalesce(p_limit, 50), 100))
    ) c
  ), '[]'::jsonb);
end;
$$;


-- ============================================================================
-- 6. DEFAULT SCHEDULES (declared, NOT fabricated work)
--
-- These are scheduling declarations only. They create recurring job intents;
-- they do not invent knowledge, sources or content. Handlers decide what (if
-- anything) can actually be done with the real registered sources.
-- ============================================================================

select public.schedules_upsert(
  'knowledge-source-check',
  'knowledge_source_check',
  21600, -- every 6 hours
  '{}'::jsonb,
  4,
  3,
  null,
  array['knowledge', 'everest'],
  true,
  'Re-check every enabled/active authoritative source for changes.'
);

select public.schedules_upsert(
  'knowledge-freshness-sweep',
  'knowledge_freshness_sweep',
  3600, -- hourly
  '{}'::jsonb,
  4,
  3,
  null,
  array['knowledge', 'freshness'],
  true,
  'Mark sources whose freshness window elapsed as stale and enqueue checks.'
);

select public.schedules_upsert(
  'failed-job-retry-sweep',
  'platform_failed_job_sweep',
  1800, -- every 30 minutes
  '{}'::jsonb,
  5,
  2,
  null,
  array['platform', 'reliability'],
  true,
  'Surface and re-queue eligible failed jobs; never silently marks work complete.'
);

select public.schedules_upsert(
  'content-opportunity-detection',
  'content_detect_opportunity',
  86400, -- daily
  '{}'::jsonb,
  5,
  2,
  null,
  array['content', 'intelligence'],
  false, -- declared but disabled until the publishing phase is approved
  'Detect content opportunities from recently changed verified knowledge.'
);


-- ============================================================================
-- 7. GRANTS
--
-- 0007 already declares `alter default privileges` for tables/routines, so the
-- objects above normally inherit their grants. These are declared explicitly
-- for the case the project runs with auto_expose_new_tables unset (the cloud
-- default), where a new object is NOT reachable through the Data API without an
-- explicit GRANT — the RPCs would fail with `permission denied` (42501).
--
-- Row Level Security is the gate for TABLE access below: the policies declared
-- in this migration restrict `anon` to published blog content and check
-- history, and `anon` has no uid, so no other row can pass.
-- ============================================================================

grant all on public.atlas_schedules to anon, authenticated, service_role;
grant all on public."authoritativeSourceChecks" to anon, authenticated, service_role;
grant all on public."atlasContentItems" to anon, authenticated, service_role;
grant all on public."atlasContentProvenance" to anon, authenticated, service_role;

-- REMOVED: `grant execute on all functions in schema public to anon, authenticated, service_role;`
--
-- That blanket EXECUTE grant was a privilege-escalation hole. Row Level Security
-- is NOT the gate for a SECURITY DEFINER function: it runs with the definer's
-- privileges and bypasses RLS, and several functions carry no authorization
-- check of their own. With this grant in place an unauthenticated caller could
-- call `tenants_activate_after_payment(<any tenant id>)` to activate paid access
-- for any organization, or `email_accounts_get_credentials(<any id>)` to read
-- another organization's encrypted mailbox credentials.
--
-- The same blanket pattern also exists in `0007_grants.sql` (`grant all on all
-- routines ... to anon, authenticated;` plus an `alter default privileges` that
-- re-applies it to every future function), so deleting this line alone is not
-- sufficient. Function privileges for this schema are now set explicitly and
-- authoritatively by `20260918_atlas_security_hardening.sql`, which sorts after
-- this migration.

notify pgrst, 'reload schema';
