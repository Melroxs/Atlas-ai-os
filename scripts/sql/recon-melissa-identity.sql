-- Simulate Melissa's JWT identity to confirm is_super_admin() resolves true (rolled back)
begin;
select set_config(
  'request.jwt.claim.sub',
  (select u.id::text from auth.users u where u.email = 'melissa.o.rox@gmail.com'),
  true
);
select set_config('request.jwt.claims',
  (select json_build_object('sub', u.id::text, 'email', u.email, 'role', 'authenticated')::text
   from auth.users u where u.email = 'melissa.o.rox@gmail.com'),
  true);
select 'auth.uid=' || coalesce(auth.uid()::text, 'null')
  || ' | is_super_admin=' || is_super_admin()::text
  || ' | my_tenant=' || coalesce(my_tenant_id()::text, 'null') as report;
rollback;
