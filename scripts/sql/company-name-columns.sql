select string_agg(format('%I.%I', table_name, column_name), E'\n' order by table_name, column_name) as report
from information_schema.columns
where table_schema = 'public'
  and (column_name in ('company_name', '_updated_at', '_creationtime', '_creationTime'));
