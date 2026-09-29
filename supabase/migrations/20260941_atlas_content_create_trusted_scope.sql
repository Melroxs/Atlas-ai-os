-- ============================================================================
-- 20260941 — tighten the trusted path in content_create
--
-- WHY
-- ---
-- 20260940 resolved the organization with
--
--     v_trusted := public.atlas_is_trusted_server() or public.is_atlas_admin();
--
-- following content_publication_upsert. Live testing showed that is too loose
-- HERE, and why: is_atlas_admin() resolves through auth.uid(), so a signed-in
-- platform administrator satisfies it. Measured against production, the
-- "Test Company" owner (Melissa October, platform_role = super_admin) reached
-- the trusted branch and content_create then:
--
--   * created a package with "organizationId" = NULL, because the trusted
--     branch takes p_organization, which an admin session does not send; and
--   * accepted an explicit p_organization naming a DIFFERENT organization,
--     because the trusted branch performs no cross-organization check.
--
-- Both outcomes are the P0 this pair of migrations exists to close: an
-- org-less row is invisible to content_studio_list (which requires
-- "organizationId" = my_tenant_id()) yet, at status 'approved', readable by
-- every authenticated user through contentitems_auth_read.
--
-- THE RULE
-- -------
-- Only the TRUSTED SERVER — a call with no user session, which is the worker
-- — may create platform-level content or name an organization explicitly.
-- Every caller that has a user session, INCLUDING a platform administrator
-- browsing the app, gets its organization from my_tenant_id(), exactly like
-- any other member. This is the convention content_automation_upsert already
-- uses, and it introduces no new administrator bypass.
--
-- This replaces only the function body. No table, policy, index or grant
-- changes, and nothing already applied is edited.
-- ============================================================================


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
  p_research_job_id   uuid default null,
  p_status         text default 'opportunity',
  p_organization   uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id        uuid;
  v_kid       text;
  v_prov      jsonb;
  v_org       uuid;
  v_parent_org uuid;
  v_trusted   boolean;
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
  if p_content_type = 'linkedin_post' and p_parent_content_id is null then
    raise exception 'A LinkedIn post must reference a parent content item.';
  end if;

  -- ---------------------------------------------------------------------
  -- Tenant derivation.
  --
  -- is_atlas_admin() is deliberately NOT consulted. It resolves through
  -- auth.uid(), so any signed-in administrator would otherwise reach the
  -- trusted branch and could mint org-less or cross-organization content.
  -- Only a call with no user session at all — the Content Engine worker —
  -- is trusted here.
  -- ---------------------------------------------------------------------
  v_trusted := public.atlas_is_trusted_server();

  if v_trusted then
    -- The worker may create platform-level content (no organization) or name
    -- an organization explicitly.
    v_org := p_organization;
  else
    -- Anyone with a session, administrator or not, owns what it creates in
    -- its own organization.
    v_org := public.my_tenant_id();
    if v_org is null then
      raise exception 'Access denied: no active Atlas organization'
        using errcode = '42501';
    end if;
    if p_organization is not null and p_organization is distinct from v_org then
      raise exception 'Access denied: cannot create content for another organization'
        using errcode = '42501';
    end if;
  end if;

  -- A package may not be parented to another organization's content.
  if p_parent_content_id is not null then
    select "organizationId" into v_parent_org
    from public."atlasContentItems" where "_id" = p_parent_content_id;

    if not found then
      raise exception 'Unknown parent content item: %', p_parent_content_id
        using errcode = '42501';
    end if;
    if not v_trusted and v_parent_org is distinct from v_org then
      raise exception 'Access denied: parent content belongs to another organization'
        using errcode = '42501';
    end if;
  end if;

  insert into public."atlasContentItems" (
    "contentType", "status", slug, title, summary, body, seo, jurisdiction,
    industry, "effectiveDate", "knowledgeIds", "sourceIds", "parentContentId",
    "researchJobId", "organizationId"
  ) values (
    p_content_type, p_status, p_slug, p_title, p_summary, p_body,
    coalesce(p_seo, '{}'::jsonb), p_jurisdiction, p_industry, p_effective_date,
    coalesce(p_knowledge_ids, '[]'::jsonb), coalesce(p_source_ids, '[]'::jsonb),
    p_parent_content_id, p_research_job_id, v_org
  )
  returning "_id" into v_id;

  -- Provenance edges, unchanged from 20260913 §5.
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

  return jsonb_build_object(
    'ok', true,
    'content_id', v_id,
    'organizationId', v_org
  );
end;
$$;

comment on function public.content_create is
  'Create a Content Engine package. Any caller with a user session owns the package in my_tenant_id(), administrators included. Only the trusted server (no user session) may create platform-level content or name an organization.';


-- The browser needs this one precisely because the database decides ownership.
-- Revoked from PUBLIC as well as anon, for the same reason as every other
-- function here: a role-only revoke leaves the default PUBLIC grant intact.
revoke execute on function public.content_create(
  text, text, text, text, text, jsonb, text, text, bigint, jsonb, jsonb,
  uuid, uuid, text, uuid
) from public, anon;
grant execute on function public.content_create(
  text, text, text, text, text, jsonb, text, text, bigint, jsonb, jsonb,
  uuid, uuid, text, uuid
) to authenticated, service_role;
