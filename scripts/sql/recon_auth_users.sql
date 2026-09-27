-- READ-ONLY: auth users, real-vs-test signal.
select string_agg(
         u.email || ' | conf=' || (case when u.email_confirmed_at is not null then 'Y' else 'n' end)
         || ' lastsign=' || coalesce(to_char(u.last_sign_in_at,'YYYY-MM-DD'),'never')
         || ' created=' || to_char(u.created_at,'YYYY-MM-DD'),
         E'\n' order by u.created_at) as report
from auth.users u;
