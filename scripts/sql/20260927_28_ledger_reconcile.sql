-- ============================================================================
-- ATLAS — migration ledger reconciliation (WRITE: ledger rows only)
--
-- Non-destructive equivalent of `supabase migration repair --status applied`.
-- Inserts ledger rows ONLY; executes no migration SQL.
--
-- Both versions were verified OBJECT-BY-OBJECT against the live schema:
--   20260927 — the 8 pilot functions, 4 tenant columns, atlas_pilot_status
--              guard, admin_create_tenant 2-arg, the admin_convert_pilot_to_paid
--              trusted-server guard and the pilot_limits column comment were all
--              confirmed present (the last two applied as a delta this session).
--   20260928 — both deletion RPCs present, SECURITY INVOKER, tenant/role
--              guarded, audited, anon EXECUTE revoked.
--
-- NOT recorded: 20260913 (deliberately, per the existing reconcile_ledger.sql).
-- ============================================================================

insert into supabase_migrations.schema_migrations (version, name) values
  ('20260927', '20260927_atlas_pilot_organizations.sql'),
  ('20260928', '20260928_atlas_ingested_file_deletion.sql')
on conflict (version) do nothing;

-- Echo the 2026092x ledger rows so the result is observable.
select version, name from supabase_migrations.schema_migrations
where version like '2026092%'
order by version;
