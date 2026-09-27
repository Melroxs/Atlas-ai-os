-- Record 20260931 and 20260932 as applied.
--
-- 20260931 (admin_delete_organization member-snapshot fix): SQL was executed in
-- full via the project's apply-migration.mjs and verified live — the org
-- deletion path had been dead on every call (a bad `array_agg(distinct u)`
-- over a non-existent column), and a trial delete plus the bulk delete of 22
-- remaining orgs both succeeded afterwards. No access widening.
--
-- 20260932 (complimentary-access RPC fixes): SQL was executed in full via
-- apply-migration.mjs and verified live by simulating Melissa's JWT with
-- set_config('request.jwt.claim.sub', ...) inside a rolled-back transaction.
-- Verified byte-identical bodies in pg_proc (md5 12e8c945…, eade4f0a…,
-- 3e44952b…, e84c48dd…) and confirmed end-to-end that a super admin can now
-- create an organization, grant complimentary access on every duration
-- (7d/30d/90d/1y/lifetime), and create a Free Pilot organization.
insert into supabase_migrations.schema_migrations (version, name)
values ('20260931', '20260931_atlas_admin_delete_organization_member_snapshot_fix.sql'),
       ('20260932', '20260932_atlas_admin_quoted_creation_time_fix.sql')
on conflict (version) do nothing;
