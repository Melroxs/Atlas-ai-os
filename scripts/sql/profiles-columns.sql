select string_agg(format('%I %s', column_name, data_type), E'\n' order by ordinal_position) as report
from information_schema.columns
where table_schema = 'public' and table_name = 'profiles';
