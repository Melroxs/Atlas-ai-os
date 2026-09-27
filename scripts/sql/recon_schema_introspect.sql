-- READ-ONLY schema introspection.
select table_name, ordinal_position, column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name in ('profiles','memberships','tenants','organizations','stripe_customers','subscriptions')
order by table_name, ordinal_position;
