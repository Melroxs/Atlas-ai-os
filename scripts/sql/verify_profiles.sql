select count(*) as profiles_remaining,
       string_agg(email, ', ') as emails,
       string_agg(platform_role, ', ') as roles
from public.profiles;
