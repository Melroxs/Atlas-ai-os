-- READ-ONLY: tenants columns.
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'tenants'
order by ordinal_position;
