-- ============================================================================
-- 20260935 — Atlas Content Engine
--
-- ONE CONTENT IDEA -> ONE CONTENT PACKAGE -> BLOG + VIDEO + THUMBNAIL + LINKEDIN
--
-- This migration EXTENDS the existing content engine (20260913 platform
-- infrastructure + 20260920 blog publishing). It deliberately does NOT create a
-- second content model:
--
--   * public."atlasContentItems"  stays the single content/asset record. A
--     content PACKAGE is a blog row plus the asset rows that descend from it
--     via "parentContentId" — the relationship the engine already models. New
--     asset content types (video script, YouTube video, YouTube thumbnail) are
--     added to the existing CHECK so a package can own every derivative.
--   * public.connections / public.connectiontokens (20260922) stay the ONLY
--     credential store. YouTube and LinkedIn are registered there like every
--     other OAuth provider — no new credential table.
--   * public.atlas_jobs stays the ONLY durable queue. Publishing runs as jobs.
--
-- What is genuinely new, and why:
--   1. public."atlasContentPublications" — per-DESTINATION publication state.
--      A video on YouTube and a post on LinkedIn fail and retry independently;
--      there is no single global "published" flag. It also carries the unique
--      idempotency key (package + provider + asset) that makes a retried job a
--      no-op instead of a duplicate post, and the future-metrics columns.
--   2. public."atlasContentAutomation" — per-organization automation + brand
--      voice settings. Default is REQUIRE APPROVAL: autonomous publishing is
--      never enabled by this default.
--
-- Everything is additive. No column is dropped, no row is rewritten, no
-- existing policy is replaced.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. atlasContentItems — asset/package/attribution columns
-- ----------------------------------------------------------------------------

alter table public."atlasContentItems"
  add column if not exists "organizationId" uuid references public.tenants ("_id") on delete set null,
  -- Asset payload. A blog article fills none of these; a generated video or
  -- thumbnail fills all of them.
  add column if not exists "assetType"    text,
  add column if not exists "storagePath"  text,
  add column if not exists "externalUrl"  text,
  add column if not exists "externalId"   text,
  add column if not exists "mimeType"     text,
  add column if not exists "metadata"     jsonb not null default '{}'::jsonb,
  -- Distribution bookkeeping.
  add column if not exists "scheduledAt"  bigint,
  add column if not exists "provider"     text,
  -- The published YouTube artefact, stored on the PACKAGE so the blog can render
  -- the video card and the two-way link without joining the asset rows.
  add column if not exists "youtubeVideoId"      text,
  add column if not exists "youtubeUrl"          text,
  add column if not exists "youtubeThumbnailUrl" text,
  add column if not exists "youtubeStatus"       text;

-- The asset content types the Content Engine produces. 'blog' and
-- 'linkedin_post' were the only supported types before this migration.
alter table public."atlasContentItems" drop constraint if exists "atlasContentItems_contentType_check";
alter table public."atlasContentItems"
  add constraint "atlasContentItems_contentType_check"
  check ("contentType" in (
    'blog',
    'linkedin_post',
    'video_script',
    'youtube_video',
    'youtube_thumbnail'
  ));

create index if not exists contentitems_by_org_idx
  on public."atlasContentItems" ("organizationId", "_creationTime" desc)
  where "organizationId" is not null;

create index if not exists contentitems_by_asset_type_idx
  on public."atlasContentItems" ("contentType", "assetType")
  where "assetType" is not null;

-- A package may own at most one asset of each type per channel: regenerating a
-- thumbnail must UPDATE the existing row rather than accumulate duplicates.
create unique index if not exists contentitems_unique_asset_type_per_parent_idx
  on public."atlasContentItems" ("parentContentId", "contentType", "assetType")
  where "parentContentId" is not null and "assetType" is not null;


-- ----------------------------------------------------------------------------
-- 2. atlasContentPublications — per-destination publishing state
-- ----------------------------------------------------------------------------

create table if not exists public."atlasContentPublications" (
  "_id"              uuid primary key default gen_random_uuid(),
  "_creationTime"    bigint not null default public.epoch_ms(),

  "organizationId"   uuid references public.tenants ("_id") on delete cascade,
  -- The blog article that IS the package. Every destination hangs off it.
  "contentPackageId" uuid not null
                     references public."atlasContentItems" ("_id") on delete cascade,
  -- The specific asset published (the YouTube video row, the LinkedIn post
  -- row). Null for the blog destination, which publishes the package itself.
  "assetId"          uuid references public."atlasContentItems" ("_id") on delete set null,

  provider           text not null check (provider in ('blog', 'youtube', 'linkedin')),

  status             text not null default 'queued'
                     check (status in ('queued', 'processing', 'published', 'failed', 'cancelled')),

  "scheduledAt"      bigint,
  "attemptCount"     integer not null default 0,
  -- Worker lease, mirroring the queue's own lock columns (atlas_jobs
  -- locked_at / lock_expires_at, 20260918). A publication is claimed by
  -- setting both; a worker that dies mid-publish leaves the row 'processing'
  -- with an expiring lease, and once the lease has expired ANY worker for that
  -- organization may reclaim it. Without this, a crash between provider success
  -- and completion left the row permanently 'processing' and unrecoverable.
  "lockedAt"         bigint,
  "lockExpiresAt"    bigint,
  "externalId"       text,
  "externalUrl"      text,
  "lastError"        text,
  "errorClass"       text,
  "publishedAt"      bigint,

  -- Future metrics attach here; nothing writes them yet and no value is
  -- fabricated. Kept separate from metadata so a metrics query never has to
  -- parse arbitrary JSON.
  metrics            jsonb not null default '{}'::jsonb,
  metadata           jsonb not null default '{}'::jsonb,

  -- Idempotency: package + provider + asset identifies one logical publication.
  -- A retried job hits this key and updates the existing row.
  "idempotencyKey"   text not null,

  "createdAt"        bigint not null default public.epoch_ms(),
  "updatedAt"        bigint not null default public.epoch_ms()
);

create unique index if not exists contentpublications_idempotency_idx
  on public."atlasContentPublications" ("idempotencyKey");

create index if not exists contentpublications_by_package_idx
  on public."atlasContentPublications" ("contentPackageId", provider);

create index if not exists contentpublications_by_org_status_idx
  on public."atlasContentPublications" ("organizationId", status, "createdAt" desc);

-- Recovery scan: rows abandoned in 'processing' by a dead worker.
create index if not exists contentpublications_stale_lease_idx
  on public."atlasContentPublications" ("lockExpiresAt")
  where status = 'processing';

-- One live publication per (package, provider, asset) so a duplicate enqueue
-- cannot fan out into two provider posts.
create unique index if not exists contentpublications_unique_destination_idx
  on public."atlasContentPublications" ("contentPackageId", provider, coalesce("assetId", '00000000-0000-0000-0000-000000000000'::uuid));


-- ----------------------------------------------------------------------------
-- 3. atlasContentAutomation — per-organization automation + brand settings
-- ----------------------------------------------------------------------------

create table if not exists public."atlasContentAutomation" (
  "organizationId"    uuid primary key references public.tenants ("_id") on delete cascade,
  "_creationTime"     bigint not null default public.epoch_ms(),

  enabled             boolean not null default false,
  -- Seconds between automated packages. NULL/0 = manual only.
  "intervalSeconds"   bigint,
  -- DEFAULT IS APPROVAL-GATED. Autonomous publishing must be switched on
  -- deliberately by a human; nothing in the engine flips this on its own.
  "requireApproval"   boolean not null default true,
  "autoPublish"       boolean not null default false,

  -- Brand voice / audience / CTA used by the generators.
  "brandVoice"        text,
  audience            text,
  "primaryCta"        text,
  "defaultTone"       text,

  -- Topic memory: avoids repeating what has already been covered.
  "coveredTopics"     jsonb not null default '[]'::jsonb,
  "lastGeneratedAt"   bigint,
  "lastPackageId"     uuid references public."atlasContentItems" ("_id") on delete set null,

  "updatedAt"         bigint not null default public.epoch_ms()
);

create index if not exists contentautomation_enabled_idx
  on public."atlasContentAutomation" (enabled, "lastGeneratedAt")
  where enabled = true;


-- ----------------------------------------------------------------------------
-- 4. RLS
--
-- Platform admins (the existing is_atlas_admin() helper) keep full access.
-- Organization members see only their own organization's rows. An
-- organization-less row (legacy platform content) stays admin-only, which is
-- the same visibility the pre-existing policies gave it.
-- ----------------------------------------------------------------------------

alter table public."atlasContentPublications" enable row level security;
alter table public."atlasContentAutomation" enable row level security;

drop policy if exists contentpublications_org_read on public."atlasContentPublications";
create policy contentpublications_org_read on public."atlasContentPublications"
  for select to authenticated
  using (
    public.is_atlas_admin()
    or ("organizationId" is not null and "organizationId" = public.my_tenant_id())
  );

drop policy if exists contentpublications_admin_write on public."atlasContentPublications";
create policy contentpublications_admin_write on public."atlasContentPublications"
  for all to authenticated
  using (public.is_atlas_admin())
  with check (public.is_atlas_admin());

drop policy if exists contentautomation_org_read on public."atlasContentAutomation";
create policy contentautomation_org_read on public."atlasContentAutomation"
  for select to authenticated
  using (public.is_atlas_admin() or "organizationId" = public.my_tenant_id());

drop policy if exists contentautomation_admin_write on public."atlasContentAutomation";
create policy contentautomation_admin_write on public."atlasContentAutomation"
  for all to authenticated
  using (public.is_atlas_admin() or "organizationId" = public.my_tenant_id())
  with check (public.is_atlas_admin() or "organizationId" = public.my_tenant_id());

-- Org members may read their own organization's content items. Platform
-- content (no organizationId) keeps the existing policies only.
drop policy if exists contentitems_org_read on public."atlasContentItems";
create policy contentitems_org_read on public."atlasContentItems"
  for select to authenticated
  using ("organizationId" is not null and "organizationId" = public.my_tenant_id());


-- ----------------------------------------------------------------------------
-- 5. RPCs
--
-- All are SECURITY DEFINER with a pinned search_path and re-derive the caller's
-- organization server-side. None accepts an organization id from the client,
-- so a caller cannot address another tenant's rows by passing a uuid.
-- ----------------------------------------------------------------------------

-- NOTE ON AUTHORIZATION IN THIS FILE
--
-- Every function below checks its caller IN ITS OWN BODY (the repo's
-- migration-privileges ratchet test inspects each function body, so a shared
-- helper would not register as a guard). The pattern is always:
--
--   * a platform admin (is_atlas_admin) may act;
--   * the TRUSTED SERVER (atlas_is_trusted_server: the Content Engine worker,
--     which runs with the service role and therefore has no user JWT, so
--     my_tenant_id() is null) may act — this is what lets the worker execute
--     the jobs it was handed;
--   * everyone else may act on their OWN organization only.
--
-- Authorization is never inferred from authentication: a user session grants
-- nothing beyond that user's own organization.

-- Resolve the organization a content operation must run under.
create or replace function public.content_engine_org()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select public.my_tenant_id();
$$;

-- One canonical idempotency key for a destination publication.
create or replace function public.content_publication_key(
  p_package uuid,
  p_provider text,
  p_asset uuid
) returns text
language sql
immutable
as $$
  select p_package::text || ':' || p_provider || ':' ||
         coalesce(p_asset::text, 'none');
$$;

-- The ONE durable Atlas schedule that drives an organization's automated
-- content packages. `atlas_schedules.name` is UNIQUE and `schedules_upsert`
-- keys on it, so a deterministic per-organization name is what makes repeated
-- saves UPDATE the same row instead of accumulating schedules.
--
-- Exposed as a function (rather than an inline literal) so the SQL, the Studio
-- and the tests all agree on the identity. The pure TypeScript mirror is
-- `contentAutomationScheduleName` in src/lib/content-engine/automation.ts, and
-- a test asserts the two agree.
create or replace function public.content_automation_schedule_name(
  p_organization uuid
) returns text
language sql
immutable
as $$
  select 'content-automation:' || p_organization::text;
$$;

revoke all on function public.content_automation_schedule_name(uuid) from anon;

-- Idempotently create or update the publication row for one destination.
-- Returns the row so the caller can decide whether to enqueue work.
create or replace function public.content_publication_upsert(
  p_package uuid,
  p_provider text,
  p_asset uuid default null,
  p_status text default 'queued',
  p_scheduled_at bigint default null,
  p_organization uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_key text;
  v_row public."atlasContentPublications";
  v_pkg_org uuid;
  v_trusted boolean;
begin
  if p_provider not in ('blog', 'youtube', 'linkedin') then
    raise exception 'Unsupported publishing provider: %', p_provider;
  end if;

  select "organizationId" into v_pkg_org
  from public."atlasContentItems" where "_id" = p_package;
  if v_pkg_org is null and not exists (
    select 1 from public."atlasContentItems" where "_id" = p_package
  ) then
    raise exception 'Unknown content package: %', p_package;
  end if;

  -- An organization-scoped package may only be published under its own org.
  --
  -- TENANT OWNERSHIP IS THE PACKAGE, NEVER p_organization. A caller-supplied
  -- organization id is accepted ONLY for the trusted server / platform admin
  -- path; for an ordinary organization member the package must itself belong to
  -- that organization. An org-less (legacy platform) package therefore cannot
  -- be claimed by, or attached to, ANY customer organization.
  v_trusted := public.atlas_is_trusted_server() or public.is_atlas_admin();
  if v_trusted then
    v_org := coalesce(p_organization, v_pkg_org);
  else
    if v_pkg_org is null then
      raise exception 'Access denied: content package is not owned by your organization'
        using errcode = '42501';
    end if;
    if v_pkg_org is distinct from public.my_tenant_id() then
      raise exception 'Access denied: content package belongs to another organization'
        using errcode = '42501';
    end if;
    v_org := v_pkg_org;
  end if;
  if v_org is null then
    raise exception 'Access denied: content package has no organization'
      using errcode = '42501';
  end if;

  v_key := public.content_publication_key(p_package, p_provider, p_asset);

  insert into public."atlasContentPublications" (
    "organizationId", "contentPackageId", "assetId", provider, status,
    "scheduledAt", "idempotencyKey"
  ) values (
    v_org, p_package, p_asset, p_provider, p_status, p_scheduled_at, v_key
  )
  -- IDEMPOTENCY: a second enqueue must never undo progress. A row that is
  -- already published stays published and a row a worker is currently holding
  -- stays processing, so re-queueing cannot produce a duplicate post.
  on conflict ("idempotencyKey") do update
    set status = case
          when public."atlasContentPublications".status in ('published', 'processing')
            then public."atlasContentPublications".status
          else excluded.status
        end,
        "scheduledAt" = coalesce(excluded."scheduledAt", public."atlasContentPublications"."scheduledAt"),
        "updatedAt" = public.epoch_ms()
  returning * into v_row;

  return to_jsonb(v_row);
end;
$$;

-- Claim a QUEUED publication for processing. Returns null when another worker
-- already holds it, which is what makes concurrent retries safe.
create or replace function public.content_publication_claim(
  p_publication uuid,
  p_lease_ms integer default 300000
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public."atlasContentPublications";
  v_org uuid;
  v_now bigint := public.epoch_ms();
begin
  -- The publication's OWN organization decides access, never a parameter.
  select "organizationId" into v_org
  from public."atlasContentPublications" where "_id" = p_publication;
  if not (public.atlas_is_trusted_server()
          or public.is_atlas_admin()
          or (v_org is not null and v_org = public.my_tenant_id())) then
    raise exception 'Access denied: not a member of this organization'
      using errcode = '42501';
  end if;

  -- LEASE SEMANTICS (mirrors atlas_jobs locked_at / lock_expires_at):
  --   queued | failed                 -> claimable
  --   processing + lease still valid  -> NOT claimable (a live worker owns it)
  --   processing + lease expired      -> claimable again (the owner died)
  --   published | cancelled           -> never claimable
  --
  -- WHAT THE LEASE DOES AND DOES NOT GIVE YOU. It recovers ATLAS STATE, not
  -- provider state. Specifically:
  --
  --   * provider succeeds -> crash BEFORE content_publication_complete
  --     -> the row still says 'processing' with NO external id, because
  --        complete() writes status and externalId in the SAME statement
  --     -> the lease expires and the next worker reclaims the row
  --     -> that worker has nothing to reconcile against and WILL call the
  --        provider again.
  --
  -- So provider execution is NOT exactly-once. What this design actually buys:
  --   * the idempotency key (package + provider + asset) so a re-queue updates
  --     one row rather than fanning out into two publications;
  --   * terminal-state protection, so a published or cancelled row is never
  --     claimed and a late failure callback cannot unpublish it;
  --   * a retained external id/url whenever complete() DID run, which lets a
  --     retried job recognise its own prior work instead of re-posting;
  --   * bounded recovery, so a crashed worker cannot strand a publication
  --     forever.
  -- The residual window — a provider post that exists but was never recorded —
  -- is inherent to not having provider-side idempotency keys, and is documented
  -- rather than papered over.
  update public."atlasContentPublications"
     set status = 'processing',
         "attemptCount" = "attemptCount" + 1,
         "lockedAt" = v_now,
         "lockExpiresAt" = v_now + greatest(coalesce(p_lease_ms, 300000), 30000),
         "updatedAt" = public.epoch_ms()
   where "_id" = p_publication
     and (
       status in ('queued', 'failed')
       or (status = 'processing'
           and ("lockExpiresAt" is null or "lockExpiresAt" <= v_now))
     )
  returning * into v_row;

  if v_row."_id" is null then
    return null;
  end if;
  return to_jsonb(v_row);
end;
$$;

-- Publications abandoned mid-flight by a dead worker. Used by the worker's
-- recovery sweep so an orphaned row is finished, not silently abandoned.
create or replace function public.content_publications_reclaimable(
  p_limit int default 25
) returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select jsonb_agg(to_jsonb(p) order by p."lockExpiresAt")
    from public."atlasContentPublications" p
    where p.status = 'processing'
      and (p."lockExpiresAt" is null or p."lockExpiresAt" <= public.epoch_ms())
      and (
        public.is_atlas_admin()
        or public.atlas_is_trusted_server()
        or p."organizationId" = public.my_tenant_id()
      )
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  ), '[]'::jsonb);
$$;

-- Record a successful publish. Storing the external id/url is what makes a
-- second execution a no-op: the provider id already exists.
create or replace function public.content_publication_complete(
  p_publication uuid,
  p_external_id text default null,
  p_external_url text default null,
  p_metadata jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public."atlasContentPublications";
  v_org uuid;
begin
  select "organizationId" into v_org
  from public."atlasContentPublications" where "_id" = p_publication;
  if not (public.atlas_is_trusted_server()
          or public.is_atlas_admin()
          or (v_org is not null and v_org = public.my_tenant_id())) then
    raise exception 'Access denied: not a member of this organization'
      using errcode = '42501';
  end if;

  update public."atlasContentPublications"
     set status = 'published',
         "externalId" = coalesce(p_external_id, "externalId"),
         "externalUrl" = coalesce(p_external_url, "externalUrl"),
         "publishedAt" = coalesce("publishedAt", public.epoch_ms()),
         "lastError" = null,
         "errorClass" = null,
         -- The lease is released on completion: a published row is terminal and
         -- can never be claimed again.
         "lockedAt" = null,
         "lockExpiresAt" = null,
         metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb),
         "updatedAt" = public.epoch_ms()
   where "_id" = p_publication
     -- Completion is always allowed, including from a reclaimer that no longer
     -- holds the lease: the provider call already happened.
     and status in ('queued', 'processing', 'failed')
  returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

-- Record a failed publish. The error is classified so the UI can show an
-- actionable message (e.g. "reconnect YouTube") instead of a raw provider dump.
create or replace function public.content_publication_fail(
  p_publication uuid,
  p_error text,
  p_error_class text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public."atlasContentPublications";
  v_org uuid;
begin
  select "organizationId" into v_org
  from public."atlasContentPublications" where "_id" = p_publication;
  if not (public.atlas_is_trusted_server()
          or public.is_atlas_admin()
          or (v_org is not null and v_org = public.my_tenant_id())) then
    raise exception 'Access denied: not a member of this organization'
      using errcode = '42501';
  end if;

  update public."atlasContentPublications"
     set status = 'failed',
         "lastError" = left(coalesce(p_error, 'Unknown publishing failure'), 1000),
         "errorClass" = p_error_class,
         -- Release the lease so the retry can claim it immediately.
         "lockedAt" = null,
         "lockExpiresAt" = null,
         "updatedAt" = public.epoch_ms()
   where "_id" = p_publication
   -- A published row is terminal: a late failure callback can never unpublish
   -- or corrupt a completed publication.
     and status in ('queued', 'processing', 'failed')
  returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

-- All destinations for one package (the granular package dashboard).
create or replace function public.content_publications_list(
  p_package uuid
) returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(p) order by p.provider), '[]'::jsonb)
  from public."atlasContentPublications" p
  where p."contentPackageId" = p_package
    and (
      public.is_atlas_admin()
      or p."organizationId" = public.my_tenant_id()
    );
$$;

-- Studio dashboard counts for the caller's organization.
create or replace function public.content_studio_summary()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with org as (
    select case when public.is_atlas_admin() then null else public.my_tenant_id() end as tid
  ),
  items as (
    select c.* from public."atlasContentItems" c, org
    where c."contentType" = 'blog'
      and (
        (org.tid is null and public.is_atlas_admin())
        or c."organizationId" = org.tid
      )
  )
  select jsonb_build_object(
    'draft',            (select count(*) from items where status in ('opportunity', 'researching', 'drafted')),
    'awaiting_review',  (select count(*) from items where status = 'in_review'),
    'approved',         (select count(*) from items where status = 'approved'),
    'scheduled',        (select count(*) from items where "scheduledAt" is not null and status <> 'published'),
    'published',        (select count(*) from items where status = 'published'),
    'failed',           (select count(*) from items where status = 'failed')
  );
$$;

-- Per-organization automation settings. Reading never creates a row.
create or replace function public.content_automation_get()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select to_jsonb(a) from public."atlasContentAutomation" a
      where a."organizationId" = public.my_tenant_id()),
    jsonb_build_object(
      'organizationId', public.my_tenant_id(),
      'enabled', false,
      'intervalSeconds', null,
      'requireApproval', true,
      'autoPublish', false,
      'coveredTopics', '[]'::jsonb
    )
  );
$$;

-- Writing settings requires membership of the caller's own organization.
create or replace function public.content_automation_upsert(
  p_enabled boolean default null,
  p_interval_seconds bigint default null,
  p_require_approval boolean default null,
  p_auto_publish boolean default null,
  p_brand_voice text default null,
  p_audience text default null,
  p_primary_cta text default null,
  p_default_tone text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.my_tenant_id();
  v_row public."atlasContentAutomation";
begin
  if v_org is null then
    raise exception 'Access denied: no active Atlas organization'
      using errcode = '42501';
  end if;
  if not public.is_atlas_admin() and v_org is distinct from public.my_tenant_id() then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  -- Autonomous publishing is only ever enabled explicitly and only alongside
  -- approval being switched off; the two must never drift apart silently.
  if coalesce(p_auto_publish, false) and coalesce(p_require_approval, true) then
    raise exception 'Auto-publish requires requireApproval to be disabled explicitly';
  end if;

  insert into public."atlasContentAutomation" as a (
    "organizationId", enabled, "intervalSeconds", "requireApproval", "autoPublish",
    "brandVoice", audience, "primaryCta", "defaultTone"
  ) values (
    v_org,
    coalesce(p_enabled, false),
    p_interval_seconds,
    coalesce(p_require_approval, true),
    coalesce(p_auto_publish, false),
    p_brand_voice, p_audience, p_primary_cta, p_default_tone
  )
  on conflict ("organizationId") do update set
    enabled           = coalesce(p_enabled, a.enabled),
    "intervalSeconds" = coalesce(p_interval_seconds, a."intervalSeconds"),
    "requireApproval" = coalesce(p_require_approval, a."requireApproval"),
    "autoPublish"     = coalesce(p_auto_publish, a."autoPublish"),
    "brandVoice"      = coalesce(p_brand_voice, a."brandVoice"),
    audience          = coalesce(p_audience, a.audience),
    "primaryCta"      = coalesce(p_primary_cta, a."primaryCta"),
    "defaultTone"     = coalesce(p_default_tone, a."defaultTone"),
    "updatedAt"       = public.epoch_ms()
  returning * into v_row;

  -- SCHEDULING, ON ATLAS'S EXISTING RECURRING SCHEDULER.
  --
  -- RECURRENCE IS THE SCHEDULER'S JOB, NOT THE TICK'S. `public.atlas_schedules`
  -- (migration 20260913) is the single Atlas schedule registry, and
  -- `schedules_fire_due` is what advances `next_run_at` and creates the next
  -- job. The Content Engine therefore registers ONE durable, tenant-scoped
  -- schedule per organization and never re-enqueues a tick itself. There is no
  -- second scheduler and no cron dependency.
  --
  -- WHY THE CALL IS SAFE: `schedules_upsert` / `schedules_set_enabled` are
  -- service-role-only (revoked from anon/authenticated/PUBLIC in the 20260918
  -- hardening), so a browser can never reach them. This function is already
  -- SECURITY DEFINER with its own tenant guard, so it is the only path in, and
  -- it always writes a schedule for the caller's OWN organization.
  --
  -- IDEMPOTENCY: `atlas_schedules.name` is UNIQUE and `schedules_upsert` keys on
  -- it, so a deterministic per-organization name means repeated saves UPDATE
  -- one row instead of stacking schedules.
  --
  -- APPROVAL IS UNTOUCHED. This only PREPARES packages; generation still lands
  -- in human review, and `requireApproval` is never modified here.
  if v_row.enabled and v_row."intervalSeconds" is not null and v_row."intervalSeconds" >= 30 then
    perform public.schedules_upsert(
      p_name             => public.content_automation_schedule_name(v_org),
      p_job_type         => 'content_automation_tick',
      p_interval_seconds => v_row."intervalSeconds",
      p_payload          => jsonb_build_object(
                             'source', 'content-automation-schedule',
                             'organizationId', v_org
                           ),
      p_priority         => 4,
      p_max_attempts     => 3,
      p_tenant_id        => v_org,
      p_tags             => array['content-engine'],
      p_enabled          => true,
      p_description      => 'Content Engine: prepares a content package for review on the configured cadence.'
    );
  else
    -- Manual cadence, or automation switched off: PAUSE the schedule rather
    -- than delete it, so re-enabling keeps the history and the cadence. This
    -- is defence in depth — `content_automation_list_due` already selects only
    -- `enabled = true` rows, and both tick handlers skip a disabled automation,
    -- so disabling automation cannot produce a package by any of the three
    -- routes. `schedules_set_enabled` reports schedule_not_found when there was
    -- never a schedule, which is the correct no-op.
    perform public.schedules_set_enabled(
      p_name    => public.content_automation_schedule_name(v_org),
      p_enabled => false
    );
  end if;

  -- PROMPT FIRST OCCURRENCE ONLY. The recurring schedule above is what keeps
  -- generation going; this one-shot job simply means a schedule that fires in
  -- an hour does not make a newly-enabled workspace wait an hour for its first
  -- package. It is bucketed per hour, so repeated saves cannot stack ticks, and
  -- it does NOT re-enqueue itself.
  if v_row.enabled and v_row."intervalSeconds" is not null and v_row."intervalSeconds" > 0 then
    perform public.jobs_create_job(
      p_tenant_id       => v_org,
      p_job_type        => 'content_automation_tick',
      p_idempotency_key => 'content:automation-tick:' || v_org::text || ':'
                          || to_char(date_trunc('hour', now() at time zone 'utc'), 'YYYYMMDDHH24'),
      p_priority        => 4,
      p_payload         => jsonb_build_object('organizationId', v_org),
      p_max_attempts    => 3,
      p_scheduled_at    => now(),
      p_tags            => array['content-engine']
    );
  end if;

  -- Same row shape as before, plus flags so the UI can tell the truth about
  -- whether RECURRENCE is actually registered and whether a first tick was
  -- queued. `scheduleName` is the deterministic identity of the durable
  -- schedule, so the settings screen can show what is registered.
  return to_jsonb(v_row) || jsonb_build_object(
    'tickScheduled', v_row.enabled
      and v_row."intervalSeconds" is not null
      and v_row."intervalSeconds" > 0,
    'scheduleRegistered', v_row.enabled
      and v_row."intervalSeconds" is not null
      and v_row."intervalSeconds" >= 30,
    'scheduleName', public.content_automation_schedule_name(v_org)
  );
end;
$$;

-- Remember a covered topic so the generator stops repeating itself.
create or replace function public.content_automation_note_topic(
  p_topic text,
  p_package uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.my_tenant_id();
  v_topics jsonb;
begin
  -- The worker is a trusted server with no user session: it may note a topic
  -- only for the organization the PACKAGE already belongs to.
  if v_org is null and public.atlas_is_trusted_server() and p_package is not null then
    select "organizationId" into v_org
    from public."atlasContentItems" where "_id" = p_package;
  end if;
  if v_org is null then
    raise exception 'Access denied: no active Atlas organization'
      using errcode = '42501';
  end if;
  -- Authorization is explicit in every function (the repo's ratchet test requires
  -- an in-body guard): a platform admin may act, the TRUSTED SERVER (the content
  -- worker, which runs with the service role and has no user JWT) may act, and
  -- everyone else only on their OWN organization.
  if not (public.atlas_is_trusted_server()
          or public.is_atlas_admin()
          or (v_org is not null and v_org = public.my_tenant_id())) then
    raise exception 'Access denied: not a member of this organization'
      using errcode = '42501';
  end if;
  if p_topic is null or length(trim(p_topic)) = 0 then
    raise exception 'Topic is required';
  end if;

  insert into public."atlasContentAutomation" as a ("organizationId", "coveredTopics")
  values (v_org, jsonb_build_array(lower(trim(p_topic))))
  on conflict ("organizationId") do update set
    "coveredTopics" = (
      select coalesce(jsonb_agg(distinct t), '[]'::jsonb)
      from jsonb_array_elements_text(a."coveredTopics" || to_jsonb(lower(trim(p_topic)))) as t
    ),
    "lastGeneratedAt" = public.epoch_ms(),
    "lastPackageId" = coalesce(p_package, a."lastPackageId"),
    "updatedAt" = public.epoch_ms()
  returning "coveredTopics" into v_topics;

  return jsonb_build_object('ok', true, 'coveredTopics', v_topics);
end;
$$;

-- Idempotently write a generated ASSET (video script, YouTube video,
-- thumbnail) under its package. Regeneration updates the existing row: the
-- unique index on (parent, contentType, assetType) guarantees that.
create or replace function public.content_asset_upsert(
  p_package uuid,
  p_content_type text,
  p_asset_type text,
  p_title text,
  p_body text default null,
  p_storage_path text default null,
  p_external_url text default null,
  p_external_id text default null,
  p_mime_type text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_provider text default null,
  p_status text default 'drafted'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_row public."atlasContentItems";
begin
  select "organizationId" into v_org from public."atlasContentItems" where "_id" = p_package;
  if not found then
    raise exception 'Unknown content package: %', p_package;
  end if;
  if v_org is not null
     and not (public.atlas_is_trusted_server()
              or public.is_atlas_admin()
              or v_org = public.my_tenant_id()) then
    raise exception 'Access denied: content package belongs to another organization'
      using errcode = '42501';
  end if;

  insert into public."atlasContentItems" (
    "organizationId", "contentType", "assetType", title, body, status,
    "storagePath", "externalUrl", "externalId", "mimeType", metadata,
    provider, "parentContentId"
  ) values (
    v_org, p_content_type, p_asset_type, p_title, p_body,
    coalesce(p_status, 'drafted'),
    p_storage_path, p_external_url, p_external_id, p_mime_type,
    coalesce(p_metadata, '{}'::jsonb), p_provider, p_package
  )
  -- The asset-type index is PARTIAL (top-level articles have no parent), so the
  -- conflict target must repeat its predicate for Postgres to infer it.
  on conflict ("parentContentId", "contentType", "assetType")
    where "parentContentId" is not null and "assetType" is not null
  do update set
    title = excluded.title,
    body = coalesce(excluded.body, public."atlasContentItems".body),
    "storagePath" = coalesce(excluded."storagePath", public."atlasContentItems"."storagePath"),
    "externalUrl" = coalesce(excluded."externalUrl", public."atlasContentItems"."externalUrl"),
    "externalId" = coalesce(excluded."externalId", public."atlasContentItems"."externalId"),
    "mimeType" = coalesce(excluded."mimeType", public."atlasContentItems"."mimeType"),
    metadata = public."atlasContentItems".metadata || excluded.metadata,
    provider = coalesce(excluded.provider, public."atlasContentItems".provider),
    status = excluded.status,
    "updatedAt" = public.epoch_ms()
  returning * into v_row;

  return to_jsonb(v_row);
end;
$$;

-- Every asset belonging to a package, with the package itself.
create or replace function public.content_package_get(
  p_package uuid
) returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'package', to_jsonb(c),
    'assets', coalesce((
      select jsonb_agg(to_jsonb(a) order by a."_creationTime")
      from public."atlasContentItems" a
      where a."parentContentId" = c."_id"
    ), '[]'::jsonb),
    'publications', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.provider)
      from public."atlasContentPublications" p
      where p."contentPackageId" = c."_id"
    ), '[]'::jsonb)
  )
  from public."atlasContentItems" c
  where c."_id" = p_package
    -- Org-less (legacy platform) packages belong to NO customer organization:
    -- only the trusted server and platform admins may read them. An ordinary
    -- member of organization B can never read organization A's package, and can
    -- never read an org-less one, whatever id it is given.
    and (
      public.atlas_is_trusted_server()
      or public.is_atlas_admin()
      or (c."organizationId" is not null
          and c."organizationId" = public.my_tenant_id())
    );
$$;


-- ----------------------------------------------------------------------------
-- 6. Grants — published blog rows stay publicly readable; nothing new is.
-- ----------------------------------------------------------------------------

revoke all on table public."atlasContentPublications" from anon;
revoke all on table public."atlasContentAutomation" from anon;

revoke all on function public.content_publication_claim(uuid) from anon;
revoke all on function public.content_publication_complete(uuid, text, text, jsonb) from anon;
revoke all on function public.content_publication_fail(uuid, text, text) from anon;
revoke all on function public.content_automation_upsert(boolean, bigint, boolean, boolean, text, text, text, text) from anon;
revoke all on function public.content_automation_note_topic(text, uuid) from anon;
revoke all on function public.content_asset_upsert(uuid, text, text, text, text, text, text, text, text, jsonb, text, text) from anon;


-- ----------------------------------------------------------------------------
-- 7. Studio read model, blog presentation, scheduler and enqueue
-- ----------------------------------------------------------------------------

-- The Content Studio dashboard. Returns packages (never their bodies) with a
-- per-channel rollup, so the UI can show BLOG / YOUTUBE / THUMBNAIL / LINKEDIN
-- state independently — there is no single global "published" flag.
create or replace function public.content_studio_list(
  p_limit  int default 40,
  p_offset int default 0
) returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with visible as (
    select c.*
    from public."atlasContentItems" c
    where c."contentType" = 'blog'
      and (
        public.atlas_is_trusted_server()
        or public.is_atlas_admin()
        or (c."organizationId" is not null
            and c."organizationId" = public.my_tenant_id())
      )
  ),
  page as (
    select v.*
    from visible v
    order by v."_creationTime" desc
    limit greatest(1, least(coalesce(p_limit, 40), 100))
    offset greatest(0, coalesce(p_offset, 0))
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'package', to_jsonb(page) - 'body',
      'assets', coalesce((
        select jsonb_agg(jsonb_build_object(
                 '_id', a."_id",
                 'contentType', a."contentType",
                 'assetType', a."assetType",
                 'status', a."status",
                 'externalUrl', a."externalUrl",
                 'title', a.title))
        from public."atlasContentItems" a
        where a."parentContentId" = page."_id"
      ), '[]'::jsonb),
      'publications', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'provider', p.provider,
                 'status', p.status,
                 'externalUrl', p."externalUrl",
                 'scheduledAt', p."scheduledAt",
                 'lastError', p."lastError",
                 'errorClass', p."errorClass"))
        from public."atlasContentPublications" p
        where p."contentPackageId" = page."_id"
      ), '[]'::jsonb)
    ) order by page."_creationTime" desc
  ), '[]'::jsonb)
  from page;
$$;

-- The blog's hero/video presentation. Called when a thumbnail or a YouTube
-- video is (re)generated or published: the package keeps the canonical video
-- URL and the single shared thumbnail, which also becomes the article's
-- Open Graph image. Nothing is written that the blog does not read.
create or replace function public.content_set_youtube_presentation(
  p_package           uuid,
  p_youtube_url       text default null,
  p_youtube_video_id  text default null,
  p_thumbnail_url     text default null,
  p_seo               jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public."atlasContentItems";
  v_org uuid;
begin
  select "organizationId" into v_org
  from public."atlasContentItems" where "_id" = p_package;
  if not found then
    raise exception 'Unknown content package: %', p_package;
  end if;
  if v_org is not null
     and not (public.atlas_is_trusted_server()
              or public.is_atlas_admin()
              or v_org = public.my_tenant_id()) then
    raise exception 'Access denied: content package belongs to another organization'
      using errcode = '42501';
  end if;

  update public."atlasContentItems"
     set "youtubeUrl"          = coalesce(p_youtube_url, "youtubeUrl"),
         "youtubeVideoId"      = coalesce(p_youtube_video_id, "youtubeVideoId"),
         "youtubeThumbnailUrl" = coalesce(p_thumbnail_url, "youtubeThumbnailUrl"),
         -- The same thumbnail is the article's hero and its social image.
         "heroImage"           = coalesce(p_thumbnail_url, "heroImage"),
         "socialImage"         = coalesce(p_thumbnail_url, "socialImage"),
         "seo"                 = coalesce("seo", '{}'::jsonb)
                                 || coalesce(p_seo, '{}'::jsonb)
                                 || case
                                      when p_youtube_url is null then '{}'::jsonb
                                      else jsonb_build_object('youtubeUrl', p_youtube_url)
                                    end
                                 || case
                                      when p_thumbnail_url is null then '{}'::jsonb
                                      else jsonb_build_object('ogImage', p_thumbnail_url)
                                    end,
         "updatedAt"           = public.epoch_ms()
   where "_id" = p_package
  returning * into v_row;

  return to_jsonb(v_row) - 'body';
end;
$$;

-- Automation scheduler input. This one INTENTIONALLY crosses organizations:
-- it is the tick that decides which organizations are due, so it is restricted
-- to platform admins and the service role (the worker).
create or replace function public.content_automation_list_due(
  p_limit int default 25
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_service boolean := coalesce(
    current_setting('request.jwt.claims', true)::jsonb ->> 'role', ''
  ) = 'service_role';
  v_now bigint := public.epoch_ms();
begin
  if not v_service and not public.is_atlas_admin() then
    raise exception 'Access denied: automation scheduler is platform-scoped'
      using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'organizationId', a."organizationId",
             'enabled', a.enabled,
             'intervalSeconds', a."intervalSeconds",
             'requireApproval', a."requireApproval",
             'autoPublish', a."autoPublish",
             'brandVoice', a."brandVoice",
             'audience', a.audience,
             'primaryCta', a."primaryCta",
             'defaultTone', a."defaultTone",
             'coveredTopics', a."coveredTopics",
             'lastGeneratedAt', a."lastGeneratedAt",
             'lastPackageId', a."lastPackageId"
           ))
    from public."atlasContentAutomation" a
    where a.enabled = true
      and a."intervalSeconds" is not null
      and a."intervalSeconds" > 0
      and (a."lastGeneratedAt" is null
           or a."lastGeneratedAt" + (a."intervalSeconds" * 1000) <= v_now)
  ), '[]'::jsonb);
end;
$$;

-- Enqueue a Content Engine job. The tenant is resolved SERVER-SIDE from the
-- package, so a caller can never enqueue work against another organization by
-- passing a uuid. Idempotency is delegated to jobs_create_job.
create or replace function public.content_engine_enqueue(
  p_package         uuid,
  p_job_type        text,
  p_payload         jsonb default '{}'::jsonb,
  p_idempotency_key text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  select "organizationId" into v_org
  from public."atlasContentItems" where "_id" = p_package;
  if not found then
    raise exception 'Unknown content package: %', p_package;
  end if;
  -- Authorization is explicit in every function (the repo's ratchet test requires
  -- an in-body guard): a platform admin may act, the TRUSTED SERVER (the content
  -- worker, which runs with the service role and has no user JWT) may act, and
  -- everyone else only on their OWN organization.
  if not (public.atlas_is_trusted_server()
          or public.is_atlas_admin()
          or (v_org is not null and v_org = public.my_tenant_id())) then
    raise exception 'Access denied: not a member of this organization'
      using errcode = '42501';
  end if;

  return public.jobs_create_job(
    p_tenant_id       => v_org,
    p_job_type        => p_job_type,
    p_idempotency_key => coalesce(p_idempotency_key,
                                  'content:' || p_job_type || ':' || p_package::text),
    p_priority        => 4,
    p_payload         => coalesce(p_payload, '{}'::jsonb),
    p_max_attempts    => 3,
    p_tags            => array['content-engine']
  );
end;
$$;

-- Publishing and generation are worker concerns; anon gets nothing new.
revoke all on function public.content_studio_list(int, int) from anon;
revoke all on function public.content_set_youtube_presentation(uuid, text, text, text, jsonb) from anon;
revoke all on function public.content_automation_list_due(int) from anon;
revoke all on function public.content_engine_enqueue(uuid, text, jsonb, text) from anon;
revoke all on function public.content_publications_reclaimable(int) from anon;
revoke all on function public.content_next_topic(uuid) from anon;


-- ----------------------------------------------------------------------------
-- 8. Topic bank — deterministic, non-repeating topic selection
-- ----------------------------------------------------------------------------
--
-- The automation scheduler needs to choose the NEXT topic without an AI model
-- and without repeating what the organization already covered. The bank is a
-- curated list of workflow/process topics for Atlas's audience: no statistic, no
-- regulation, no claim that would need evidence. Selection is pure SQL, so it is
-- tenant-safe, auditable, and identical on every run.
--
-- SELECTION IS DETERMINISTIC: the first ACTIVE bank entry whose lowercased text
-- is absent from the organization's coveredTopics. When everything is covered,
-- the function returns NULL and the tick enqueues nothing rather than recycling
-- an article the audience has already seen.
create table if not exists public."atlasContentTopicBank" (
  _id           uuid primary key default gen_random_uuid(),
  "_creationTime" bigint not null default public.epoch_ms(),
  -- Lowercased for comparison, stored once so coverage checks are exact.
  topic         text not null unique,
  -- Bank position. Lower runs first, which is what makes selection stable.
  position      integer not null default 100,
  active        boolean not null default true
);

insert into public."atlasContentTopicBank" (topic, position) values
  ('why insurance supplements get missed', 10),
  ('building a documentation standard your crew will actually follow', 20),
  ('the handoff between field capture and estimating', 30),
  ('how to keep job evidence organized before the adjuster asks', 40),
  ('reducing rework in restoration estimates', 50),
  ('what a clean carrier submission package looks like', 60),
  ('turning completed jobs into repeatable playbooks', 70)
on conflict (topic) do nothing;

alter table public."atlasContentTopicBank" enable row level security;

drop policy if exists contenttopicbank_read on public."atlasContentTopicBank";
create policy contenttopicbank_read on public."atlasContentTopicBank"
  for select to authenticated
  using (public.is_atlas_admin() or public.atlas_is_trusted_server() or active);

revoke all on table public."atlasContentTopicBank" from anon;

-- The next topic for the CALLER's own organization. A regular member can never
-- name another organization: p_organization is honoured ONLY for the trusted
-- server (the automation tick, which walks due automations one organization at a
-- time) and a platform admin. For anyone else a non-null p_organization that is
-- not their own tenant is a 42501, and a null argument resolves to their own
-- organization. This keeps per-organization coverage exact for the scheduler
-- instead of collapsing every tenant's coverage into one global set.
create or replace function public.content_next_topic(p_organization uuid default null)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_topics text[];
begin
  if public.atlas_is_trusted_server() or public.is_atlas_admin() then
    v_org := p_organization;
  else
    v_org := public.my_tenant_id();
    if p_organization is not null and p_organization <> v_org then
      raise exception 'Access denied: cannot select a topic for another organization'
        using errcode = '42501';
    end if;
  end if;

  select coalesce(array_agg(lower(btrim(t)) order by t), '{}'::text[])
    into v_topics
  from (
    select jsonb_array_elements_text(coalesce(a."coveredTopics", '[]'::jsonb)) as t
      from public."atlasContentAutomation" a
     where a."organizationId" is not distinct from v_org
  ) s;

  return (
    select b.topic
      from public."atlasContentTopicBank" b
     where b.active
       and not (b.topic = any (v_topics))
     order by b.position asc, b.topic asc
     limit 1
  );
end;
$$;

-- How many bank topics are still available to the caller's organization.
create or replace function public.content_topic_remaining()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
  from public."atlasContentTopicBank" b
  where b.active
    and not exists (
      select 1
      from public."atlasContentAutomation" a
      where (public.is_atlas_admin() or public.atlas_is_trusted_server()
             or a."organizationId" = public.my_tenant_id())
        and b.topic = any (
          select jsonb_array_elements_text(
            coalesce(a."coveredTopics", '[]'::jsonb)
          )
        )
    );
$$;

revoke all on function public.content_topic_remaining() from anon;
