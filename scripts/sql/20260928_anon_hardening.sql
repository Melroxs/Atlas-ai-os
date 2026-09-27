-- ============================================================================
-- ATLAS — 20260928 anon posture hardening (WRITE: two REVOKEs)
--
-- The deletion RPCs are SECURITY INVOKER and fail closed for an anon key
-- (auth.uid() is NULL → "You must be signed in..."), but Postgres grants
-- EXECUTE to PUBLIC by default, so `anon` inherited EXECUTE. The 20260918
-- hardening revokes PUBLIC/anon rather than relying on the in-body guard;
-- this reproduces that posture for the two new functions.
--
-- No other object is touched. Idempotent.
-- ============================================================================

revoke execute on function public.ingestion_delete_archive_file(uuid, text) from public, anon;
revoke execute on function public.ingestion_delete_archive(uuid, text) from public, anon;
