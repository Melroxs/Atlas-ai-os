-- FORGERY GUARD 2: a caller must not be able to attribute an audit row to a
-- different user, even for their OWN organization.
begin;
select set_config('request.jwt.claim.sub', '21a46f50-6703-44b2-983d-35592bc4f690', true);
select set_config('request.jwt.claims', '{"sub":"21a46f50-6703-44b2-983d-35592bc4f690","role":"authenticated"}', true);
select public.ingestion_write_audit(
  '877bf5ec-fd93-4ea1-8e55-280e320f32aa',                       -- their OWN org
  '0e914537-e62b-4982-a49d-3056f0deb2b8',                       -- but a DIFFERENT actor
  'user', 'forged_action', 'archiveFiles', 'forged-target', '{}'::jsonb
) as result;
rollback;
