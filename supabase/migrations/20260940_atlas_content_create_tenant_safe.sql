-- ============================================================================
-- 20260940 — tenant-safe content_create
--
-- WHY THIS EXISTS
-- ---------------
-- The Content Studio's "create package" path calls public.content_create from
-- the browser. That function only ever existed in 20260913 §5, which is NOT
-- applied in production, so the Studio's create path could not work at all.
--
-- 20260913 §5 is deliberately NOT applied wholesale, for two reasons proven
-- against production:
--
--   1. Its RLS DDL drops and recreates contentprovenance_read as
--        for select to anon, authenticated using (true)
--      which is the exact P0 that 20260918 §5 closed: any anonymous visitor
--      reading provenance edges for UNPUBLISHED drafts.
--   2. Its content_create never sets "organizationId". 20260935 added that
--      column together with contentitems_org_read, which scopes a row to
--      "organizationId" = my_tenant_id(). An org-less package is therefore
--      invisible to the organization that created it, and because
--      contentitems_auth_read allows status IN ('approved','published') for
--      every authenticated user, an org-less row with an approved status
--      would be readable by every tenant — the same P0 the committed
--      content-engine-sql test exists to prevent.
--
-- So this migration carries ONLY the one function the browser actually needs,
-- re-specified so the database owns tenant derivation. Every dependency it
-- has (atlasContentItems, atlasContentProvenance, authoritativeKnowledge,
-- epoch_ms) already exists in production, so no table, index, policy or type
-- is added here and nothing already applied is edited.
--
-- THE INVARIANT
-- -------------
-- TENANT OWNERSHIP IS DERIVED, NEVER SUPPLIED. A caller-supplied
-- p_organization is honoured ONLY on the trusted-server / platform-admin path
-- and is only ever used to WIDEN an existing decision — an ordinary member's
-- organization always comes from my_tenant_id(). This mirrors
-- content_publication_upsert and content_automation_upsert, which resolve
-- their organization the same way.
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
  -- Trusted-server / platform-admin only. An organization member's ownership
  -- is always my_tenant_id() and this value is IGNORED unless it matches.
  p_organization   uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id       uuid;
  v_kid      text;
  v_prov     jsonb;
  v_org      uuid;
  v_parent_org uuid;
  v_trusted  boolean;
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

  -- ---------------------------------------------------------------------
  -- Tenant derivation. This is the whole point of the migration.
  -- ---------------------------------------------------------------------
  v_trusted := public.atlas_is_trusted_server() or public.is_atlas_admin();

  if v_trusted then
    -- The worker and platform admins may place platform-level content with no
    -- organization, and may name an organization explicitly.
    v_org := p_organization;
  else
    -- An ordinary member NEVER supplies its own organization.
    v_org := public.my_tenant_id();
    if v_org is null then
      raise exception 'Access denied: no active Atlas organization'
        using errcode = '42501';
    end if;
    -- A caller-supplied organization may only ever agree with the derived one.
    if p_organization is not null and p_organization is distinct from v_org then
      raise exception 'Access denied: cannot create content for another organization'
        using errcode = '42501';
    end if;
  end if;

  -- A package may not be parented to another organization's content, which
  -- would otherwise leak a cross-tenant link through the asset tree.
  if p_parent_content_id is not null then
    select "organizationId" into v_parent_org
    from public."atlasContentItems" where "_id" = p_parent_content_id;

    if not found then
      raise exception 'Unknown parent content item: %', p_parent_content_id
        using errcode = '42501';
    end if;
    if not v_trusted then
      if v_parent_org is distinct from v_org then
        raise exception 'Access denied: parent content belongs to another organization'
          using errcode = '42501';
      end if;
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

  -- Record a provenance edge for every knowledge item referenced. Unchanged
  -- from 20260913 §5: the lookup only runs for ids the caller supplied, and
  -- the caller cannot see a row that does not resolve.
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
  'Create a Content Engine package. Organization ownership is derived from my_tenant_id() for an organization member; a caller-supplied p_organization is honoured only on the trusted-server / platform-admin path.';


-- ----------------------------------------------------------------------------
-- Grants. The browser needs this one, because the organization it will own is
-- decided by the database and not by the request. It is revoked from PUBLIC as
-- well as anon: revoking from a role alone leaves the default PUBLIC grant in
-- place, which is how schedules_* became anonymously executable (20260936).
--
-- This deliberately moves content_create OUT of 20260918's service-only set.
-- It is safe to expose precisely because it no longer trusts the caller for
-- ownership; every other service-only function is untouched.
-- ----------------------------------------------------------------------------
revoke execute on function public.content_create(
  text, text, text, text, text, jsonb, text, text, bigint, jsonb, jsonb,
  uuid, uuid, text, uuid
) from public, anon;
grant execute on function public.content_create(
  text, text, text, text, text, jsonb, text, text, bigint, jsonb, jsonb,
  uuid, uuid, text, uuid
) to authenticated, service_role;
