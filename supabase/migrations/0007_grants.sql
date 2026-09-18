-- ============================================================================
-- Atlas on Supabase — migration 0007: role grants.
--
-- RLS policies decide WHICH rows a role may touch, but Postgres still needs
-- base table privileges for the role to touch them at all. Without these
-- grants every RPC fails with `permission denied for table … (42501)`.
--
-- SECURITY NOTE (corrected): the original version of this file granted `all` on
-- routines to `anon` as well, reasoning that "row-level security is the actual
-- gate (anon has no uid, so no rows pass its policies)". That reasoning does NOT
-- hold for a SECURITY DEFINER function, which executes with the definer's
-- privileges and bypasses RLS. Granting EXECUTE on every routine to `anon`
-- therefore exposed every definer function to unauthenticated callers,
-- including billing-state writers and the credential reader that have no
-- authorization check of their own.
--
-- Routine EXECUTE is now granted to `authenticated` and `service_role` only.
-- Table and sequence grants still include `anon` because RLS genuinely is the
-- gate for row access. Explicit, least-privilege function grants are set by
-- `20260918_atlas_security_hardening.sql`, which sorts after every migration
-- and is the authoritative source for function privileges.
-- ============================================================================

grant usage on schema public to anon, authenticated;

grant all on all tables in schema public to anon, authenticated;
grant all on all routines in schema public to authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated;

-- Future tables/sequences inherit the same grants automatically. Future
-- FUNCTIONS deliberately do not: routine EXECUTE is granted explicitly so a new
-- SECURITY DEFINER function is never auto-exposed to `anon`.
alter default privileges in schema public
  grant all on tables to anon, authenticated;
alter default privileges in schema public
  grant all on routines to authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated;
