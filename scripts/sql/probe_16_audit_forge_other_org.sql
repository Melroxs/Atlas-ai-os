-- FORGERY GUARD 1: a normal user must not be able to write an audit row for
-- an organization they do not act for.
begin;
select set_config('request.jwt.claim.sub', '21a46f50-6703-44b2-983d-35592bc4f690', true);
select set_config('request.jwt.claims', '{"sub":"21a46f50-6703-44b2-983d-35592bc4f690","role":"authenticated"}', true);
select public.ingestion_write_audit(
  '6379923e-4997-4a6a-a75d-6cf20fd1c993',                       -- NOT their org
  '21a46f50-6703-44b2-983d-35592bc4f690',
  'super_admin',                                                -- claiming to be one
  'forged_action', 'archiveFiles', 'forged-target', '{}'::jsonb
) as result;
rollback;
