-- READ-ONLY: claim-related tables and their columns.
select table_name || ' :: ' || string_agg(column_name, ', ' order by ordinal_position) as cols
from information_schema.columns
where table_schema = 'public'
  and table_name ilike '%claim%'
group by table_name
order by table_name;
