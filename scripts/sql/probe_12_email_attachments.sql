-- The super_admin exception must NOT reach the email-attachments bucket.
-- Evaluated against a synthetic path (that bucket currently holds 0 objects),
-- using the live policy text transcribed from pg_policies.
begin;
select set_config('request.jwt.claim.sub', '0e914537-e62b-4982-a49d-3056f0deb2b8', true);
select set_config('request.jwt.claims', '{"sub":"0e914537-e62b-4982-a49d-3056f0deb2b8","role":"authenticated"}', true);
with s as (
  select 'email-attachments'::text as bucket_id,
         '877bf5ec-fd93-4ea1-8e55-280e320f32aa/some-attachment.pdf'::text as name
)
select
  public.is_super_admin() as is_super_admin,
  (s.bucket_id = 'email-attachments'
   and (storage.foldername(s.name))[1] in (
     select a.id::text from public.email_accounts a
     where a.tenant_id = public.get_current_tenant_id()
   )) as email_attachments_delete_allowed,
  'policy is unchanged and has no is_super_admin clause' as note
from s;
rollback;
