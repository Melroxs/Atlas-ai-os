select string_agg(format('%s | %s | %s | %s | %s', _id, coalesce(email,'(null)'), coalesce(name,'-'),
       coalesce(platform_role,'-'), coalesce(account_status,'-')), E'\n' order by "_creationTime") as report
from public.profiles;

select string_agg(format('auth: %s | %s | created %s', id, email, created_at), E'\n' order by created_at) as report
from auth.users;
