-- READ-ONLY: FK rules that govern whether deleting archive files removes documents/chunks.
select tc.table_name || ' <- ' || ccu.table_name || '.' || ccu.column_name || ' ON DELETE ' || rc.delete_rule as fk
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
join information_schema.referential_constraints rc on rc.constraint_name = tc.constraint_name and rc.constraint_schema = tc.table_schema
where tc.constraint_type = 'FOREIGN KEY'
  and tc.table_schema = 'public'
  and tc.table_name in ('archivefiles','documents','documentchunks','archiveingestions')
order by tc.table_name, ccu.table_name;
