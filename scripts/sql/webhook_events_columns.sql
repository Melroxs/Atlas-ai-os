-- READ-ONLY: exact shape of processed_webhook_events so the idempotency probe
-- can supply every NOT NULL column.
select coalesce(jsonb_agg(jsonb_build_object(
         'col', column_name, 'type', data_type,
         'not_null', is_nullable = 'NO',
         'default', coalesce(column_default, 'none')
       ) order by ordinal_position), '[]'::jsonb) as columns
from information_schema.columns
where table_schema = 'public' and table_name = 'processed_webhook_events';
