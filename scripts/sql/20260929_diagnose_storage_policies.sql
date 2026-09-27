-- Confirm the 20260930 dry run was rolled back: the storage delete policy
-- must still be the ORIGINAL (no is_super_admin clause).
select policyname, cmd, roles, qual
from pg_policies
where schemaname = 'storage' and tablename = 'objects'
  and policyname = 'documents_storage_delete';
