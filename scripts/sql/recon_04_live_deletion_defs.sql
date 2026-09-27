-- Current live definitions of the two graded deletion RPCs (prosrc).
select p.proname,
       p.prosecdef as security_definer,
       pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('ingestion_delete_archive_file', 'ingestion_delete_archive')
order by p.proname;
