select table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name in ('subscriptions', 'stripe_customers')
  and (column_name ilike '%stripe%' or column_name ilike '%status%'
       or column_name ilike '%tenant%' or column_name ilike '%customer%'
       or column_name ilike '%subscri%')
order by table_name, ordinal_position;
