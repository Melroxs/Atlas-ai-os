-- ============================================================================
-- Atlas Intelligence — content administration (edit + unpublish)
--
-- WHY THIS MIGRATION EXISTS
--   20260926_atlas_intelligence_publication.sql added the publication fields
--   and upgraded the readers and the publish gate. What it deliberately did
--   NOT add is a way to EDIT an article's publication metadata or to take a
--   published article down.
--
--   Both are required by the admin experience, and neither should be done by
--   writing the table directly from the browser. The RLS policy
--   `contentitems_admin_all` already permits a platform admin to INSERT /
--   UPDATE / DELETE rows, so a client-side write is technically possible — and
--   technically possible is exactly why it should not be how a published
--   article is edited: a direct UPDATE can set status='published' and bypass
--   the human-approval gate in content_publish_blog entirely.
--
--   These two functions close that hole by construction:
--     * content_admin_update   — may edit metadata, but may NEVER set status.
--                               It refuses to run on a published row at all.
--     * content_unpublish      — the ONLY supported way to take a live article
--                               down, and it archives rather than deletes, so
--                               the record and its audit history survive.
--
-- SECURITY POSTURE
--   Both are SECURITY DEFINER and re-check is_super_admin() / is_atlas_admin()
--   inside the function, matching content_admin_list / content_review_decide /
--   content_publish_blog. anon and public have no EXECUTE grant.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Edit publication metadata (never status, never the body of a live article)
-- ----------------------------------------------------------------------------
create or replace function public.content_admin_update(
  p_content_id  uuid,
  p_title       text default null,
  p_summary     text default null,
  p_category    text default null,
  p_tags        jsonb default null,
  p_author      text default null,
  p_hero_image  text default null,
  p_social_image text default null,
  p_cta_id      text default null,
  p_seo         jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row   public."atlasContentItems";
  v_now   bigint := public.epoch_ms();
  v_seo   jsonb;
begin
  if not (public.is_super_admin() or public.is_atlas_admin()) then
    raise exception 'Not authorized to edit Atlas content.' using errcode = '42501';
  end if;

  select * into v_row from public."atlasContentItems" where "_id" = p_content_id;
  if v_row."_id" is null then
    return jsonb_build_object('ok', false, 'error', 'content_not_found');
  end if;

  -- A live article is not edited in place. Unpublish first, so the change is
  -- reviewed in the same way as any other edit rather than appearing silently
  -- on a page that is already indexed.
  if v_row."status" = 'published' then
    return jsonb_build_object(
      'ok', false,
      'error', 'article_is_live',
      'detail', 'Unpublish the article before editing it, so the change is reviewable.'
    );
  end if;

  if p_tags is not null and jsonb_typeof(p_tags) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'tags_must_be_an_array');
  end if;
  if p_cta_id is not null and p_cta_id not in ('A', 'B', 'C', 'none') then
    return jsonb_build_object('ok', false, 'error', 'unknown_cta');
  end if;

  -- SEO is merged, never replaced: an operator-set key is not destroyed by an
  -- edit that only intends to change one field.
  v_seo := coalesce(v_row.seo, '{}'::jsonb) || coalesce(p_seo, '{}'::jsonb);

  update public."atlasContentItems"
  set title        = coalesce(p_title, title),
      summary      = coalesce(p_summary, summary),
      "category"   = coalesce(p_category, "category"),
      tags         = coalesce(p_tags, tags),
      author       = coalesce(p_author, author),
      "heroImage"  = coalesce(p_hero_image, "heroImage"),
      "socialImage"= coalesce(p_social_image, "socialImage"),
      "ctaId"      = coalesce(p_cta_id, "ctaId"),
      seo          = v_seo,
      "updatedAt"  = v_now
  where "_id" = p_content_id;

  perform public.log_audit(
    'content_updated', 'content_item', p_content_id::text,
    jsonb_build_object(
      'fields', jsonb_build_object(
        'category', coalesce(p_category, v_row."category"),
        'author',   coalesce(p_author, v_row."author"),
        'hero',     coalesce(p_hero_image, v_row."heroImage")
      ),
      'actor', auth.uid()
    )
  );

  return jsonb_build_object('ok', true, 'updatedAt', v_now);
end $$;

-- ----------------------------------------------------------------------------
-- 2. Unpublish (the only supported way to take a live article down)
-- ----------------------------------------------------------------------------
-- Archives rather than deletes. The row, its slug history and its audit trail
-- remain, so a takedown is auditable and reversible. The slug is released so a
-- replacement article can claim it, which is why the unique published-slug
-- index does not block the replacement.
create or replace function public.content_unpublish(
  p_content_id uuid,
  p_reason     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public."atlasContentItems";
  v_now bigint := public.epoch_ms();
begin
  if not (public.is_super_admin() or public.is_atlas_admin()) then
    raise exception 'Not authorized to unpublish Atlas content.' using errcode = '42501';
  end if;

  select * into v_row from public."atlasContentItems" where "_id" = p_content_id;
  if v_row."_id" is null then
    return jsonb_build_object('ok', false, 'error', 'content_not_found');
  end if;
  if v_row."status" <> 'published' then
    return jsonb_build_object(
      'ok', false, 'error', 'not_published',
      'detail', format('Article status is %, not published.', v_row."status")
    );
  end if;

  update public."atlasContentItems"
  set status = 'archived',
      slug = null,
      "publishedAt" = null,
      "updatedAt" = v_now
  where "_id" = p_content_id;

  perform public.log_audit(
    'content_unpublished', 'content_item', p_content_id::text,
    jsonb_build_object('reason', p_reason, 'previous_slug', v_row.slug, 'actor', auth.uid())
  );

  return jsonb_build_object('ok', true, 'status', 'archived', 'previousSlug', v_row.slug);
end $$;

revoke execute on function public.content_admin_update(uuid, text, text, text, jsonb, text, text, text, text, jsonb) from public, anon;
revoke execute on function public.content_unpublish(uuid, text) from public, anon;
grant execute on function public.content_admin_update(uuid, text, text, text, jsonb, text, text, text, text, jsonb) to authenticated, service_role;
grant execute on function public.content_unpublish(uuid, text) to authenticated, service_role;
