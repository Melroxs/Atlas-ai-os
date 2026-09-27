-- READ-ONLY: how documents link to archive ingestions.
select table_name || ' :: ' || string_agg(column_name, ', ' order by ordinal_position) as cols
from information_schema.columns
where table_schema = 'public' and table_name in ('documents','archivefiles')
group by table_name;
