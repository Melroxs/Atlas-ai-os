-- Record 20260929 as applied. The SQL was executed in full via the project's
-- apply-migration.mjs immediately before this insert, and its effects were
-- verified live (admin_delete_organization present, 0 blocking user FKs,
-- 23 previously-blocking constraints now SET NULL, row counts unchanged).
insert into supabase_migrations.schema_migrations (version, name)
values ('20260929', '20260929_atlas_user_and_organization_deletion.sql')
on conflict (version) do nothing;
