-- ---------------------------------------------------------------------------
-- Atlas Content Engine — deterministic compositor thumbnail INPUT contract
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- The deterministic thumbnail compositor is production-proven (deployed as
-- `content-thumbnail-compose`, verify_jwt = true), and the content-engine
-- worker can select it as an alternative renderer. What is missing is a place
-- to put the two AUTHORITATIVE inputs it consumes:
--
--     thumbnail_background   an operator-approved PNG the compositor fills
--     thumbnail_overlay      operator-approved, ordered overlay copy
--
-- Both are ordinary content ASSETS of a package, so they live in
-- `atlasContentItems` as children of the package — exactly like
-- `youtube_thumbnail` already is — rather than in a new table.
--
-- WHY A CONSTRAINT WIDENING IS THE WHOLE CHANGE
-- ----------------------------------------------
-- `atlasContentItems_contentType_check` enumerates the allowed content types,
-- so two new content types are all that is required. Nothing else is missing:
--
--   * the partial unique index
--       ("parentContentId", "contentType", "assetType")
--       where "parentContentId" is not null and "assetType" is not null
--     ALREADY gives each package exactly one slot per content type, so a
--     background is a distinct, self-updating slot that can never collide with
--     — or be an upsert target for — the canonical `youtube_thumbnail` row.
--     This migration therefore does NOT create an index.
--   * `content_asset_upsert` ALREADY copies the package's organization onto the
--     asset and never accepts one from the caller, so a background can never be
--     attached across organizations.
--   * `content_package_get` ALREADY returns every child asset, so the worker
--     resolves the inputs without any new RPC.
--   * `content_review_decide` ALREADY approves any row in this table, admin-only
--     and audited, so approval needs no new mechanism.
--   * `contentitems_org_read` ALREADY governs reads, so no new policy is needed.
--
-- SAFETY
-- ------
-- Additive and backwards compatible: the constraint is widened, never
-- narrowed. No table, column, index, policy, bucket or row is created, altered
-- or deleted. Existing content, existing `image_provider` jobs and existing
-- manually uploaded thumbnails are unaffected, and a package with no input
-- assets behaves exactly as it did before.
--
-- ROLLBACK
-- --------
-- Re-create the constraint with the original five values. That fails loudly if
-- any row already uses a new value, which is the intended safety property.
-- ---------------------------------------------------------------------------

begin;

alter table public."atlasContentItems"
  drop constraint if exists "atlasContentItems_contentType_check";

alter table public."atlasContentItems"
  add constraint "atlasContentItems_contentType_check"
  check ("contentType" in (
    'blog',
    'linkedin_post',
    'video_script',
    'youtube_video',
    'youtube_thumbnail',
    -- Compositor inputs. Both are INPUT assets: neither is ever a publish
    -- destination, and neither is a thumbnail output.
    'thumbnail_background',
    'thumbnail_overlay'
  ));

commit;

-- ---------------------------------------------------------------------------
-- Post-conditions. Read-only; safe to run after applying.
-- ---------------------------------------------------------------------------

-- 1. No existing row is invalid under the widened constraint.
do $$
begin
  if exists (
    select 1
    from public."atlasContentItems"
    where "contentType" not in (
      'blog', 'linkedin_post', 'video_script', 'youtube_video',
      'youtube_thumbnail', 'thumbnail_background', 'thumbnail_overlay'
    )
  ) then
    raise exception 'atlasContentItems contains a contentType outside the allowed set';
  end if;
end $$;

-- 2. The existing partial unique index already covers the new content types, so
--    each package holds at most one background and one overlay.
select
  conname,
  pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public."atlasContentItems"'::regclass
  and conname = 'atlasContentItems_contentType_check';

select indexname
from pg_indexes
where schemaname = 'public'
  and tablename = 'atlasContentItems'
  and indexname = 'contentitems_unique_asset_type_per_parent_idx';
