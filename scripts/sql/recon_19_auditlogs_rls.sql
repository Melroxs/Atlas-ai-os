select
  c.relrowsecurity as rls_enabled,
  p.policyname,
  p.cmd,
  p.roles::text,
  p.qual as using_expr,
  p.with_check as check_expr
from pg_class c
left join pg_policies p
  on p.schemaname = 'public' and p.tablename = 'auditLogs'
where c.oid = 'public.auditLogs'::regclass
order by p.policyname nulls first, p.cmd nulls first;
