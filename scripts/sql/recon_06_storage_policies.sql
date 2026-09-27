-- Live Storage policies governing deletion, before any change.
select policyname,
       cmd,
       roles::text,
       qual as using_expression
from pg_policies
where schemaname = 'storage'
  and tablename = 'objects'
  and cmd = 'DELETE'
order by policyname;
