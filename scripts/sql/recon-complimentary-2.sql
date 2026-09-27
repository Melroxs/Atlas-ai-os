select
  'rows=' || (select count(*) from public.complimentary_access)
  || ' | policies=' || coalesce((select string_agg(format('%s:{%s}=%s', policyname, roles::text, coalesce(qual,'-')), ', ' order by policyname) from pg_policies where schemaname='public' and tablename='complimentary_access'), 'none')
  || ' | melissa=' || (select format('%s/%s', "platform_role", "account_status") from public.profiles where "email" = 'melissa.o.rox@gmail.com')
  || ' | is_super_admin=' || (select is_super_admin()::text)
as report;
