-- READ-ONLY: find the tenant/org table name.
select table_name
from information_schema.tables
where table_schema = 'public'
  and (table_name ilike '%tenant%' or table_name ilike '%org%' or table_name ilike '%workspace%')
order by table_name;
