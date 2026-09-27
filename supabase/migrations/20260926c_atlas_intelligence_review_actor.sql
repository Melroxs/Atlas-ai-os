-- ============================================================================
-- Atlas Intelligence — allow a trusted pipeline to record a review decision
--
-- WHY THIS MIGRATION EXISTS
--   content_publish_blog (20260920) accepts an explicit admin actor when the
--   caller is service_role, because the seed/publish pipeline runs with the
--   service role and therefore has no auth.uid(). content_review_decide was
--   never given the same branch, so it could only ever be called with a user
--   JWT.
--
--   The result is a real inconsistency in the content engine: the trusted
--   worker can publish an article it cannot approve, which is backwards, and
--   the editorial pipeline cannot record a human approval on behalf of the
--   named admin who gave it. Observed live when the Atlas Intelligence seed
--   run failed with "Not authorized to review Atlas content."
--
--   This adds the symmetric branch. It is NOT a privilege widening for
--   service_role, which already has full table access: it makes the actor
--   explicit and audited instead of implicit.
--
-- SECURITY POSTURE
--   * The service-role path REQUIRES a named actor that is a real super_admin
--     or atlas_admin in public.profiles. It cannot be called anonymously.
--   * The user path is unchanged: is_super_admin() / is_atlas_admin() against
--     auth.uid().
--   * anon and public still have no EXECUTE grant.
-- ============================================================================

create or replace function public.content_review_decide(
  p_content_id uuid,
  p_decision   text,
  p_note       text default null,
  p_actor      uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row      public."atlasContentItems";
  v_is_service boolean := coalesce(
                       current_setting('request.jwt.claims', true)::jsonb ->> 'role', ''
                     ) = 'service_role';
  v_actor    uuid;
  v_now      bigint := public.epoch_ms();
  v_status   text;
  v_approval text;
begin
  -- Either an atlas admin acting for themselves, or the trusted service-role
  -- worker acting for an admin actor it names explicitly. Same two-branch
  -- shape as content_publish_blog.
  if v_is_service then
    v_actor := p_actor;
    if v_actor is null or not exists (
      select 1 from public.profiles p
      where p."_id" = v_actor
        and p.platform_role in ('super_admin', 'atlas_admin')
    ) then
      raise exception 'A review decision requires a platform admin actor.' using errcode = '42501';
    end if;
  else
    if not (public.is_super_admin() or public.is_atlas_admin()) then
      raise exception 'Not authorized to review Atlas content.' using errcode = '42501';
    end if;
    v_actor := auth.uid();
  end if;

  if p_decision not in ('approved', 'rejected', 'needs_changes', 'in_review') then
    raise exception 'Unknown review decision: %', p_decision;
  end if;

  select * into v_row from public."atlasContentItems" where "_id" = p_content_id;
  if v_row."_id" is null then
    return jsonb_build_object('ok', false, 'error', 'content_not_found');
  end if;

  case p_decision
    when 'in_review' then
      if v_row."status" not in ('drafted', 'researching', 'approved', 'in_review') then
        raise exception 'Content cannot enter review from status %.', v_row."status";
      end if;
      v_status := 'in_review'; v_approval := 'pending';
    when 'approved' then
      if v_row."status" not in ('in_review', 'approved') then
        raise exception 'Content must be in review before it can be approved (status %).', v_row."status";
      end if;
      v_status := 'approved'; v_approval := 'approved';
    when 'rejected' then
      v_status := 'archived'; v_approval := 'rejected';
    when 'needs_changes' then
      v_status := 'drafted'; v_approval := 'needs_changes';
  end case;

  update public."atlasContentItems"
  set status = v_status,
      "approvalStatus" = v_approval,
      "approvedBy" = case when v_approval = 'approved' then v_actor else "approvedBy" end,
      "approvedAt" = case when v_approval = 'approved' then v_now else "approvedAt" end,
      "updatedAt" = v_now
  where "_id" = p_content_id;

  perform public.log_audit(
    'content_review_' || p_decision, 'content_item', p_content_id::text,
    jsonb_build_object(
      'note', p_note,
      'status', v_status,
      'approval_status', v_approval,
      'actor', v_actor
    )
  );

  return jsonb_build_object(
    'ok', true,
    'status', v_status,
    'approvalStatus', v_approval,
    'approvedBy', v_actor
  );
end $$;

revoke execute on function public.content_review_decide(uuid, text, text, uuid) from public, anon;
grant execute on function public.content_review_decide(uuid, text, text, uuid) to authenticated, service_role;
