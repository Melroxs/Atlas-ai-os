-- TRIAL: delete exactly one low-value org to validate the RPC path before the bulk delete.
-- Billing E2E 1789881566916 (e9c822b5-2e67-4ddd-bd92-e95555516c99) has 0 docs, 0 files, 0 claims, 1 audit log.
select public.admin_delete_organization(
         'e9c822b5-2e67-4ddd-bd92-e95555516c99'::uuid,
         'Production cleanup: retain only melissa.o.rox@gmail.com',
         false,   -- do not delete member accounts here; users are removed in a separate controlled step
         true,    -- no live Stripe subscription exists for this tenant (subscriptions = 0)
         '0e914537-e62b-4982-a49d-3056f0deb2b8'::uuid
       ) as result;
