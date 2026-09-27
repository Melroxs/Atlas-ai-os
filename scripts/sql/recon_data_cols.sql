-- READ-ONLY: tenant-ish column names on data tables.
select table_name || ' -> ' || string_agg(column_name, ', ' order by ordinal_position) as cols
from information_schema.columns
where table_schema = 'public'
  and table_name in ('documents','archivefiles','auditlogs','invites','connections')
  and (column_name ilike '%tenant%' or column_name ilike '%org%')
group by table_name
order by table_name;
