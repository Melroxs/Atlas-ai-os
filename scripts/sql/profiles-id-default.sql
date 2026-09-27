select format('%I default=%s nullable=%s', column_name, coalesce(column_default,'NONE'), is_nullable) as report
from information_schema.columns
where table_schema='public' and table_name='profiles' and column_name = '_id';
