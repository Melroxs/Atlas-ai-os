-- ============================================================================
-- Atlas Intelligence — publication layer for the EXISTING content engine
--
-- WHY THIS MIGRATION EXISTS
--   The blog content engine is real and deployed (20260920_atlas_blog_publishing.sql
--   installed public."atlasContentItems", public."atlasContentProvenance" and the
--   content_public_* / content_admin_* / content_review_decide /
--   content_publish_blog functions). Verified live: the table exists and holds
--   ZERO rows, so /blog renders its honest empty state.
--
--   That table is built for REGULATORY content, not for a restoration-intelligence
--   publication. It has no category, no tags, no hero image, no byline, no
--   reading time and no separate OG/Twitter contract, and `jurisdiction`/`industry`
--   are the only taxonomy. This migration EXTENDS the same table and the same
--   functions in place. It creates no second blog architecture.
--
--   Everything here is additive and idempotent: new columns, a CHECK-guarded
--   category, a public read bucket for publication artwork, a related-articles
--   RPC, and an upgraded publish function that writes the richer SEO contract.
--   Existing rows (none today) are unaffected.
--
-- SECURITY POSTURE (unchanged from 20260918 / 20260920)
--   * anon + authenticated still only ever SELECT status='published' blog rows.
--   * every write path stays behind SECURITY DEFINER + is_super_admin() /
--     is_atlas_admin(), or an explicitly named admin actor for service_role.
--   * drafts, in_review, approved-but-unpublished and archived rows are never
--     reachable from the public readers.
--   * the publish gate stays human-gated: approvalStatus must already be
--     'approved' before content_publish_blog will publish anything.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Publication fields on the existing content table
-- ----------------------------------------------------------------------------
-- "category" is the editorial pillar. It is deliberately NULLABLE: regulatory
-- content items that already exist carry no pillar, and forcing one would
-- either fail or mislabel them. The CHECK only constrains non-null values.
alter table public."atlasContentItems"
  add column if not exists "category"     text,
  add column if not exists "tags"         jsonb not null default '[]'::jsonb,
  add column if not exists "author"       text,
  add column if not exists "heroImage"    text,
  add column if not exists "socialImage"  text,
  add column if not exists "readingTime"  integer,
  add column if not exists "ctaId"        text,
  add column if not exists "aiGenerated"  boolean not null default false,
  add column if not exists "imagePrompt"  text,
  add column if not exists "reviewedBy"   uuid references public.profiles ("_id") on delete set null,
  add column if not exists "reviewedAt"   bigint;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'contentitems_category_check'
  ) then
    alter table public."atlasContentItems"
      add constraint contentitems_category_check
      check ("category" is null or "category" in (
        'revenue-recovery',
        'insurance-claims',
        'restoration-operations',
        'ai-automation',
        'estimating-supplements',
        'business-growth',
        'restoration-intelligence',
        'atlas'
      ));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'contentitems_cta_check'
  ) then
    alter table public."atlasContentItems"
      add constraint contentitems_cta_check
      check ("ctaId" is null or "ctaId" in ('A', 'B', 'C', 'none'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'contentitems_readingtime_check'
  ) then
    alter table public."atlasContentItems"
      add constraint contentitems_readingtime_check
      check ("readingTime" is null or "readingTime" >= 0);
  end if;
end $$;

-- tags must always be a JSON array of strings, never a JSON string.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'contentitems_tags_is_array'
  ) then
    alter table public."atlasContentItems"
      add constraint contentitems_tags_is_array
      check (jsonb_typeof("tags") = 'array');
  end if;
end $$;

-- Category listing for the public blog (used by the index filter).
create index if not exists contentitems_published_category_idx
  on public."atlasContentItems" ("category", "publishedAt" desc)
  where "status" = 'published' and "contentType" = 'blog';

-- Featured-article pick: most recent published article explicitly marked featured.
create index if not exists contentitems_featured_idx
  on public."atlasContentItems" ("publishedAt" desc)
  where "status" = 'published' and "contentType" = 'blog'
    and coalesce((seo ->> 'featured'), 'false') = 'true';


-- ----------------------------------------------------------------------------
-- 2. Publication artwork bucket
--
-- Blog hero/social images are PUBLIC by definition: they are referenced from
-- Open Graph tags on a public page and are fetched by crawlers and social
-- platforms that hold no Atlas session. The tenant buckets (archives,
-- documents, email-attachments) are private and must stay that way — this adds
-- a separate, non-tenant bucket used only by the publication layer.
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'blog-media',
  'blog-media',
  true,
  2097152, -- 2 MB: enough for a hero image, small enough to stay fast
  array['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp', 'image/avif']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Serve objects from the public CDN path. No write policy is granted to any
-- client role: artwork is uploaded by the seed/publish pipeline (service_role
-- or an admin via a definer function), never from the browser.
drop policy if exists blog_media_public_read on storage.objects;
create policy blog_media_public_read on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'blog-media');

revoke insert, update, delete on storage.objects from anon, authenticated;


-- ----------------------------------------------------------------------------
-- 3. Related articles (public, published-only)
-- ----------------------------------------------------------------------------
-- SECURITY INVOKER on purpose, matching content_public_get: the caller's RLS
-- decides visibility and the query filters status='published' explicitly, so
-- this can never widen access.
create or replace function public.content_public_related(
  p_slug    text,
  p_limit   int default 3
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with anchor as (
    select c."_id", c."category", c."tags"
    from public."atlasContentItems" c
    where c.slug = trim(coalesce(p_slug, ''))
      and c."status" = 'published'
      and c."contentType" = 'blog'
    limit 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'slug', r.slug,
    'title', r.title,
    'summary', r.summary,
    'category', r."category",
    'heroImage', r."heroImage",
    'publishedAt', r."publishedAt",
    'readingTime', r."readingTime"
  ) order by r.score desc, r."publishedAt" desc), '[]'::jsonb)
  from (
    select c.*,
      (
        case when c."category" is not null and c."category" = a."category" then 2 else 0 end
        + case when (
            select count(*)
            from jsonb_array_elements_text(coalesce(c."tags", '[]'::jsonb)) t
            where t = any (select jsonb_array_elements_text(coalesce(a."tags", '[]'::jsonb)))
          ) > 0 then 1 else 0 end
      )::int as score
    from public."atlasContentItems" c, anchor a
    where c."status" = 'published'
      and c."contentType" = 'blog'
      and c."_id" <> a."_id"
      and c.slug is not null
    order by score desc, c."publishedAt" desc
    limit greatest(0, least(coalesce(p_limit, 3), 6))
  ) r;
$$;

revoke execute on function public.content_public_related(text, int) from public;
grant execute on function public.content_public_related(text, int) to anon, authenticated, service_role;


-- ----------------------------------------------------------------------------
-- 4. The public readers, upgraded to carry the publication fields
-- ----------------------------------------------------------------------------
-- content_public_list gains category / hero / reading time so the index can
-- render cards and filter by pillar without a second round trip. Still
-- SECURITY INVOKER, still status='published' only, still no body.
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
    'category', c."category",
    'tags', c."tags",
    'author', c."author",
    'heroImage', c."heroImage",
    'socialImage', c."socialImage",
    'readingTime', c."readingTime",
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

-- One published article, including its body.
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
    'category', c."category",
    'tags', c."tags",
    'author', c."author",
    'heroImage', c."heroImage",
    'socialImage', c."socialImage",
    'readingTime', c."readingTime",
    'ctaId', c."ctaId",
    'publishedAt', c."publishedAt",
    'updatedAt', c."updatedAt"
  )
  from public."atlasContentItems" c
  where c.slug = trim(coalesce(p_slug, ''))
    and c."status" = 'published'
    and c."contentType" = 'blog'
  limit 1;
$$;

-- The admin list needs the new fields too, or the review screen cannot see or
-- edit a pillar, a hero image or a byline.
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
    'category', c."category",
    'tags', c."tags",
    'author', c."author",
    'heroImage', c."heroImage",
    'socialImage', c."socialImage",
    'readingTime', c."readingTime",
    'ctaId', c."ctaId",
    'aiGenerated', c."aiGenerated",
    'imagePrompt', c."imagePrompt",
    'reviewedBy', c."reviewedBy",
    'reviewedAt', c."reviewedAt",
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
-- 5. Publish function, upgraded with the publication gates
--
-- Unchanged: the human-approval gate is absolute. Nothing here generates
-- content, approves content, or publishes content that a human has not already
-- approved. Added: the new validation the publication layer requires
-- (category, byline, hero image, SEO description) and the richer SEO contract
-- that the article page actually reads.
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
  v_slug_base  text;
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

  -- Publication-layer gates. These are what make /blog render as a real
  -- publication rather than a list of untitled blobs.
  if v_row."category" is null then
    return jsonb_build_object(
      'ok', false, 'error', 'category_required',
      'detail', 'Every published article must belong to an editorial category.'
    );
  end if;
  if v_row."author" is null or length(trim(v_row."author")) < 2 then
    return jsonb_build_object('ok', false, 'error', 'author_required');
  end if;
  if v_row."heroImage" is null or length(trim(v_row."heroImage")) = 0 then
    return jsonb_build_object('ok', false, 'error', 'hero_image_required');
  end if;

  -- Provenance is mandatory: no unsourced claims reach the public blog.
  if jsonb_array_length(coalesce(v_row."knowledgeIds", '[]'::jsonb)) = 0
     or jsonb_array_length(coalesce(v_row."sourceIds", '[]'::jsonb)) = 0 then
    return jsonb_build_object(
      'ok', false,
      'error', 'provenance_required',
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
  v_slug_base := nullif(public.atlas_blog_slugify(coalesce(p_slug, v_row.slug, v_row.title)), '');
  if v_slug_base is null then
    return jsonb_build_object('ok', false, 'error', 'slug_required');
  end if;
  v_candidate := v_slug_base;
  while exists (
    select 1 from public."atlasContentItems"
    where slug = v_candidate and "_id" <> p_content_id
  ) loop
    v_suffix := v_suffix + 1;
    if v_suffix > 50 then
      return jsonb_build_object('ok', false, 'error', 'slug_conflict');
    end if;
    v_candidate := v_slug_base || '-' || v_suffix;
  end loop;
  v_slug := v_candidate;

  v_desc := coalesce(
    nullif(trim(coalesce(v_row.seo ->> 'description', '')), ''),
    nullif(trim(coalesce(v_row.summary, '')), ''),
    left(regexp_replace(trim(v_row.body), '\s+', ' ', 'g'), 155)
  );
  v_canonical := case
    when p_base_url is null or trim(p_base_url) = '' then null
    else rtrim(trim(p_base_url), '/') || '/blog/' || v_slug
  end;

  -- The SEO contract the article page reads. Existing keys are preserved
  -- (jsonb || is left-biased) so an operator-set description or canonical is
  -- never silently overwritten by a derived one.
  v_seo := coalesce(v_row.seo, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
    'title', coalesce(nullif(trim(coalesce(v_row.seo ->> 'title', '')), ''), v_row.title),
    'slug', v_slug,
    'description', v_desc,
    'canonicalUrl', coalesce(nullif(trim(coalesce(v_row.seo ->> 'canonicalUrl', '')), ''), v_canonical),
    'publishedDate', to_char(to_timestamp(v_now / 1000.0), 'YYYY-MM-DD'),
    'topic', v_row."category",
    'jurisdiction', v_row."jurisdiction"
  ));

  update public."atlasContentItems"
  set status = 'published',
      slug = v_slug,
      seo = v_seo,
      "readingTime" = coalesce(
        v_row."readingTime",
        greatest(1, round(coalesce(v_words, 0) / 200.0)::int)
      ),
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

revoke execute on function public.content_public_related(text, int) from public;
grant execute on function public.content_public_related(text, int) to anon, authenticated, service_role;
revoke execute on function public.content_public_list(int) from public;
revoke execute on function public.content_public_get(text) from public;
revoke execute on function public.content_admin_list(text, int) from public, anon;
revoke execute on function public.content_publish_blog(uuid, text, text, uuid) from public, anon;
grant execute on function public.content_public_list(int) to anon, authenticated, service_role;
grant execute on function public.content_public_get(text) to anon, authenticated, service_role;
grant execute on function public.content_admin_list(text, int) to authenticated, service_role;
grant execute on function public.content_publish_blog(uuid, text, text, uuid) to authenticated, service_role;
