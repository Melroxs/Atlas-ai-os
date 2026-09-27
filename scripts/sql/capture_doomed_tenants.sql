-- Capture the 23 doomed tenant IDs (everything except Test Company).
select string_agg(t."_id"::text || ' ' || t.name, E'\n' order by t.name) as doomed_tenants
from public.tenants t
where t.name <> 'Test Company';
