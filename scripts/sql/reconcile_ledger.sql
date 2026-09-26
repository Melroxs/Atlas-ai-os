-- ============================================================================
-- ATLAS — migration ledger reconciliation (WRITE: ledger rows only)
--
-- This is the non-destructive equivalent of
--   supabase migration repair --status applied <versions>
-- which only INSERTs into supabase_migrations.schema_migrations. No migration
-- SQL is executed here.
--
-- Every version below was verified OBJECT-BY-OBJECT against the live schema in
-- this session (see migration_reconciliation.sql + 20260922_columns.sql):
--   20260918  applied in this session (security hardening) — see report
--   20260919  covers BOTH repo files that share the version: stripe billing AND
--             regulatory schema reconciliation (11/11 + 19/19 objects present)
--   20260920  14/14 present
--   20260921  1/1 present
--   20260922  28/28 present + all 11 added columns present
--
-- DELIBERATELY NOT recorded: 20260913. It is only PARTIALLY applied live —
-- atlas_schedules and authoritativeSourceChecks are absent, the
-- atlas_jobs.tenant_id nullability change was not applied, and all 20 of its
-- functions are absent. Marking it applied would be false (rule: never mark a
-- migration applied unless its schema changes are demonstrably present).
-- ============================================================================

insert into supabase_migrations.schema_migrations (version, name) values
  ('20260918', '20260918_atlas_security_hardening.sql'),
  -- ONE version row is correct here: both files share version 20260919, and the
  -- ledger PK is `version`, so a single row makes `migration list`/`db push`
  -- treat that version as applied (covering both files).
  ('20260919', '20260919_atlas_stripe_billing.sql + 20260919_atlas_regulatory_schema_reconciliation.sql'),
  ('20260920', '20260920_atlas_blog_publishing.sql'),
  ('20260921', '20260921_atlas_billing_subscription_merge.sql'),
  ('20260922', '20260922_atlas_integration_foundation.sql')
on conflict (version) do nothing;
