-- ==========================================================================
-- 20260934 — tenants_claim_invites: activate the invited profile even when the
--            membership already exists.
--
-- STATUS: NOT APPLIED. Apply deliberately (see the bottom of this file).
--
-- WHY
-- ---
-- 20260825_fix_claim_invites_activate_user.sql made this function set
-- profiles.account_status = 'active' when an invited user claims their pending
-- invite. That fix is incomplete: the loop `continue`s as soon as a membership
-- row already exists for (tenantId, userId), which SKIPS the profile
-- activation.
--
-- Atlas creates the membership before the invitee ever clicks their link
-- (admin-provision-user `invite` inserts the membership directly), so for a
-- user invited through the Super Admin flow the membership is already present
-- when the claim runs, the function returns claimed = 0, and the profile is
-- left account_status = 'pending'. The Atlas access gate
-- (src/lib/auth/access-gate.ts) is fail-closed on 'pending', so the invited
-- user authenticates successfully and is then denied — permanently, because
-- there is no other code path that promotes their profile.
--
-- WHAT CHANGES
-- ------------
-- Only the ordering inside the loop:
--   * the duplicate-membership guard now skips the INSERT, not the whole
--     iteration — the existing membership (and its role) is left untouched;
--   * the invite is marked accepted, the profile is activated and the audit
--     row is written in both cases.
--
-- WHAT DOES NOT CHANGE
-- --------------------
--   * It never inserts or re-roles a membership that already exists.
--   * It never assigns a platform role.
--   * It only ever touches the CALLER's own profile (`_id = auth.uid()`), and
--     only to move 'pending' -> 'active', and only when an Atlas admin left a
--     pending invite row for the caller's own email. It cannot be used to
--     activate someone else's account.
--   * Authorization is unchanged: account_status = 'active' still has to clear
--     the tenant-membership and billing gates in evaluateAtlasAccess, and no
--     RLS policy, role mapping or entitlement is modified.
--
-- APPLYING (requires explicit approval — it is a production change)
-- ---------------------------------------------------------------------------
--   node scripts/run-db-sql.mjs supabase/migrations/20260934_atlas_claim_invites_activate_existing_member.sql
-- and then record it with a scripts/sql/record_ledger_20260934.sql following
-- the 20260933 convention.
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.tenants_claim_invites()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_email text;
  v_pending record;
  v_claimed bigint := 0;
  v_dup uuid;
BEGIN
  IF v_user IS NULL THEN return jsonb_build_object('claimed', 0); END IF;
  SELECT lower(trim(coalesce(email, ''))) INTO v_email FROM public.profiles WHERE _id = v_user;
  IF v_email = '' THEN return jsonb_build_object('claimed', 0); END IF;

  for v_pending in
    SELECT * FROM public.invites i
    WHERE i.email = v_email AND i.status = 'pending'
  loop
    SELECT m._id INTO v_dup FROM public.memberships m
    WHERE m."tenantId" = v_pending."tenantId" AND m."userId" = v_user LIMIT 1;

    -- Only create the membership when it is genuinely missing. An existing
    -- membership keeps its role and status untouched.
    IF v_dup IS NULL THEN
      INSERT INTO public.memberships ("tenantId", "userId", role, status, "invitedBy", "joinedAt")
      VALUES (v_pending."tenantId", v_user, v_pending.role, 'active', v_pending."invitedBy", public.epoch_ms());
    END IF;

    UPDATE public.invites SET status = 'accepted' WHERE _id = v_pending._id;

    -- Activate the invited profile. This must run even when the membership
    -- already existed: an account an Atlas admin explicitly invited must not
    -- be left denied by the fail-closed access gate.
    UPDATE public.profiles
    SET account_status = 'active'
    WHERE _id = v_user AND account_status = 'pending';

    INSERT INTO public.auditLogs ("tenantId", "actorType", "actorId", "actionType", "targetType", "metadata")
    VALUES (v_pending."tenantId", 'user', v_user, 'member_joined', 'membership', jsonb_build_object('email', v_email));

    v_claimed := v_claimed + 1;
  end loop;

  return jsonb_build_object('claimed', v_claimed);
END;
$$;
