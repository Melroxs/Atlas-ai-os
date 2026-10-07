-- ===========================================================================
-- Atlas — external media upload (thumbnail + video) for Content Studio
--
-- WHY THIS EXISTS
-- ---------------
-- Some media is produced OUTSIDE Atlas (an operator renders a thumbnail and a
-- video elsewhere, then uploads the finished files). Atlas still has to own the
-- result: the bytes must become durable Atlas objects, the logical asset must be
-- the EXISTING `youtube_thumbnail` / `youtube_video` asset, and the package's
-- canonical presentation must keep pointing at Atlas storage. Nothing here
-- creates a new content model — it makes the existing asset and presentation
-- machinery reachable from an upload.
--
-- WHAT THIS MIGRATION DOES, AND NOTHING ELSE
-- ------------------------------------------
--   1. Creates ONE private bucket for uploaded video, with a tenant-scoped read
--      policy. The thumbnail deliberately does NOT get a bucket: `blog-media`
--      already exists for public publication artwork, is already public-read for
--      crawlers, and already accepts PNG/JPEG/WebP up to 2 MB, so reusing it adds
--      no new public surface.
--   2. Grants NO client write access to either bucket. Writes go through the
--      Edge Function with the service role, after it has derived the caller's
--      organization from their own session. A browser can therefore never write
--      an object, and can never choose a path.
--   3. Adds `content_media_read_path`, a read-only helper that returns the
--      storage path of a package's uploaded media to its OWNING organization, so
--      the Studio can render a video player without a service credential.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- --------------------------------------------
--   * It does not grant execute on `content_asset_upsert` or
--     `content_set_youtube_presentation` to any client role. Both stay exactly as
--     they are: the Edge Function reaches them with the service role, and both
--     already carry their own organization check.
--   * It does not create a table, an asset type, or a publication path. The
--     upload reuses `youtube_thumbnail` and `youtube_video`, and the existing
--     review/approval/publication sequence is untouched.
--   * It does not make video public. An unreviewed video must not be reachable
--     by a crawler or a social platform before a human has approved it.
-- ===========================================================================

-- ----------------------------------------------------------------------------
-- 1. Private bucket for uploaded video
-- ----------------------------------------------------------------------------
--
-- 100 MB matches MAX_VIDEO_BYTES in src/lib/content-engine/media-upload.ts, so
-- the bucket and the application agree on the ceiling instead of the application
-- accepting a file Storage would then reject.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'content-media',
  'content-media',
  false,
  104857600, -- 100 MB
  array['video/mp4', 'video/webm', 'video/quicktime']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Objects live at <organizationId>/<packageId>/… , the same tenant-scoped shape
-- the documents and archives buckets already use. That makes the existing
-- foldername() guard reusable verbatim: a member of organization A can select
-- only A's objects, whatever path they ask for.
drop policy if exists content_media_tenant_read on storage.objects;
create policy content_media_tenant_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'content-media'
    and (storage.foldername(name))[1] = public.my_tenant_id()::text
  );

-- There is deliberately NO insert, update or delete POLICY for either media
-- bucket, and none is created here. RLS denies by default, so with no policy a
-- client role can neither create, overwrite nor remove an object in
-- `content-media` or `blog-media`. Writes go through the Edge Function with the
-- service role, which bypasses RLS by design and is itself responsible for the
-- authorization.
--
-- DELIBERATELY NOT DONE: a blanket
--   revoke insert, update, delete on storage.objects from anon, authenticated
-- Table privileges and RLS are independent: a policy permits a row, but the
-- role still needs the table privilege to exercise it. The `authenticated` role
-- currently HOLDS insert/update/delete on `storage.objects`, and the live
-- `documents_storage_*` and `email_attachments_storage_*` policies depend on
-- it for the archive, document and email-attachment upload paths. Revoking it
-- would break those unrelated features with a permission error even though
-- their policies still allow the rows. The no-write guarantee for the media
-- buckets is expressed by the ABSENCE of a write policy, which is scoped to the
-- two buckets this feature owns and cannot affect any other bucket.
drop policy if exists content_media_write on storage.objects;

-- ----------------------------------------------------------------------------
-- 2. Read path for the owning organization
-- ----------------------------------------------------------------------------
--
-- The Studio needs to show a video preview, and a private bucket has no public
-- URL. Rather than exposing the bucket or handing the browser a service key,
-- this returns the storage path to a member of the OWNING organization only.
-- The function is SECURITY DEFINER so it can read the package row regardless of
-- the caller's RLS on content items, and it authorizes on the same
-- `my_tenant_id()` rule every other content function uses.
--
-- There is deliberately NO organization parameter. The organization is derived
-- from the package row and compared against the caller's own membership, so a
-- client cannot ask for another tenant's path.
create or replace function public.content_media_read_path(
  p_package uuid,
  p_kind text default 'video'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_path text;
  v_mime text;
  v_provider text;
begin
  if p_kind not in ('thumbnail', 'video') then
    raise exception 'Unsupported media kind: %', p_kind;
  end if;

  select c."organizationId" into v_org
  from public."atlasContentItems" c
  where c."_id" = p_package and c."parentContentId" is null;

  if not found then
    raise exception 'Unknown content package: %', p_package;
  end if;

  -- Same ownership rule as content_package_get, in the same positive form: a
  -- caller may read only when it is the trusted server, a platform admin, or a
  -- member of the organization that owns the package. An org-less (legacy
  -- platform) package is owned by NO customer organization, so an ordinary
  -- member is refused it — it is not "unowned, therefore open". Writing the
  -- check the other way round (`if v_org is not null and not (...)`) would let
  -- any signed-in user read an org-less package's media path, which is why the
  -- allow-list form is used instead.
  if not (
    public.atlas_is_trusted_server()
    or public.is_atlas_admin()
    or (v_org is not null and v_org = public.my_tenant_id())
  ) then
    raise exception 'Access denied: content package belongs to another organization'
      using errcode = '42501';
  end if;

  select a."storagePath", a."mimeType", a.provider
    into v_path, v_mime, v_provider
  from public."atlasContentItems" a
  where a."parentContentId" = p_package
    and a."assetType" = case p_kind
                          when 'thumbnail' then 'youtube_thumbnail'
                          else 'youtube_video'
                        end
  limit 1;

  if v_path is null then
    return jsonb_build_object('kind', p_kind, 'storagePath', null);
  end if;

  return jsonb_build_object(
    'kind', p_kind,
    'storagePath', v_path,
    'mimeType', v_mime,
    'provider', v_provider
  );
end;
$$;

-- Reachable by a signed-in Studio user (who must then also satisfy the
-- in-function ownership check) and by the service role. The PUBLIC grant is
-- revoked in the same statement: without it the function stays callable by anon
-- through the default privilege, which is exactly the hole 20260936 repaired.
revoke all on function public.content_media_read_path(uuid, text) from public, anon;
grant execute on function public.content_media_read_path(uuid, text) to authenticated, service_role;
