select "_id"::text as melissa_profile_id, email, platform_role, account_status
from public.profiles
where lower(email) = 'melissa.o.rox@gmail.com';
