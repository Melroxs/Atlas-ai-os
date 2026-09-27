select table_name || ' :: ' || string_agg(column_name, ', ' order by ordinal_position) as cols
from information_schema.columns
where table_schema = 'public' and table_name = 'billing_audit_events'
group by table_name;
