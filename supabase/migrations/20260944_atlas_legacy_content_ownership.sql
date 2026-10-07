-- ---------------------------------------------------------------------------
-- Atlas AI OS — adopt the legacy (org-less) blog packages into their workspace
--
-- THE DEFECT THIS REPAIRS
--   The 20 blog packages in public."atlasContentItems" were written BEFORE
--   20260935 added "organizationId", so they carry organizationId = NULL. They
--   cannot enter the Content Engine at all:
--
--     content_engine_enqueue  resolves the job's tenant FROM THE PACKAGE
--                             (select "organizationId" ... where "_id" = p_package)
--                             and hands it to jobs_create_job;
--     jobs_create_job         refuses a NULL tenant:
--                             raise exception 'Tenant is required.' using errcode = '22004';
--
--   so clicking generate on an existing post creates no atlas_jobs row, and the
--   worker — which is deployed, scheduled every minute and healthy — dequeues
--   nothing. Verified against production: atlas_jobs held 0 rows, the worker
--   tick returned {"processed":0}, and the enqueue path returned exactly
--   "ERROR: 22004: Tenant is required."
--
-- WHAT THIS MIGRATION DOES
--   Sets "organizationId" on exactly the orphan blog PACKAGES — contentType
--   'blog', no parent, no organization — to the ONE workspace that can operate
--   the Content Studio. Nothing else is written:
--
--     * the UPDATE names a single column, so title, slug, body, seo, status,
--       publishedAt, heroImage, socialImage, metadata and _creationTime (and
--       every updatedAt) are untouched;
--     * rows that already carry an organization are never matched, so content
--       created through the Content Studio is unaffected;
--     * no table, column, policy, index, function, trigger or grant is created,
--       changed or dropped. In particular jobs_create_job keeps refusing a NULL
--       tenant and content_engine_enqueue keeps its authorization guard: the
--       legacy ROWS are repaired to conform to the tenant model, and the tenant
--       model is NOT relaxed to accommodate them.
--
-- OWNERSHIP IS DERIVED FROM THE DATABASE, NEVER GUESSED
--   The target organization is read from Atlas's own records: the single
--   workspace with an ACTIVE membership for a user whose profile has an active
--   account and an internal platform_role ('super_admin' or 'atlas_admin').
--   Those are exactly the roles the Content Studio admits — canAccessCRM() in
--   src/lib/auth/access-gate.ts — and exactly what the database's own
--   is_atlas_admin() checks. If that set is empty, or resolves to more than one
--   workspace, this migration RAISES and changes nothing: it never picks an
--   organization arbitrarily. (Production resolves to one workspace, verified
--   before this migration was written.)
--
-- DATA SAFETY
--   - Idempotent: the predicate is `"organizationId" is null`, so re-running
--     matches nothing and writes nothing.
--   - A post-condition check aborts the whole migration (and rolls it back) if
--     any orphan blog package is left behind, so a partial adoption can never be
--     committed.
--
-- NOT IN SCOPE
--   Provider configuration, publishing, OAuth and the Content Studio UI are
--   deliberately untouched. An org-less row remains legal for platform-scope
--   content created by the trusted server, so no NOT NULL constraint is added.
-- ---------------------------------------------------------------------------

do $$
declare
  v_orgs      uuid[];
  v_org       uuid;
  v_adopted   int := 0;
  v_remaining int := 0;
begin
  -- 1. Resolve the owning workspace from Atlas's own records. Exactly one
  --    workspace must qualify, or nothing is changed.
  select array_agg(distinct m."tenantId")
    into v_orgs
  from public.memberships m
  join public.profiles p on p."_id" = m."userId"
  where m.status = 'active'
    and p.account_status = 'active'
    and p.platform_role in ('super_admin', 'atlas_admin');

  if v_orgs is null or array_length(v_orgs, 1) is null then
    raise exception 'Legacy content adoption aborted: no active workspace with an internal Atlas role could be identified, so the owner of the legacy blog content cannot be determined.'
      using errcode = '42501';
  end if;

  if array_length(v_orgs, 1) > 1 then
    raise exception 'Legacy content adoption aborted: % workspaces carry an active internal Atlas role (%), so the owner of the legacy blog content is ambiguous.',
      array_length(v_orgs, 1), v_orgs
      using errcode = '42501';
  end if;

  v_org := v_orgs[1];

  if not exists (select 1 from public.tenants t where t."_id" = v_org) then
    raise exception 'Legacy content adoption aborted: workspace % does not exist.', v_org
      using errcode = '23503';
  end if;

  -- 2. Adopt the orphan blog PACKAGES. One column, no timestamps, and only rows
  --    that have no organization yet — never a row the Content Studio owns.
  update public."atlasContentItems" c
     set "organizationId" = v_org
   where c."organizationId" is null
     and c."contentType" = 'blog'
     and c."parentContentId" is null;

  get diagnostics v_adopted = row_count;

  -- 3. Post-condition: a partial adoption must not be committed.
  select count(*)
    into v_remaining
  from public."atlasContentItems" c
  where c."organizationId" is null
    and c."contentType" = 'blog'
    and c."parentContentId" is null;

  if v_remaining > 0 then
    raise exception 'Legacy content adoption incomplete: % orphan blog package(s) remain after the backfill.', v_remaining
      using errcode = '23514';
  end if;

  raise notice 'Legacy content adoption: % orphan blog package(s) now belong to workspace %.', v_adopted, v_org;
end
$$;

comment on column public."atlasContentItems"."organizationId" is
  'Owning Atlas organization. NULL is reserved for platform-scope content created by the trusted server; customer and Content Studio packages always carry the organization that owns them (20260935, repaired for legacy blog packages in 20260944).';
