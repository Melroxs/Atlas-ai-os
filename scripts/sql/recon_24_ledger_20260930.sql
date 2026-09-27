-- Record 20260930 as applied. The SQL was executed in full via the project's
-- apply-migration.mjs immediately before this insert, and its effects were
-- verified live: both RPCs allow a platform super_admin while keeping the
-- owner/admin/manager gate, the per-file UPDATE is tenant-scoped, neither RPC
-- accepts a tenant argument, documents_storage_delete carries the super_admin
-- allowance limited to the documents/archives buckets, email-attachments is
-- untouched, and a super-admin deletion now writes an audit row.
insert into supabase_migrations.schema_migrations (version, name)
values ('20260930', '20260930_atlas_ingested_file_deletion_super_admin.sql')
on conflict (version) do nothing;
