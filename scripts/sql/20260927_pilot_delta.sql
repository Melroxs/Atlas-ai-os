-- ============================================================================
-- ATLAS — 20260927 pilot migration DELTA (WRITE: one function + one comment)
--
-- Verified live in this session (scripts/sql/pilot_phase1_readonly.sql):
--   * 20260927 objects ARE present in production (8 pilot functions, 4 tenant
--     columns, atlas_pilot_status guarded, admin_create_tenant 2-arg only).
--   * BUT the live admin_convert_pilot_to_paid still guards with
--     `is_super_admin()` ONLY. The Stripe webhook runs as service_role and is
--     therefore NOT a super_admin, so the pilot→paid conversion would fail with
--     "Access denied: super_admin required" in production.
--   * The pilot_limits column comment (reserved/not-enforced) is also absent.
--
-- Therefore this applies ONLY those two missing pieces — never the whole
-- migration again. Idempotent (create or replace + comment).
--
-- The function body is copied verbatim from
-- supabase/migrations/20260927_atlas_pilot_organizations.sql so production ends
-- up exactly equal to the committed migration. No other object is touched.
-- ============================================================================

create or replace function public.admin_convert_pilot_to_paid(
  p_tenant_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
  v_tenant record;
begin
  if not (public.is_super_admin() or public.atlas_is_trusted_server()) then
    raise exception 'Access denied: super_admin required';
  end if;

  select * into v_tenant from public.tenants where _id = p_tenant_id;
  if not found then
    raise exception 'Organization not found.';
  end if;
  if v_tenant.account_type is distinct from 'free_pilot' then
    raise exception 'This organization is not a Free Pilot organization.';
  end if;

  -- Revoke the pilot entitlement so only the paid subscription grants access.
  update public.complimentary_access
  set status = 'revoked', revoked_at = v_now, revoked_by = auth.uid(), updated_at = v_now
  where organization_id = p_tenant_id and status = 'active';

  update public.tenants
  set account_type = 'standard',
      pilot_converted_at = v_now
  where _id = p_tenant_id;

  insert into public.atlas_audit_log (
    actor_id, actor_email, action, target_type, target_id, details
  ) values (
    auth.uid(),
    (select email from public.profiles where _id = auth.uid()),
    'pilot_converted_to_paid',
    'organization',
    p_tenant_id,
    jsonb_build_object(
      'reason', p_reason,
      'converted_at', v_now,
      'has_paid_subscription', exists (
        select 1 from public.organization_subscriptions s
        where s.organization_id = p_tenant_id
          and s.status in ('active', 'trialing')
      )
    )
  );

  return jsonb_build_object(
    'ok', true,
    'tenant_id', p_tenant_id,
    'account_type', 'standard',
    'status', public.atlas_pilot_status(p_tenant_id),
    'converted_at', v_now
  );
end;
$$;

revoke execute on function public.admin_convert_pilot_to_paid(uuid, text) from public, anon;
grant execute on function public.admin_convert_pilot_to_paid(uuid, text) to authenticated, service_role;

comment on column public.tenants.pilot_limits is
  'RESERVED pilot-limit metadata. Not enforced by any code path; a Free Pilot org is exempt from plan limits via the complimentary access bypass. Do not present as enforceable.';
