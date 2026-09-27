select string_agg(proname || ' ' || md5(prosrc), E'\n' order by proname) as report
from pg_proc
where proname in ('admin_create_tenant','admin_create_pilot_organization','admin_list_users','admin_grant_complimentary_access');
