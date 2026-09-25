-- ============================================================================
-- Atlas Blog — content engine schema + human-gated publishing
--
-- WHY THIS MIGRATION EXISTS
--   The content engine declared in 20260913_atlas_platform_infrastructure.sql was
--   never applied to the deployed database: public."atlasContentItems",
--   public."atlasContentProvenance", public.atlas_schedules and every content_*
--   / schedules_* function are ABSENT at runtime (verified against the live
--   database). The blog therefore has no storage at all.
--
--   This migration installs ONLY the content engine (tables, indexes, RLS,
--   public reads, admin-guarded writes) using the same definitions as 20260913,
--   and adds the publish path that was a deliberate NOT_IMPLEMENTED stub in
--   src/lib/platform/handlers.ts ("Content stays in the approved state until a
--   human publishes it").
--
-- SECURITY POSTURE (aligned with 20260918_atlas_security_hardening.sql)
--   * published blog content  -> readable by anon + authenticated, via RLS AND
--     an explicit status filter in every query.
--   * admin list / review / publish -> granted to authenticated but guarded
--     INSIDE the function by is_super_admin() / is_atlas_admin(). This is the
--     pattern 20260918 prescribes ("must be done together with an in-function
--     admin guard, not by simply re-granting EXECUTE").
--   * the job worker runs as service_role and must supply an admin actor.
--   * non-negotiable gate: nothing is ever published unless a human already set
--     approvalStatus = 'approved'.
--   * provenance is mandatory: an article with no authoritative source and no
--     knowledge item cannot be published.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. slugify (mirrors slugify() in src/lib/platform/content.ts)
-- ----------------------------------------------------------------------------
create or replace function public.atlas_blog_slugify(p_input text)
returns text
language sql
immutable
as $$
  select left(
    trim(both '-' from
      regexp_replace(
        lower(coalesce(p_input, '')),
        '[^a-z0-9]+', '-', 'g'
      )
    ),
    80
  );
$$;


-- ----------------------------------------------------------------------------
-- 2. Content items (blog articles + their native LinkedIn posts)
-- ----------------------------------------------------------------------------
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

  seo                jsonb not null default '{}'::jsonb,

  jurisdiction       text,
  industry           text,
  "effectiveDate"    bigint,

  "knowledgeIds"     jsonb not null default '[]'::jsonb,
  "knowledgeVersionIds" jsonb not null default '[]'::jsonb,
  "sourceIds"        jsonb not null default '[]'::jsonb,

  "researchJobId"    uuid,
  "draftJobId"       uuid,
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

-- One published article per slug; drafts may not squat a published slug.
create unique index if not exists contentitems_unique_published_slug_idx
  on public."atlasContentItems" (slug)
  where "status" = 'published';


-- ----------------------------------------------------------------------------
-- 3. Provenance edges: content item -> the exact knowledge version it used
-- ----------------------------------------------------------------------------
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


-- ----------------------------------------------------------------------------
-- 4. RLS
-- ----------------------------------------------------------------------------
alter table public."atlasContentItems" enable row level security;
alter table public."atlasContentProvenance" enable row level security;

drop policy if exists contentitems_public_read on public."atlasContentItems";
create policy contentitems_public_read on public."atlasContentItems"
  for select to anon, authenticated
  using ("status" = 'published' and "contentType" = 'blog');

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

-- Provenance is readable only where the linked content is readable
-- (20260918 tightened this so a draft's sources cannot be enumerated).
drop policy if exists contentprovenance_read on public."atlasContentProvenance";
create policy contentprovenance_read on public."atlasContentProvenance"
  for select to anon, authenticated
  using (exists (
    select 1 from public."atlasContentItems" c
    where c."_id" = "contentId"
      and (
        (c."status" = 'published' and c."contentType" = 'blog')
        or (auth.uid() is not null and c."status" in ('approved', 'published'))
        or exists (
          select 1 from public.profiles p
          where p."_id" = auth.uid()
            and p.platform_role in ('super_admin', 'atlas_admin')
        )
      )
  ));

-- Table privileges: reads only for client roles (RLS narrows the rows).
revoke insert, update, delete on public."atlasContentItems" from anon, authenticated;
grant select on public."atlasContentItems" to anon, authenticated, service_role;
grant all on public."atlasContentItems" to service_role;
grant select on public."atlasContentProvenance" to anon, authenticated, service_role;
grant all on public."atlasContentProvenance" to service_role;


-- ----------------------------------------------------------------------------
-- 5. Public read surfaces (the ONLY blog RPCs an anonymous visitor can run)
-- ----------------------------------------------------------------------------
-- NOTE: SECURITY INVOKER, deliberately. These two readers do NOT bypass RLS:
-- the caller's own policies decide what is visible, and the published-blog
-- policy already permits anonymous reads. A SECURITY DEFINER public reader
-- would be a privilege-escalation surface (the ratchet in
-- src/lib/security/migration-privileges.test.ts exists to catch exactly that),
-- so the query also filters on status = 'published' explicitly.
create or replace function public.content_public_list(p_limit int default 50)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'slug', c.slug,
    'title', c.title,
    'summary', c.summary,
    'seo', c.seo,
    'jurisdiction', c.jurisdiction,
    'industry', c.industry,
    'publishedAt', c."publishedAt",
    'updatedAt', c."updatedAt"
  ) order by c."publishedAt" desc), '[]'::jsonb)
  from (
    select * from public."atlasContentItems"
    where "status" = 'published' and "contentType" = 'blog' and slug is not null
    order by "publishedAt" desc nulls last
    limit greatest(1, least(coalesce(p_limit, 50), 100))
  ) c;
$$;

-- One published article, including its body (the list omits the body).
create or replace function public.content_public_get(p_slug text)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    '_id', c."_id",
    'slug', c.slug,
    'title', c.title,
    'summary', c.summary,
    'body', c.body,
    'seo', c.seo,
    'jurisdiction', c.jurisdiction,
    'industry', c.industry,
    'publishedAt', c."publishedAt",
    'updatedAt', c."updatedAt"
  )
  from public."atlasContentItems" c
  where c.slug = trim(coalesce(p_slug, ''))
    and c."status" = 'published'
    and c."contentType" = 'blog'
  limit 1;
$$;

-- Only published blog articles ever reach an anonymous caller.
revoke execute on function public.content_public_list(int) from public;
revoke execute on function public.content_public_get(text) from public;
grant execute on function public.content_public_list(int) to anon, authenticated, service_role;
grant execute on function public.content_public_get(text) to anon, authenticated, service_role;


-- ----------------------------------------------------------------------------
-- 6. Admin read surface
-- ----------------------------------------------------------------------------
create or replace function public.content_admin_list(
  p_status text default null,
  p_limit  int  default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
begin
  if not (public.is_super_admin() or public.is_atlas_admin()) then
    raise exception 'Not authorized to read the content pipeline.' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    '_id', c."_id",
    'contentType', c."contentType",
    'status', c."status",
    'approvalStatus', c."approvalStatus",
    'slug', c.slug,
    'title', c.title,
    'summary', c.summary,
    'seo', c.seo,
    'jurisdiction', c.jurisdiction,
    'industry', c.industry,
    'knowledgeIds', c."knowledgeIds",
    'sourceIds', c."sourceIds",
    'parentContentId', c."parentContentId",
    'failureReason', c."failureReason",
    'publishedAt', c."publishedAt",
    'approvedAt', c."approvedAt",
    'updatedAt', c."updatedAt",
    'hasBody', c.body is not null and length(trim(c.body)) > 0
  ) order by c."updatedAt" desc), '[]'::jsonb)
  into v_rows
  from (
    select * from public."atlasContentItems"
    where p_status is null or "status" = p_status
    order by "updatedAt" desc
    limit greatest(1, least(coalesce(p_limit, 100), 500))
  ) c;

  return v_rows;
end $$;


-- ----------------------------------------------------------------------------
-- 7. Human review decision (REVIEW -> APPROVED / REJECTED)
-- ----------------------------------------------------------------------------
create or replace function public.content_review_decide(
  p_content_id uuid,
  p_decision   text,
  p_note       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row     public."atlasContentItems";
  v_actor   uuid := auth.uid();
  v_now     bigint := public.epoch_ms();
  v_status  text;
  v_approval text;
begin
  if not (public.is_super_admin() or public.is_atlas_admin()) then
    raise exception 'Not authorized to review Atlas content.' using errcode = '42501';
  end if;

  if p_decision not in ('approved', 'rejected', 'needs_changes', 'in_review') then
    raise exception 'Unknown review decision: %', p_decision;
  end if;

  select * into v_row from public."atlasContentItems" where "_id" = p_content_id;
  if v_row."_id" is null then
    return jsonb_build_object('ok', false, 'error', 'content_not_found');
  end if;

  case p_decision
    when 'in_review' then
      if v_row."status" not in ('drafted', 'researching', 'approved') then
        raise exception 'Content cannot enter review from status %.', v_row."status";
      end if;
      v_status := 'in_review'; v_approval := 'pending';
    when 'approved' then
      if v_row."status" not in ('in_review', 'approved') then
        raise exception 'Content must be in review before it can be approved (status %).', v_row."status";
      end if;
      v_status := 'approved'; v_approval := 'approved';
    when 'rejected' then
      v_status := 'archived'; v_approval := 'rejected';
    when 'needs_changes' then
      v_status := 'drafted'; v_approval := 'needs_changes';
  end case;

  update public."atlasContentItems"
  set status = v_status,
      "approvalStatus" = v_approval,
      "approvedBy" = case when v_approval = 'approved' then v_actor else "approvedBy" end,
      "approvedAt" = case when v_approval = 'approved' then v_now else "approvedAt" end,
      "updatedAt" = v_now
  where "_id" = p_content_id;

  perform public.log_audit(
    'content_review_' || p_decision, 'content_item', p_content_id::text,
    jsonb_build_object('note', p_note, 'status', v_status, 'approval_status', v_approval)
  );

  return jsonb_build_object('ok', true, 'status', v_status, 'approvalStatus', v_approval);
end $$;


-- ----------------------------------------------------------------------------
-- 8. Publish (the gate that was missing entirely)
--
-- Publishes ONE already-approved blog article: validates content quality and
-- provenance, assigns a unique readable slug, writes the SEO contract and
-- records the publication. It never generates content and never approves.
-- ----------------------------------------------------------------------------
create or replace function public.content_publish_blog(
  p_content_id uuid,
  p_slug       text default null,
  p_base_url   text default null,
  p_actor      uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row        public."atlasContentItems";
  v_is_service boolean := coalesce(
                          current_setting('request.jwt.claims', true)::jsonb ->> 'role', ''
                        ) = 'service_role';
  v_actor      uuid := coalesce(p_actor, auth.uid());
  v_slug       text;
  v_candidate  text;
  v_suffix     int := 1;
  v_words      int;
  v_now        bigint := public.epoch_ms();
  v_desc       text;
  v_seo        jsonb;
  v_canonical  text;
begin
  -- Authorization: either an atlas admin acting for themselves, or the trusted
  -- service-role worker acting for an admin actor it names explicitly.
  if v_is_service then
    if v_actor is null or not exists (
      select 1 from public.profiles p
      where p."_id" = v_actor
        and p.platform_role in ('super_admin', 'atlas_admin')
    ) then
      raise exception 'Publishing requires a platform admin actor.' using errcode = '42501';
    end if;
  elsif not (public.is_super_admin() or public.is_atlas_admin()) then
    raise exception 'Not authorized to publish Atlas content.' using errcode = '42501';
  end if;

  select * into v_row from public."atlasContentItems" where "_id" = p_content_id;
  if v_row."_id" is null then
    return jsonb_build_object('ok', false, 'error', 'content_not_found');
  end if;

  -- Hard gates.
  if v_row."contentType" <> 'blog' then
    return jsonb_build_object('ok', false, 'error', 'not_a_blog_article');
  end if;
  if v_row."status" <> 'approved' or v_row."approvalStatus" <> 'approved' then
    return jsonb_build_object(
      'ok', false,
      'error', 'not_approved',
      'detail', 'The article must be human-approved before it can be published.'
    );
  end if;
  if v_row.title is null or length(trim(v_row.title)) < 8 then
    return jsonb_build_object('ok', false, 'error', 'title_required');
  end if;
  if v_row.body is null or length(trim(v_row.body)) = 0 then
    return jsonb_build_object('ok', false, 'error', 'body_required');
  end if;

  v_words := array_length(regexp_split_to_array(trim(v_row.body), '\s+'), 1);
  if coalesce(v_words, 0) < 200 then
    return jsonb_build_object(
      'ok', false, 'error', 'body_too_short',
      'detail', format('Article body is %s words; at least 200 are required.', coalesce(v_words, 0))
    );
  end if;

  -- Provenance is mandatory: no unsourced claims reach the public blog.
  if jsonb_array_length(coalesce(v_row."knowledgeIds", '[]'::jsonb)) = 0
     or jsonb_array_length(coalesce(v_row."sourceIds", '[]'::jsonb)) = 0 then
    return jsonb_build_object(
      'ok', false, 'error', 'provenance_required',
      'detail', 'Published content must reference at least one authoritative source and one knowledge item.'
    );
  end if;

  -- Placeholder / credential leakage gates.
  if v_row.body ~* '(TODO|FIXME|lorem ipsum|placeholder|as an AI language model)'
     or v_row.title ~* '(TODO|FIXME|lorem ipsum|placeholder)'
     or (v_row.body || ' ' || coalesce(v_row.summary, '')) ~ '(sk_(live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'
     or (v_row.body || ' ' || coalesce(v_row.summary, '')) ~* 'service_role' then
    return jsonb_build_object(
      'ok', false, 'error', 'content_rejected_by_validation',
      'detail', 'The article contains placeholder text or material that must never be published.'
    );
  end if;

  -- Readable, unique slug.
  v_slug := nullif(public.atlas_blog_slugify(coalesce(p_slug, v_row.slug, v_row.title)), '');
  if v_slug is null then
    return jsonb_build_object('ok', false, 'error', 'slug_required');
  end if;
  v_candidate := v_slug;
  while exists (
    select 1 from public."atlasContentItems"
    where slug = v_candidate and "_id" <> p_content_id
  ) loop
    v_suffix := v_suffix + 1;
    if v_suffix > 50 then
      return jsonb_build_object('ok', false, 'error', 'slug_conflict');
    end if;
    v_candidate := v_slug || '-' || v_suffix;
  end loop;
  v_slug := v_candidate;

  v_desc := coalesce(
    nullif(trim(coalesce(v_row.summary, '')), ''),
    left(regexp_replace(trim(v_row.body), '\s+', ' ', 'g'), 155)
  );
  v_canonical := case
    when p_base_url is null or trim(p_base_url) = '' then null
    else rtrim(trim(p_base_url), '/') || '/blog/' || v_slug
  end;

  v_seo := coalesce(v_row.seo, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
    'title', v_row.title,
    'slug', v_slug,
    'description', v_desc,
    'canonicalUrl', v_canonical,
    'publishedDate', to_char(to_timestamp(v_now / 1000.0), 'YYYY-MM-DD'),
    'topic', v_row.industry,
    'jurisdiction', v_row.jurisdiction
  ));

  update public."atlasContentItems"
  set status = 'published',
      slug = v_slug,
      seo = v_seo,
      "publishedAt" = v_now,
      "publishTarget" = 'atlas_blog',
      "failureReason" = null,
      "updatedAt" = v_now
  where "_id" = p_content_id;

  perform public.log_audit(
    'content_published', 'content_item', p_content_id::text,
    jsonb_build_object('slug', v_slug, 'canonical_url', v_canonical, 'actor', v_actor)
  );

  return jsonb_build_object(
    'ok', true,
    'status', 'published',
    'slug', v_slug,
    'canonicalUrl', v_canonical,
    'publishedAt', v_now
  );
end $$;

revoke execute on function public.content_admin_list(text, int) from public, anon;
revoke execute on function public.content_review_decide(uuid, text, text) from public, anon;
revoke execute on function public.content_publish_blog(uuid, text, text, uuid) from public, anon;
grant execute on function public.content_admin_list(text, int) to authenticated, service_role;
grant execute on function public.content_review_decide(uuid, text, text) to authenticated, service_role;
grant execute on function public.content_publish_blog(uuid, text, text, uuid) to authenticated, service_role;
