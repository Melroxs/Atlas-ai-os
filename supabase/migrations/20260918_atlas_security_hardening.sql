-- ============================================================================
-- Atlas — security hardening: blanket EXECUTE exposure, credential/outreach
-- IDOR fixes, and the server-side seat authority.
--
-- This migration sorts AFTER 20260913 (the platform-infrastructure migration)
-- so it is the last word on function privileges.
--
-- ============================================================================
-- WHY THIS EXISTS — the blanket grant, and where it really came from
-- ============================================================================
--
-- `20260913_atlas_platform_infrastructure.sql` ends with:
--
--     grant execute on all functions in schema public to anon, authenticated, service_role;
--
-- with the rationale "Row Level Security remains the real gate. anon has no uid,
-- so it can only ever satisfy the published-content read policies."
--
-- That rationale is WRONG for SECURITY DEFINER functions, which execute with
-- the definer's privileges and therefore BYPASS RLS entirely.
--
-- The same blanket grant — plus an `alter default privileges` that keeps
-- re-applying it to every future function — already exists in the base
-- migration `0007_grants.sql`:
--
--     grant all on all routines in schema public to anon, authenticated;
--     alter default privileges in schema public grant all on routines to anon, authenticated;
--
-- So the exposure is not new in 20260913; 20260913 merely re-declared it. The
-- fix therefore cannot live in 20260913 alone — it has to be an explicit,
-- authoritative re-grant here, and it has to cover `PUBLIC` as well, because
-- Postgres grants EXECUTE to PUBLIC by default and `anon` inherits through it.
-- Revoking from `anon` alone would NOT remove the access.
--
-- Affected functions that are SECURITY DEFINER with NO authorization check of
-- their own (verified by inspecting the final deployed definition of every
-- public function):
--
--   * tenants_activate_after_payment        — sets tenants.billing_state='active'
--                                             for an ARBITRARY tenant id, with no
--                                             check at all => unauthenticated
--                                             payment bypass.
--   * tenants_handle_payment_failure /
--     tenants_handle_subscription_cancelled — same shape, billing-state tampering.
--   * billing_apply_state                   — billing state writer (Paddle webhook).
--   * email_accounts_get_credentials        — returns the full email_accounts row
--                                             INCLUDING encrypted_credentials, for
--                                             any id => credential disclosure.
--   * outreach_records_update_status        — updates any tenant's delivery state
--                                             by provider_message_id => cross-tenant write.
--   * industry_ingest_corpus /
--     industry_seed_internal                — write the knowledge/corpus tables.
--   * the platform/content engine RPCs
--     (schedules_*, sources_*, knowledge_*,
--      content_*)                            — internal platform administration.
--
-- ============================================================================
-- PRIVILEGE MODEL ESTABLISHED HERE
-- ============================================================================
--   service_role   — EXECUTE on every function in `public` (trusted server role;
--                    already BYPASSRLS). This is where every privileged
--                    operation the Edge Functions perform now lives.
--   authenticated  — EXECUTE on every function EXCEPT the service-only set.
--                    RLS plus each function's own tenant/role guard remain the
--                    gate for signed-in users.
--   anon           — EXECUTE on a small, explicit allowlist ONLY: the RLS
--                    predicate helpers that policies can evaluate for an
--                    anonymous query, and the two genuinely public RPCs.
--                    Everything else is revoked from `anon` AND `PUBLIC`.
--   PUBLIC         — revoked; nothing relies on the implicit default grant.
--
-- Idempotent and replay-safe: `create or replace`, `if not exists`, and
-- grant/revoke loops driven off the catalog.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. IDOR fix — email_accounts_get_credentials
-- ---------------------------------------------------------------------------
-- Was: `SELECT row_to_json(a) FROM email_accounts a WHERE a.id = p_id` with no
-- tenant scoping and no guard, returning `encrypted_credentials` for any id.
--
-- Now: service_role only (its documented caller is the mail Edge Function,
-- which decrypts server-side). For any non-service caller the row must belong
-- to the caller's own tenant.

create or replace function public.email_accounts_get_credentials(
  p_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account jsonb;
begin
  if p_id is null then
    raise exception 'Account id is required.' using errcode = '22004';
  end if;

  -- A caller with a user JWT must own the account; service_role (no auth.uid())
  -- is the already-trusted Edge Function path.
  if auth.uid() is not null then
    if public.get_current_tenant_id() is null then
      raise exception 'No active workspace' using errcode = '42501';
    end if;

    if not exists (
      select 1
      from public.email_accounts a
      where a.id = p_id
        and a.tenant_id = public.get_current_tenant_id()
    ) then
      raise exception 'Access denied' using errcode = '42501';
    end if;
  end if;

  select row_to_json(a) into v_account
  from public.email_accounts a
  where a.id = p_id;

  return v_account;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. IDOR fix — outreach_records_update_status
-- ---------------------------------------------------------------------------
-- Was: cross-tenant `UPDATE outreach_records ... WHERE provider_message_id = $1`
-- with no tenant scope and no status validation. Now the status value is
-- constrained to the states the table's own CHECK constraint models, and the
-- function is service_role only (it exists for a delivery-webhook callback).

create or replace function public.outreach_records_update_status(
  p_provider_message_id text,
  p_status text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_provider_message_id is null or btrim(p_provider_message_id) = '' then
    raise exception 'Provider message id is required.' using errcode = '22004';
  end if;

  -- Mirrors outreach_records.status CHECK exactly.
  if p_status is null or p_status not in (
    'draft', 'queued', 'sent', 'sent-test', 'delivered',
    'opened', 'clicked', 'replied', 'bounced', 'failed', 'cancelled'
  ) then
    raise exception 'Invalid status: %', p_status using errcode = '22023';
  end if;

  update public.outreach_records
  set
    status = p_status,
    updated_at = now(),
    delivered_at = case when p_status = 'delivered' then now() else delivered_at end,
    opened_at = case when p_status = 'opened' then now() else opened_at end,
    clicked_at = case when p_status = 'clicked' then now() else clicked_at end,
    replied_at = case when p_status = 'replied' then now() else replied_at end,
    bounced_at = case when p_status = 'bounced' then now() else bounced_at end,
    failed_at = case when p_status = 'failed' then now() else failed_at end
  where provider_message_id = p_provider_message_id
    and status not in ('cancelled');

  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Seat authority (server-side, tenant-aware, fail-closed)
-- ---------------------------------------------------------------------------
-- Enforcement source for the plan seat limits. src/lib/billing/plans.ts stays
-- the display source; a parity test asserts the two never diverge.

create table if not exists public.plan_seat_limits (
  plan text primary key,
  -- NULL = unlimited (Scale).
  max_seats integer,
  updated_at bigint not null default (extract(epoch from now()) * 1000)::bigint
);

alter table public.plan_seat_limits enable row level security;
revoke all on table public.plan_seat_limits from public, anon, authenticated;

insert into public.plan_seat_limits (plan, max_seats) values
  ('ATLAS_STARTER', 5),
  ('ATLAS_GROWTH', 25),
  ('ATLAS_SCALE', null)
on conflict (plan) do nothing;

create or replace function public.org_seat_limit(p_plan text)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select l.max_seats
  from public.plan_seat_limits l
  where l.plan = p_plan
$$;

-- Seat status for an organization.
--   { plan, used, limit, remaining, allowed, reason }
-- reason: super_admin | complimentary | within_limit | seat_limit_reached
--       | unlimited | no_plan | not_a_member
-- Tenant isolation: a non-super_admin caller must be a member of p_tenant.
-- FAIL-CLOSED: an unresolvable plan yields allowed=false / 'no_plan'.
create or replace function public.org_seat_status(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_is_super boolean := public.is_super_admin();
  v_used integer;
  v_complimentary boolean;
  v_plan text;
  v_status text;
  v_limit integer;
  v_remaining integer;
begin
  if p_tenant is null then
    return jsonb_build_object(
      'plan', null, 'used', 0, 'limit', null, 'remaining', null,
      'allowed', false, 'reason', 'no_plan'
    );
  end if;

  if not v_is_super then
    if not exists (
      select 1 from public.memberships m
      where m."userId" = auth.uid()
        and m."tenantId" = p_tenant
    ) then
      return jsonb_build_object(
        'plan', null, 'used', 0, 'limit', null, 'remaining', null,
        'allowed', false, 'reason', 'not_a_member'
      );
    end if;
  end if;

  select count(*)::int into v_used
  from public.memberships m
  where m."tenantId" = p_tenant;

  if v_is_super then
    return jsonb_build_object(
      'plan', null, 'used', v_used, 'limit', null, 'remaining', null,
      'allowed', true, 'reason', 'super_admin'
    );
  end if;

  v_complimentary := exists (
    select 1
    from public.complimentary_access c
    where c.organization_id = p_tenant
      and c.status = 'active'
      and (c.expires_at is null
           or c.expires_at > (extract(epoch from now()) * 1000)::bigint)
  );

  if v_complimentary then
    return jsonb_build_object(
      'plan', null, 'used', v_used, 'limit', null, 'remaining', null,
      'allowed', true, 'reason', 'complimentary'
    );
  end if;

  select s.internal_plan, s.status
    into v_plan, v_status
  from public.organization_subscriptions s
  where s.organization_id = p_tenant
  limit 1;

  if v_plan is null or v_status is null or v_status not in ('active', 'trialing') then
    return jsonb_build_object(
      'plan', v_plan, 'used', v_used, 'limit', null, 'remaining', null,
      'allowed', false, 'reason', 'no_plan'
    );
  end if;

  v_limit := public.org_seat_limit(v_plan);

  if v_limit is null then
    return jsonb_build_object(
      'plan', v_plan, 'used', v_used, 'limit', null, 'remaining', null,
      'allowed', true, 'reason', 'unlimited'
    );
  end if;

  v_remaining := v_limit - v_used;

  return jsonb_build_object(
    'plan', v_plan,
    'used', v_used,
    'limit', v_limit,
    'remaining', case when v_remaining < 0 then 0 else v_remaining end,
    'allowed', v_remaining > 0,
    'reason', case when v_remaining > 0 then 'within_limit' else 'seat_limit_reached' end
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- 3b. JOB ENQUEUE / READ / LIFECYCLE AUTHORIZATION
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS
--
-- `atlas_jobs` and `atlas_job_steps` are tenant-owned (tenant_id NOT NULL,
-- RLS enabled), but every job RPC is SECURITY DEFINER, so the tables' tenant
-- policies never apply to them. In the original bodies (0020_atlas_jobs.sql,
-- 0021_atlas_human_reviews.sql) the caller-supplied `p_tenant_id` / `p_job_id`
-- was therefore the whole boundary. Three concrete holes:
--
--   * jobs_create_job trusted `p_user_id` as the caller. Any authenticated user
--     could name another user, satisfy the membership check against THAT user's
--     tenant, and enqueue work attributed to them.
--   * jobs_dequeue drained EVERY tenant's queue with no predicate at all.
--   * jobs_complete_job / _step, jobs_fail_job / _step, jobs_retry_step,
--     jobs_cancel_job, jobs_unlock_stuck and jobs_awaiting_review called
--     `perform public.atlas_is_trusted_server();` — which discards the boolean
--     and guards nothing. An ordinary authenticated user could complete, fail,
--     cancel or re-queue any job in any tenant.
--   * jobs_stats aggregates across EVERY tenant and had no guard, exposing
--     global queue depth / failure counts to any signed-in user.
--
-- AUTHORIZATION MODEL ESTABLISHED HERE
--
--   authenticated + tenant member (or super_admin)
--     jobs_create_job, jobs_create_step, jobs_get_job          — guarded in-body
--     jobs_list_jobs, jobs_get_events                          — guarded in 5b-vii
--     jobs_resume_from_review                                  — guarded in 5b-viii
--   internal operator (platform_role super_admin/atlas_admin) or service_role
--     jobs_stats                                               — guarded in-body
--   trusted server ONLY (service_role / direct superuser; no client role)
--     jobs_dequeue and every worker-owned lifecycle transition  — asserted in-body
--     AND named in `v_service_only` (section 4)
--
-- Identity for jobs_create_job derives from auth.uid(). `p_user_id` is honoured
-- only for a trusted server connection and never establishes membership on its
-- own. Tenant membership is always verified against public.memberships through
-- atlas_assert_tenant_access(), so a caller-supplied tenant id grants nothing.

-- ---------------------------------------------------------------------------
-- jobs_create_job — enqueue (idempotent on idempotency_key)
-- ---------------------------------------------------------------------------
create or replace function public.jobs_create_job(
  p_tenant_id    uuid,
  p_job_type     text,
  p_idempotency_key text,
  p_user_id      uuid default null,
  p_priority     int default 3,
  p_payload      jsonb default '{}',
  p_max_attempts int default 3,
  p_scheduled_at timestamptz default null,
  p_parent_job_id uuid default null,
  p_tags         text[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid;
  v_job_id uuid;
begin
  if p_tenant_id is null then
    raise exception 'Tenant is required.' using errcode = '22004';
  end if;

  -- Caller identity derives from the session. p_user_id is NEVER the identity
  -- of an authenticated caller; it is only honoured for a trusted server
  -- connection (worker / scheduler) that has no user JWT.
  if auth.uid() is not null then
    v_user := auth.uid();
  elsif public.atlas_is_trusted_server() then
    v_user := p_user_id;
  else
    raise exception 'Authenticated caller required.' using errcode = '42501';
  end if;

  -- Server-side tenant authorization: the caller-supplied tenant id only
  -- selects the target, it does not grant access.
  perform public.atlas_assert_tenant_access(p_tenant_id);

  -- Idempotency is scoped to the authorised tenant.
  select id into v_job_id
  from public.atlas_jobs
  where tenant_id = p_tenant_id
    and idempotency_key = p_idempotency_key
    and status not in ('completed', 'cancelled')
  limit 1;

  if v_job_id is not null then
    return jsonb_build_object('job_id', v_job_id, 'deduplicated', true);
  end if;

  insert into public.atlas_jobs (
    tenant_id, user_id, job_type, status, priority,
    idempotency_key, payload, max_attempts,
    scheduled_at, parent_job_id, tags
  ) values (
    p_tenant_id, v_user, p_job_type, 'pending', p_priority,
    p_idempotency_key, p_payload, p_max_attempts,
    p_scheduled_at, p_parent_job_id, p_tags
  )
  returning id into v_job_id;

  insert into public.atlas_job_events (job_id, event_type, payload, actor)
  values (v_job_id, 'job_created', jsonb_build_object(
    'job_type', p_job_type,
    'priority', p_priority,
    'idempotency_key', p_idempotency_key
  ), coalesce(v_user::text, 'system'));

  update public.atlas_jobs set status = 'queued' where id = v_job_id;

  insert into public.atlas_job_events (job_id, event_type, payload, actor)
  values (v_job_id, 'job_queued', jsonb_build_object('job_type', p_job_type), 'system');

  return jsonb_build_object('job_id', v_job_id, 'deduplicated', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- jobs_create_step — add a step to an existing job
-- ---------------------------------------------------------------------------
create or replace function public.jobs_create_step(
  p_job_id       uuid,
  p_step_type    text,
  p_sequence     int,
  p_input        jsonb default '{}',
  p_max_attempts int default 3
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_step_id uuid;
begin
  -- Resolve the job's tenant FIRST, then authorise the caller against it. A
  -- step can only be created inside a tenant the caller may already write to.
  select j.tenant_id into v_tenant
  from public.atlas_jobs j
  where j.id = p_job_id
  for share;

  if v_tenant is null then
    raise exception 'Job not found' using errcode = '42501';
  end if;

  perform public.atlas_assert_tenant_access(v_tenant);

  insert into public.atlas_job_steps (job_id, step_type, sequence, input, max_attempts)
  values (p_job_id, p_step_type, p_sequence, p_input, p_max_attempts)
  returning id into v_step_id;

  return jsonb_build_object('step_id', v_step_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- jobs_get_job — read a job with its steps
-- ---------------------------------------------------------------------------
create or replace function public.jobs_get_job(
  p_job_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_job jsonb;
  v_steps jsonb;
begin
  -- A signed-in caller may only read a job whose tenant it belongs to; an
  -- unknown job id returns NULL (no existence oracle), a foreign job raises.
  select j.tenant_id into v_tenant
  from public.atlas_jobs j
  where j.id = p_job_id
  for share;

  if v_tenant is null then
    return null;
  end if;

  perform public.atlas_assert_tenant_access(v_tenant);

  select to_jsonb(j.*) into v_job
  from public.atlas_jobs j
  where j.id = p_job_id;

  select jsonb_agg(to_jsonb(s.*) order by s.sequence)
  into v_steps
  from public.atlas_job_steps s
  where s.job_id = p_job_id;

  return v_job || jsonb_build_object('steps', coalesce(v_steps, '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- jobs_dequeue — drain the queue (TRUSTED WORKER ONLY)
-- ---------------------------------------------------------------------------
-- Intentionally has NO tenant predicate: AtlasWorker is cross-tenant
-- infrastructure (it runs platform-wide knowledge/content jobs as well as
-- tenant jobs). The protection is the authorization boundary, not a tenant
-- filter: only a trusted server connection may execute it. It is revoked from
-- public/anon/authenticated in section 4 and asserts trust in-body.
create or replace function public.jobs_dequeue(
  p_worker_id    text,
  p_job_types    text[] default null,
  p_max_jobs     int default 1
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jobs jsonb := '[]'::jsonb;
  v_row record;
  v_lock_timeout interval := interval '5 minutes';
  v_max int := greatest(coalesce(p_max_jobs, 1), 1);
begin
  -- Ordinary authenticated users (and anon) must never drain the queue.
  perform public.atlas_assert_trusted_server();

  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'Worker id is required.' using errcode = '22004';
  end if;

  for v_row in
    select j.id
    from public.atlas_jobs j
    where j.status in ('pending', 'queued')
      and (j.scheduled_at is null or j.scheduled_at <= now())
      and (p_job_types is null or j.job_type = any(p_job_types))
    order by j.priority asc, j.scheduled_at asc nulls first, j.created_at asc
    limit v_max
    for update of j skip locked
  loop
    update public.atlas_jobs
    set status = 'processing',
        locked_by = p_worker_id,
        locked_at = now(),
        lock_expires_at = now() + v_lock_timeout,
        started_at = case when started_at is null then now() else started_at end,
        attempt_count = attempt_count + 1
    where id = v_row.id;

    insert into public.atlas_job_events (job_id, event_type, payload, actor)
    values (v_row.id, 'job_started', jsonb_build_object('worker_id', p_worker_id), p_worker_id);

    insert into public.atlas_job_attempts (job_id, worker_id, attempt_number, status)
    select v_row.id, p_worker_id, j.attempt_count, 'running'
    from public.atlas_jobs j where j.id = v_row.id;

    v_jobs := v_jobs || to_jsonb(v_row.id);
  end loop;

  return jsonb_build_object('jobs', v_jobs, 'count', jsonb_array_length(v_jobs));
end;
$$;

-- ---------------------------------------------------------------------------
-- Worker-owned lifecycle transitions (TRUSTED WORKER ONLY)
-- ---------------------------------------------------------------------------

create or replace function public.jobs_complete_job(
  p_job_id   uuid,
  p_result   jsonb default '{}',
  p_ai_metadata jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.atlas_assert_trusted_server();

  update public.atlas_jobs
  set status = 'completed',
      result = p_result,
      ai_metadata = coalesce(p_ai_metadata, ai_metadata),
      completed_at = now(),
      locked_by = null,
      locked_at = null,
      lock_expires_at = null
  where id = p_job_id;

  update public.atlas_job_attempts
  set status = 'completed',
      completed_at = now(),
      duration_ms = extract(epoch from (now() - started_at)) * 1000
  where job_id = p_job_id
    and status = 'running';

  insert into public.atlas_job_events (job_id, event_type, payload, actor)
  values (p_job_id, 'job_completed', jsonb_build_object('result_size', pg_column_size(p_result)), 'system');

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.jobs_fail_job(
  p_job_id   uuid,
  p_error    jsonb,
  p_retryable boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job record;
  v_next_scheduled timestamptz;
begin
  perform public.atlas_assert_trusted_server();

  select * into v_job from public.atlas_jobs where id = p_job_id for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'job_not_found');
  end if;

  update public.atlas_job_attempts
  set status = 'failed',
      completed_at = now(),
      error = p_error,
      duration_ms = extract(epoch from (now() - started_at)) * 1000
  where job_id = p_job_id
    and status = 'running';

  if p_retryable
     and v_job.attempt_count < v_job.max_attempts
  then
    v_next_scheduled := now() + least(
      interval '15 seconds' * power(2, v_job.attempt_count - 1),
      interval '1 hour'
    );

    update public.atlas_jobs
    set status = 'retrying',
        error = p_error,
        scheduled_at = v_next_scheduled,
        locked_by = null,
        locked_at = null,
        lock_expires_at = null
    where id = p_job_id;

    insert into public.atlas_job_events (job_id, event_type, payload, actor)
    values (p_job_id, 'job_retrying', jsonb_build_object(
      'attempt', v_job.attempt_count,
      'max_attempts', v_job.max_attempts,
      'next_scheduled_at', v_next_scheduled,
      'error', p_error
    ), 'system');

    return jsonb_build_object('ok', true, 'retrying', true, 'next_scheduled_at', v_next_scheduled);
  else
    update public.atlas_jobs
    set status = 'failed',
        error = p_error,
        completed_at = now(),
        locked_by = null,
        locked_at = null,
        lock_expires_at = null
    where id = p_job_id;

    insert into public.atlas_job_events (job_id, event_type, payload, actor)
    values (p_job_id, 'job_failed', jsonb_build_object(
      'attempt', v_job.attempt_count,
      'error', p_error
    ), 'system');

    return jsonb_build_object('ok', true, 'retrying', false);
  end if;
end;
$$;

create or replace function public.jobs_complete_step(
  p_step_id  uuid,
  p_output   jsonb default '{}',
  p_ai_metadata jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.atlas_assert_trusted_server();

  update public.atlas_job_steps
  set status = 'completed',
      output = p_output,
      ai_metadata = coalesce(p_ai_metadata, ai_metadata),
      completed_at = now()
  where id = p_step_id;

  insert into public.atlas_job_events (job_id, step_id, event_type, payload, actor)
  select job_id, p_step_id, 'step_completed', jsonb_build_object(
    'step_type', step_type,
    'sequence', sequence
  ), 'system'
  from public.atlas_job_steps where id = p_step_id;

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.jobs_fail_step(
  p_step_id  uuid,
  p_error    jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.atlas_assert_trusted_server();

  update public.atlas_job_steps
  set status = 'failed',
      error = p_error,
      completed_at = now()
  where id = p_step_id;

  insert into public.atlas_job_events (job_id, step_id, event_type, payload, actor)
  select job_id, p_step_id, 'step_failed', jsonb_build_object(
    'step_type', step_type,
    'sequence', sequence,
    'error', p_error
  ), 'system'
  from public.atlas_job_steps where id = p_step_id;

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.jobs_retry_step(
  p_step_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.atlas_assert_trusted_server();

  update public.atlas_job_steps
  set status = 'pending',
      error = null,
      started_at = null,
      completed_at = null
  where id = p_step_id
    and status = 'failed';

  insert into public.atlas_job_events (job_id, step_id, event_type, payload, actor)
  select job_id, p_step_id, 'step_started', jsonb_build_object(
    'step_type', step_type,
    'retry', true
  ), 'system'
  from public.atlas_job_steps where id = p_step_id;

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.jobs_cancel_job(
  p_job_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.atlas_assert_trusted_server();

  update public.atlas_jobs
  set status = 'cancelled',
      completed_at = now(),
      locked_by = null,
      locked_at = null,
      lock_expires_at = null
  where id = p_job_id
    and status not in ('completed', 'cancelled');

  update public.atlas_job_steps
  set status = 'cancelled'
  where job_id = p_job_id
    and status in ('pending', 'processing');

  insert into public.atlas_job_events (job_id, event_type, payload, actor)
  values (p_job_id, 'job_cancelled', '{}', 'system');

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.jobs_unlock_stuck(
  -- Retained for signature compatibility; the reclaim predicate is the lock's
  -- own expiry (lock_expires_at < now()), matching the original behaviour.
  p_stale_after interval default interval '10 minutes'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  perform public.atlas_assert_trusted_server();

  with unlocked as (
    update public.atlas_jobs
    set status = 'retrying',
        locked_by = null,
        locked_at = null,
        lock_expires_at = null,
        scheduled_at = now()
    where status = 'processing'
      and lock_expires_at is not null
      and lock_expires_at < now()
    returning id
  )
  select count(*) into v_count from unlocked;

  insert into public.atlas_job_events (job_id, event_type, payload, actor)
  select u.id, 'job_retrying', jsonb_build_object('reason', 'stuck_job_unlocked'), 'system'
  from public.atlas_jobs u
  where u.locked_by is null
    and u.status = 'retrying'
    and u.updated_at > now() - interval '1 minute';

  return jsonb_build_object('unlocked', v_count);
end;
$$;

create or replace function public.jobs_awaiting_review(
  p_job_id uuid,
  p_review_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job record;
begin
  perform public.atlas_assert_trusted_server();

  select * into v_job from public.atlas_jobs where id = p_job_id for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'job_not_found');
  end if;

  if v_job.status != 'processing' then
    return jsonb_build_object('ok', false, 'error', 'invalid_status', 'current_status', v_job.status);
  end if;

  update public.atlas_jobs
  set status = 'awaiting_review',
      locked_by = null,
      locked_at = null,
      lock_expires_at = null,
      updated_at = now()
  where id = p_job_id;

  update public.atlas_job_attempts
  set status = 'completed',
      completed_at = now(),
      duration_ms = extract(epoch from (now() - started_at)) * 1000
  where job_id = p_job_id
    and status = 'running';

  insert into public.atlas_job_events (job_id, event_type, payload, actor)
  values (p_job_id, 'job_awaiting_review', jsonb_build_object(
    'review_id', p_review_id,
    'reason', 'agent_recommendation_requires_human_review'
  ), 'system');

  return jsonb_build_object('ok', true, 'job_id', p_job_id, 'status', 'awaiting_review');
end;
$$;

-- ---------------------------------------------------------------------------
-- jobs_stats — INTERNAL_ONLY operational aggregate
-- ---------------------------------------------------------------------------
-- Cross-tenant queue depth / failure counts, not a tenant metric. Reachable by
-- internal operators (platform_role super_admin / atlas_admin) and trusted
-- servers only. Ordinary tenant users are refused in-body.
create or replace function public.jobs_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.atlas_is_internal_admin() then
    raise exception 'Access denied: internal operator required' using errcode = '42501';
  end if;

  return (
    SELECT jsonb_build_object(
      'total', count(*),
      'by_status', (
        SELECT jsonb_object_agg(status, cnt)
        FROM (
          SELECT status, count(*) as cnt
          FROM atlas_jobs
          GROUP BY status
        ) s
      ),
      'by_type', (
        SELECT jsonb_object_agg(job_type, cnt)
        FROM (
          SELECT job_type, count(*) as cnt
          FROM atlas_jobs
          GROUP BY job_type
        ) t
      ),
      'avg_duration_ms', (
        SELECT AVG(duration_ms)
        FROM atlas_job_attempts
        WHERE status = 'completed' AND completed_at > now() - interval '24 hours'
      ),
      'queue_depth', (
        SELECT count(*)
        FROM atlas_jobs
        WHERE status IN ('pending', 'queued')
      ),
      'processing_count', (
        SELECT count(*)
        FROM atlas_jobs
        WHERE status = 'processing'
      ),
      'failed_24h', (
        SELECT count(*)
        FROM atlas_jobs
        WHERE status = 'failed'
          AND updated_at > now() - interval '24 hours'
      )
    )
    FROM atlas_jobs
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- 4. PRIVILEGE NORMALIZATION
-- ---------------------------------------------------------------------------
-- Runs LAST so it governs every function defined above and in every earlier
-- migration. Driven off pg_proc so no signature has to be guessed and
-- overloads are all covered.

-- 4a. Tear down the blanket grants. `public` must be revoked explicitly:
--     Postgres grants EXECUTE to PUBLIC on new functions, and `anon`/`authenticated`
--     inherit through it, so revoking from the role alone is not enough.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;

-- 4b. Stop future functions from re-introducing the exposure.
--     NOTE: `alter default privileges` is scoped to the role that executes it.
--     If these defaults were originally created by a different role, the
--     per-function revokes in 4a/4c/4d are still authoritative.
alter default privileges in schema public
  revoke execute on functions from public, anon;
alter default privileges in schema public
  grant execute on functions to service_role, authenticated;

do $$
declare
  -- Privileged operations whose only legitimate caller is a trusted server
  -- process (an Edge Function or the scheduler). No client role may execute
  -- these: they either expose credentials, cross tenant boundaries, mutate
  -- billing state, or administer the platform.
  v_service_only text[] := array[
    -- credentials / cross-tenant
    'email_accounts_get_credentials',
    'outreach_records_update_status',
    -- billing state writers (Paddle webhook / trusted server only)
    'billing_apply_state',
    'tenants_activate_after_payment',
    'tenants_handle_payment_failure',
    'tenants_handle_subscription_cancelled',
    -- corpus / knowledge ingestion
    'industry_ingest_corpus',
    'industry_seed_internal',
    -- platform infrastructure + content engine. These have no authorization
    -- check inside the function and no reachable client caller today
    -- (PlatformOps.tsx is not routed and src/lib/platform is imported by
    -- nothing), so no client role is granted them. Wiring PlatformOps later
    -- must be done together with an in-function admin guard, not by simply
    -- re-granting EXECUTE.
    'schedules_list','schedules_upsert','schedules_set_enabled',
    'schedules_fire_due','schedules_record_result',
    'sources_list_due','sources_get','sources_list_checks',
    'sources_record_check','sources_set_check_frequency',
    'knowledge_versions','knowledge_as_of','knowledge_create_version',
    'knowledge_verify',
    'content_create','content_transition','content_list','content_get',
    'content_list_provenance',
    -- Job queue drain + worker-owned lifecycle transitions. These are driven
    -- exclusively by AtlasWorker (src/lib/jobs/worker.ts) through
    -- createSupabaseWorkerRPC (src/lib/platform/runtime.ts), which is handed a
    -- service-role client. No routed page, component or client helper calls
    -- them, so no client role may execute them. jobs_resume_from_review is the
    -- ONE lifecycle RPC with a genuine browser caller (the Reviews page) and is
    -- therefore tenant-guarded rather than revoked (see 5b-viii).
    'jobs_dequeue',
    'jobs_complete_job','jobs_complete_step',
    'jobs_fail_job','jobs_fail_step','jobs_retry_step',
    'jobs_cancel_job','jobs_unlock_stuck','jobs_awaiting_review',
    -- Auth / tenancy bootstrap internals with no client caller:
    --   handle_new_user  — trigger on auth.users; trigger invocation performs no
    --                      EXECUTE check, so revoking it from client roles is
    --                      safe and closes direct RPC invocation.
    --   ensure_profile   — called internally by tenants_create_tenant().
    --   org_seat_limit   — called internally by org_seat_status().
    'handle_new_user','ensure_profile','org_seat_limit'
  ];
  -- Read-only predicate helpers that RLS policies may evaluate while serving an
  -- anonymous request (policies default to PUBLIC, so `anon` can trigger them).
  -- Without EXECUTE an anonymous query would fail 42501 instead of returning
  -- zero rows. These return booleans / a tenant id only — no data access.
  v_anon_helpers text[] := array[
    'get_current_tenant_id','my_tenant_id',
    'is_super_admin','is_atlas_admin','is_approved_user','can_access_atlas',
    'is_editor','is_manager'
  ];
  -- Genuinely public RPCs.
  v_anon_public text[] := array[
    'pilot_apply',          -- the public /pilot-apply form
    'content_public_list'   -- published blog/articles only
  ];
  r record;
begin
  -- 4c. authenticated: everything except the service-only set.
  for r in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and not (p.proname = any (v_service_only))
  loop
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;

  -- 4d. anon: the explicit allowlist only.
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and p.proname = any (v_anon_helpers || v_anon_public)
  loop
    execute format('grant execute on function %s to anon', r.sig);
  end loop;

  -- 4e. Belt and braces: make the service-only set unambiguously private even
  --     if a later `grant all on all routines` is ever re-applied.
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and p.proname = any (v_service_only)
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;


-- ---------------------------------------------------------------------------
-- 5. Tighten anonymous read on content provenance
-- ---------------------------------------------------------------------------
-- 20260913 declared:
--     create policy contentprovenance_read on public."atlasContentProvenance"
--       for select to anon, authenticated using (true);
-- so an anonymous caller could read provenance edges for UNPUBLISHED content,
-- exposing the knowledge/source ids a draft was built from. The content policy
-- next to it (`contentitems_public_read`) is correctly scoped to published blog
-- content; this aligns provenance with it.
--
-- Published content  -> anon + authenticated (unchanged public behaviour)
-- Approved content   -> authenticated only (same as contentitems_auth_read)
-- everything else    -> no row returned

drop policy if exists contentprovenance_read on public."atlasContentProvenance";
create policy contentprovenance_read on public."atlasContentProvenance"
  for select to anon, authenticated
  using (
    exists (
      select 1
      from public."atlasContentItems" c
      where c."_id" = "contentId"
        and (
          (c."status" = 'published' and c."contentType" = 'blog')
          or (auth.uid() is not null and c."status" in ('approved', 'published'))
        )
    )
  );


-- ---------------------------------------------------------------------------
-- 5b. Tenant scoping for the human-approval RPCs and the job read RPCs
-- ---------------------------------------------------------------------------
-- These functions are SECURITY DEFINER, so the tenant RLS policies on the
-- tables they touch do NOT apply to them. They are also called straight from
-- the browser by signed-in users (src/pages/Reviews.tsx, via
-- src/lib/jobs/review-rpc.ts), and their bodies filtered only by primary key or
-- by a caller-supplied tenant/job id. Result: any authenticated user could read
-- or decide ANOTHER tenant's human review — the human-approval boundary.
--
-- `human_reviews_approve/reject/request_changes` additionally took
-- `p_reviewer_id` as a parameter and wrote it straight to `reviewer_user_id`,
-- so a caller could attribute a decision to an arbitrary user. That identity now
-- comes from the JWT (`auth.uid()`) whenever there is one.
--
-- NOT affected (verified by reading the definitions, not by pattern-matching):
-- the `governance_*` family resolves the caller's tenant through
-- `governance_resolve_tenant()`, which raises unless the caller is a member of
-- the tenant being touched (super_admin may cross tenants).

-- Trusted server caller detection. `service_role` (Edge Functions, scheduler)
-- and a direct superuser connection are trusted; an `anon` key is NOT, even
-- though both have a NULL auth.uid().
create or replace function public.atlas_is_trusted_server()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is null
     and coalesce(auth.role(), 'service_role') <> 'anon'
$$;

-- The tenant ids the calling user is a member of (empty for server callers).
create or replace function public.atlas_caller_tenants()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    array(select m."tenantId" from public.memberships m where m."userId" = auth.uid()),
    '{}'::uuid[]
  )
$$;

-- FAIL-CLOSED: false unless the caller is a trusted server, a member of the
-- tenant, or a super_admin.
create or replace function public.atlas_can_access_tenant(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.atlas_is_trusted_server()
      or (
        auth.uid() is not null
        and (public.is_super_admin() or p_tenant = any (public.atlas_caller_tenants()))
      )
$$;

create or replace function public.atlas_assert_tenant_access(p_tenant uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.atlas_can_access_tenant(p_tenant) then
    raise exception 'Access denied' using errcode = '42501';
  end if;
end;
$$;

-- Trusted background-worker boundary.
-- A trusted server is service_role / a direct superuser connection (no JWT).
-- It is NOT an anon key: atlas_is_trusted_server() rejects auth.role()='anon'
-- even though both have a NULL auth.uid(). This is the explicit authorization
-- boundary for the job queue drain and the worker-owned lifecycle transitions.
create or replace function public.atlas_assert_trusted_server()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.atlas_is_trusted_server() then
    raise exception 'Access denied: trusted server connection required' using errcode = '42501';
  end if;
end;
$$;

-- Internal operator boundary: platform_role super_admin / atlas_admin, or a
-- trusted server. This is the server-side counterpart of RequireInternalAuth
-- (src/components/RequireInternalAuth.tsx → src/lib/auth/access-gate.ts).
create or replace function public.atlas_is_internal_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.atlas_is_trusted_server()
      or (auth.uid() is not null and (public.is_super_admin() or public.is_atlas_admin()))
$$;

create or replace function public.atlas_assert_internal_admin()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.atlas_is_internal_admin() then
    raise exception 'Access denied: internal operator required' using errcode = '42501';
  end if;
end;
$$;

-- 5b-i. human_reviews_get — scope the read to an accessible tenant.
create or replace function public.human_reviews_get(p_review_id uuid)
returns setof public.atlas_human_reviews
language sql
stable
security definer
set search_path = public
as $$
  select *
  from public.atlas_human_reviews r
  where r.id = p_review_id
    and public.atlas_can_access_tenant(r.tenant_id)
$$;

-- 5b-ii. human_reviews_list — the caller-supplied tenant id is now authorised.
create or replace function public.human_reviews_list(
  p_tenant_id uuid,
  p_status text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns setof public.atlas_human_reviews
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.atlas_assert_tenant_access(p_tenant_id);

  return query
    select *
    from public.atlas_human_reviews
    where tenant_id = p_tenant_id
      and (p_status is null or status = p_status)
    order by created_at desc
    limit p_limit offset p_offset;
end;
$$;

-- 5b-iii. human_reviews_list_job — scope through the job's tenant.
create or replace function public.human_reviews_list_job(p_job_id uuid)
returns setof public.atlas_human_reviews
language sql
stable
security definer
set search_path = public
as $$
  select *
  from public.atlas_human_reviews r
  where r.job_id = p_job_id
    and public.atlas_can_access_tenant(r.tenant_id)
  order by r.created_at desc
$$;

-- 5b-iv. human_reviews_count_pending — authorised, and the badge count can no
--        longer be used to probe another tenant.
create or replace function public.human_reviews_count_pending(p_tenant_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.atlas_assert_tenant_access(p_tenant_id);

  return (
    select count(*)::integer
    from public.atlas_human_reviews
    where tenant_id = p_tenant_id and status = 'pending'
  );
end;
$$;

-- 5b-v. human_reviews_create — a caller may only open a review in a tenant it
--       belongs to. Body is otherwise unchanged (idempotency preserved).
create or replace function public.human_reviews_create(
  p_tenant_id uuid,
  p_job_id uuid,
  p_step_id text,
  p_agent_run_id text,
  p_claim_id text,
  p_review_type text,
  p_recommendation_summary text,
  p_recommendation_data jsonb,
  p_financial_impact numeric,
  p_evidence_references jsonb,
  p_ai_confidence numeric,
  p_qa_passed boolean,
  p_qa_score numeric,
  p_qa_issues jsonb,
  p_agent_type text,
  p_model_used text,
  p_token_usage integer,
  p_correlation_id text,
  p_rerun_step text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_existing uuid;
begin
  perform public.atlas_assert_tenant_access(p_tenant_id);

  select id into v_existing
  from public.atlas_human_reviews
  where job_id = p_job_id
    and step_id is not distinct from p_step_id
    and agent_type = p_agent_type
    and status in ('pending', 'needs_changes');

  if v_existing is not null then
    return v_existing;
  end if;

  insert into public.atlas_human_reviews (
    tenant_id, job_id, step_id, agent_run_id, claim_id,
    review_type, recommendation_summary, recommendation_data,
    financial_impact, evidence_references, ai_confidence,
    qa_passed, qa_score, qa_issues,
    agent_type, model_used, token_usage,
    status, correlation_id, rerun_step
  ) values (
    p_tenant_id, p_job_id, p_step_id, p_agent_run_id, p_claim_id,
    p_review_type, p_recommendation_summary, p_recommendation_data,
    p_financial_impact, p_evidence_references, p_ai_confidence,
    p_qa_passed, p_qa_score, p_qa_issues,
    p_agent_type, p_model_used, p_token_usage,
    'pending', p_correlation_id, p_rerun_step
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- 5b-vi. Decision RPCs — tenant-authorised, and the reviewer identity is taken
--        from the JWT instead of the caller-supplied parameter.
create or replace function public.human_reviews_approve(
  p_review_id uuid,
  p_reviewer_id uuid,
  p_notes text default 'Approved'
)
returns public.atlas_human_reviews
language plpgsql
security definer
set search_path = public
as $$
declare
  v_review public.atlas_human_reviews;
  v_tenant uuid;
begin
  select r.tenant_id into v_tenant
  from public.atlas_human_reviews r
  where r.id = p_review_id;

  if v_tenant is not null then
    perform public.atlas_assert_tenant_access(v_tenant);
  end if;

  update public.atlas_human_reviews
  set status = 'approved',
      reviewer_user_id = coalesce(auth.uid(), p_reviewer_id),
      reviewer_notes = p_notes,
      decided_at = now(),
      resolved_at = now(),
      updated_at = now()
  where id = p_review_id
    and status = 'pending'
  returning * into v_review;

  if v_review is null then
    raise exception 'Review not found or not in pending status';
  end if;

  return v_review;
end;
$$;

create or replace function public.human_reviews_reject(
  p_review_id uuid,
  p_reviewer_id uuid,
  p_notes text
)
returns public.atlas_human_reviews
language plpgsql
security definer
set search_path = public
as $$
declare
  v_review public.atlas_human_reviews;
  v_tenant uuid;
begin
  select r.tenant_id into v_tenant
  from public.atlas_human_reviews r
  where r.id = p_review_id;

  if v_tenant is not null then
    perform public.atlas_assert_tenant_access(v_tenant);
  end if;

  update public.atlas_human_reviews
  set status = 'rejected',
      reviewer_user_id = coalesce(auth.uid(), p_reviewer_id),
      reviewer_notes = p_notes,
      decided_at = now(),
      resolved_at = now(),
      updated_at = now()
  where id = p_review_id
    and status = 'pending'
  returning * into v_review;

  if v_review is null then
    raise exception 'Review not found or not in pending status';
  end if;

  return v_review;
end;
$$;

create or replace function public.human_reviews_request_changes(
  p_review_id uuid,
  p_reviewer_id uuid,
  p_notes text,
  p_rerun_step text default null
)
returns public.atlas_human_reviews
language plpgsql
security definer
set search_path = public
as $$
declare
  v_review public.atlas_human_reviews;
  v_tenant uuid;
begin
  select r.tenant_id into v_tenant
  from public.atlas_human_reviews r
  where r.id = p_review_id;

  if v_tenant is not null then
    perform public.atlas_assert_tenant_access(v_tenant);
  end if;

  update public.atlas_human_reviews
  set status = 'needs_changes',
      reviewer_user_id = coalesce(auth.uid(), p_reviewer_id),
      reviewer_notes = p_notes,
      decided_at = now(),
      rerun_step = coalesce(p_rerun_step, rerun_step),
      updated_at = now()
  where id = p_review_id
    and status in ('pending', 'needs_changes')
  returning * into v_review;

  if v_review is null then
    raise exception 'Review not found or not in reviewable status';
  end if;

  return v_review;
end;
$$;

-- 5b-vii. Job read RPCs — `atlas_jobs` is tenant-owned, so a signed-in caller
--         sees only its own tenant's jobs. Server callers (the Edge Function
--         that drives AtlasWorker.runOnce) are unaffected; super_admin may
--         still cross tenants.
create or replace function public.jobs_list_jobs(
  p_status text default null,
  p_job_type text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return (
    select jsonb_agg(to_jsonb(t.*) order by t.created_at desc)
    from (
      select *
      from public.atlas_jobs j
      where (p_status is null or j.status = p_status)
        and (p_job_type is null or j.job_type = p_job_type)
        and public.atlas_can_access_tenant(j.tenant_id)
      order by j.created_at desc
      limit p_limit
      offset p_offset
    ) t
  );
end;
$$;

create or replace function public.jobs_get_events(
  p_job_id uuid,
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return (
    select jsonb_agg(to_jsonb(e.*) order by e.created_at asc)
    from (
      select e.*
      from public.atlas_job_events e
      join public.atlas_jobs j on j.id = e.job_id
      where e.job_id = p_job_id
        and public.atlas_can_access_tenant(j.tenant_id)
      order by e.created_at asc
      limit p_limit
    ) e
  );
end;
$$;

-- 5b-viii. jobs_resume_from_review — reachable from the routed Reviews page
--          (src/lib/jobs/rpc.ts -> src/pages/Reviews.tsx). It resumes or
--          cancels a job by id with no tenant check, so any signed-in user
--          could re-queue or cancel another tenant's job. Behaviour is
--          unchanged; the only addition is the authorization assert.
create or replace function public.jobs_resume_from_review(
  p_job_id uuid,
  p_review_id uuid,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job record;
  v_review record;
begin
  select * into v_job from public.atlas_jobs where id = p_job_id for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'job_not_found');
  end if;

  -- Tenant authorization: the job is tenant-owned.
  perform public.atlas_assert_tenant_access(v_job.tenant_id);

  if v_job.status != 'awaiting_review' then
    return jsonb_build_object('ok', false, 'error', 'invalid_status', 'current_status', v_job.status);
  end if;

  select * into v_review from public.atlas_human_reviews
  where id = p_review_id and job_id = p_job_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'review_not_found');
  end if;

  if p_decision = 'approved' then
    update public.atlas_jobs
    set status = 'pending',
        locked_by = null,
        locked_at = null,
        lock_expires_at = null,
        scheduled_at = now(),
        updated_at = now()
    where id = p_job_id;

    insert into public.atlas_job_events (job_id, event_type, payload, actor)
    values (p_job_id, 'job_queued', jsonb_build_object(
      'review_id', p_review_id,
      'decision', 'approved',
      'resumed_from', 'awaiting_review'
    ), 'system');

    return jsonb_build_object('ok', true, 'job_id', p_job_id, 'status', 'pending');

  elsif p_decision = 'rejected' then
    update public.atlas_jobs
    set status = 'cancelled',
        completed_at = now(),
        locked_by = null,
        locked_at = null,
        lock_expires_at = null,
        updated_at = now(),
        error = jsonb_build_object(
          'code', 'HUMAN_REVIEW_REJECTED',
          'message', 'Human reviewer rejected the recommendation',
          'review_id', p_review_id
        )
    where id = p_job_id;

    insert into public.atlas_job_events (job_id, event_type, payload, actor)
    values (p_job_id, 'job_cancelled', jsonb_build_object(
      'review_id', p_review_id,
      'decision', 'rejected'
    ), 'system');

    return jsonb_build_object('ok', true, 'job_id', p_job_id, 'status', 'cancelled');

  elsif p_decision = 'needs_changes' then
    update public.atlas_jobs
    set status = 'pending',
        locked_by = null,
        locked_at = null,
        lock_expires_at = null,
        scheduled_at = now(),
        updated_at = now()
    where id = p_job_id;

    if v_review.rerun_step is not null then
      update public.atlas_job_steps
      set status = 'pending',
          error = null,
          started_at = null,
          completed_at = null,
          output = null
      where job_id = p_job_id
        and step_type = v_review.rerun_step;
    end if;

    insert into public.atlas_job_events (job_id, event_type, payload, actor)
    values (p_job_id, 'job_queued', jsonb_build_object(
      'review_id', p_review_id,
      'decision', 'needs_changes',
      'rerun_step', v_review.rerun_step
    ), 'system');

    return jsonb_build_object('ok', true, 'job_id', p_job_id, 'status', 'pending', 'rerun_step', v_review.rerun_step);

  else
    return jsonb_build_object('ok', false, 'error', 'invalid_decision', 'decision', p_decision);
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- 6. Audit the hardening
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'log_audit'
  ) then
    perform public.log_audit(
      'security_hardening',
      'migration',
      '20260918_atlas_security_hardening',
      jsonb_build_object(
        'blanket_grant_removed', jsonb_build_array('public', 'anon'),
        'service_role_only', jsonb_build_array(
          'email_accounts_get_credentials', 'outreach_records_update_status',
          'billing_apply_state', 'tenants_activate_after_payment',
          'tenants_handle_payment_failure', 'tenants_handle_subscription_cancelled',
          'industry_ingest_corpus', 'industry_seed_internal',
          'jobs_dequeue', 'jobs_complete_job', 'jobs_complete_step',
          'jobs_fail_job', 'jobs_fail_step', 'jobs_retry_step',
          'jobs_cancel_job', 'jobs_unlock_stuck', 'jobs_awaiting_review',
          'handle_new_user', 'ensure_profile', 'org_seat_limit'
        ),
        'job_boundary', jsonb_build_object(
          'tenant_guarded', jsonb_build_array(
            'jobs_create_job', 'jobs_create_step', 'jobs_get_job'
          ),
          'internal_only', jsonb_build_array('jobs_stats'),
          'worker_only', jsonb_build_array(
            'jobs_dequeue', 'jobs_complete_job', 'jobs_complete_step',
            'jobs_fail_job', 'jobs_fail_step', 'jobs_retry_step',
            'jobs_cancel_job', 'jobs_unlock_stuck', 'jobs_awaiting_review'
          ),
          'helpers', jsonb_build_array(
            'atlas_assert_trusted_server', 'atlas_is_internal_admin',
            'atlas_assert_internal_admin'
          )
        ),
        'provenance_anon_read', 'restricted to published/approved content',
        'tenant_scoped', jsonb_build_array(
          'human_reviews_get', 'human_reviews_list', 'human_reviews_list_job',
          'human_reviews_count_pending', 'human_reviews_create',
          'human_reviews_approve', 'human_reviews_reject',
          'human_reviews_request_changes', 'jobs_list_jobs', 'jobs_get_events',
          'jobs_resume_from_review'
        ),
        'added', jsonb_build_array(
          'org_seat_limit', 'org_seat_status', 'plan_seat_limits',
          'atlas_is_trusted_server', 'atlas_caller_tenants',
          'atlas_can_access_tenant', 'atlas_assert_tenant_access'
        )
      )
    );
  end if;
end $$;
