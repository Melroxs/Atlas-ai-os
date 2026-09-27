-- Does anything from 20260929 already exist? (partial-apply check)
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'admin_delete_organization')::int
    as admin_delete_organization_fn,
  (select count(*) from pg_attribute
     where attrelid = 'public.invites'::regclass and attname = 'invitedBy' and attnotnull)::int
    as invites_invitedBy_still_notnull,
  (select count(*) from pg_attribute
     where attrelid = 'public.user_provisions'::regclass and attname = 'provisioned_by' and attnotnull)::int
    as user_provisions_provisioned_by_still_notnull,
  (select count(*) from pg_constraint c
     where c.contype = 'f'
       and c.confrelid in ('auth.users'::regclass, 'public.profiles'::regclass)
       and c.confdeltype in ('a','r'))::int
    as blocking_user_fks_remaining;
