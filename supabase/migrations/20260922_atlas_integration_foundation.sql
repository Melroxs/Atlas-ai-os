-- ===========================================================================
-- Atlas — Integration Platform Foundation (MASTER #1)
--
-- WHAT ALREADY EXISTED (reused, not replaced)
--   * public.connections          — organization↔provider connection records
--   * public.connectiontokens     — provider credentials
--   * public.documents            — provenance columns (sourceType/sourceId/…)
--   * public.atlas_jobs/_steps    — the durable queue (work items)
--   * public.processed_webhook_events — the billing idempotency ledger pattern
--   * public.atlas_audit_log      — audit trail
--   * jobs_* RPCs, get_current_tenant_id(), is_atlas_admin(), my_tenant_id()
--
-- WHAT THIS MIGRATION ADDS (only what was genuinely missing)
--   * integration_events          — durable, idempotent provider event log
--   * integration_sync_state      — per-resource cursors / retry state
--   * integration_external_refs   — external id → Atlas record mapping
--   * integration_oauth_states    — single-use, time-limited OAuth state
--   * integration_provider_settings — which providers are SERVER-configured
--   * guarded RPCs used by the edge functions and the Connections UI
--
-- SECURITY FIXES (verified against the live database before writing this)
--   1. public.connections was table-granted ALL to anon + authenticated with a
--      permissive RLS policy `connections_all` (USING "tenantId" = my_tenant_id()).
--      That let any tenant member INSERT/UPDATE/DELETE their own connection rows
--      from the browser, and `connections.settings` is documented as carrying
--      OAuth tokens / pending state. A client could therefore forge a "connected"
--      connector and (once a connector wrote state) read secrets through the
--      table. Client DML is revoked here; the UI reads a sanitized projection
--      through connections_list_catalog().
--   2. public.connectiontokens held access/refresh tokens as PLAINTEXT `text`
--      and was table-granted to anon + authenticated (RLS did deny reads via
--      `connectiontokens_none`, so no live leak — but the grants were one bad
--      policy away from exposing real tokens). It is now server-only, and
--      credentials are stored AES-256-GCM sealed in *_enc columns. The legacy
--      plaintext columns are kept (no data destroyed) but are never written.
--   3. public.connections_raw() (SECURITY INVOKER, granted to PUBLIC/anon/
--      authenticated) returned `to_jsonb(c)` — i.e. the whole row including
--      `settings` — to any signed-in member. It has no callers in the app; its
--      EXECUTE grant is revoked from client roles here.
--
-- NOTHING is dropped, recreated or backfilled destructively. No existing row is
-- rewritten; only grants/policies are tightened and new objects are added.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Harden public.connections
-- ---------------------------------------------------------------------------

alter table public.connections
  add column if not exists "connectionType" text,
  add column if not exists capabilities jsonb not null default '[]'::jsonb,
  add column if not exists "externalAccountId" text,
  add column if not exists "lastAttemptedSyncAt" bigint,
  add column if not exists "disconnectedAt" bigint,
  add column if not exists "credentialKeyVersion" integer;

do $$ begin
  alter table public.connections
    add constraint connections_status_check
    check (status in ('connected', 'syncing', 'error', 'degraded', 'disconnected', 'pending'));
exception when duplicate_object then null;
end $$;

create index if not exists connections_tenant_provider_idx
  on public.connections ("tenantId", provider);

-- Client DML/DDL removed. The UI reads the sanitized projection below; the edge
-- functions write through the guarded RPCs.
drop policy if exists connections_all on public.connections;
drop policy if exists connections_select on public.connections;
revoke all on table public.connections from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Harden public.connectiontokens (server-only, sealed credentials)
-- ---------------------------------------------------------------------------

alter table public.connectiontokens
  add column if not exists access_token_enc text,
  add column if not exists refresh_token_enc text,
  add column if not exists token_key_version integer,
  add column if not exists "lastRefreshedAt" bigint,
  add column if not exists "revokedAt" bigint;

create index if not exists connectiontokens_connection_idx
  on public.connectiontokens ("connectionId");

drop policy if exists connectiontokens_none on public.connectiontokens;
revoke all on table public.connectiontokens from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. integration_events — durable, idempotent provider event log
-- ---------------------------------------------------------------------------

create table if not exists public.integration_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.tenants (_id) on delete cascade,
  provider text not null,
  connection_id uuid references public.connections (_id) on delete set null,
  -- Provider-side identity of the event; the unique constraint below is what
  -- makes repeated delivery (and provider retries) a no-op.
  external_event_id text not null,
  event_type text not null,
  -- Normalized event (never the raw provider body: payloads can carry the
  -- customer's message content and must not be duplicated into a second store).
  payload jsonb not null default '{}'::jsonb,
  payload_sha256 text,
  signature_verified boolean not null default false,
  processing_status text not null default 'pending'
    check (processing_status in ('pending', 'processing', 'processed', 'ignored', 'failed')),
  attempt_count integer not null default 0,
  job_id uuid,
  received_at bigint not null,
  processed_at bigint,
  last_error text,
  error_class text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists integration_events_dedupe_idx
  on public.integration_events (provider, external_event_id);
create index if not exists integration_events_org_idx
  on public.integration_events (organization_id, received_at desc);
create index if not exists integration_events_status_idx
  on public.integration_events (processing_status, received_at desc);

alter table public.integration_events enable row level security;
revoke all on table public.integration_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. integration_sync_state — cursors, retry state, resumability
-- ---------------------------------------------------------------------------

create table if not exists public.integration_sync_state (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.tenants (_id) on delete cascade,
  connection_id uuid not null references public.connections (_id) on delete cascade,
  provider text not null,
  resource_type text not null,
  cursor text,
  last_synced_at bigint,
  last_attempted_at bigint,
  last_full_sync_at bigint,
  status text not null default 'idle'
    check (status in ('idle', 'running', 'ok', 'error', 'rate_limited', 'backoff')),
  items_synced bigint not null default 0,
  consecutive_failures integer not null default 0,
  next_attempt_at bigint,
  last_error text,
  error_class text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists integration_sync_state_key_idx
  on public.integration_sync_state (connection_id, resource_type);
create index if not exists integration_sync_state_due_idx
  on public.integration_sync_state (status, next_attempt_at);

alter table public.integration_sync_state enable row level security;
revoke all on table public.integration_sync_state from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. integration_external_refs — external identity → Atlas record + provenance
-- ---------------------------------------------------------------------------

create table if not exists public.integration_external_refs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.tenants (_id) on delete cascade,
  provider text not null,
  connection_id uuid references public.connections (_id) on delete set null,
  -- Provider object family, e.g. 'message', 'job', 'estimate', 'photo'.
  resource_type text not null,
  external_id text not null,
  external_parent_id text,
  -- Canonical Atlas object this maps to. `atlas_table` is a logical object name
  -- ('document', 'customer', 'claim', …) owned by the integration layer, not a
  -- foreign key: an external record may legitimately outlive an Atlas row.
  atlas_object text not null,
  atlas_id uuid,
  external_created_at bigint,
  external_updated_at bigint,
  external_deleted_at bigint,
  provenance jsonb not null default '{}'::jsonb,
  first_seen_at bigint not null,
  last_seen_at bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists integration_external_refs_key_idx
  on public.integration_external_refs (organization_id, provider, resource_type, external_id);
create index if not exists integration_external_refs_atlas_idx
  on public.integration_external_refs (organization_id, atlas_object, atlas_id);

alter table public.integration_external_refs enable row level security;
revoke all on table public.integration_external_refs from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. integration_oauth_states — single-use, time-limited, tenant-bound state
-- ---------------------------------------------------------------------------

create table if not exists public.integration_oauth_states (
  -- SHA-256 of the opaque state value. The raw value exists only in the browser
  -- redirect; a database leak therefore cannot be replayed against the provider.
  state_hash text primary key,
  organization_id uuid not null references public.tenants (_id) on delete cascade,
  user_id uuid not null,
  provider text not null,
  redirect_uri text not null,
  return_to text,
  code_verifier text,
  scopes jsonb not null default '[]'::jsonb,
  created_at bigint not null,
  expires_at bigint not null,
  consumed_at bigint
);

create index if not exists integration_oauth_states_expiry_idx
  on public.integration_oauth_states (expires_at);

alter table public.integration_oauth_states enable row level security;
revoke all on table public.integration_oauth_states from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. integration_provider_settings — server-side configuration visibility
--
-- The UI must be able to say "this provider is not configured" without ever
-- seeing a secret. Only the boolean + the NAMES of missing variables are stored;
-- the edge function refreshes this from its own environment.
-- ---------------------------------------------------------------------------

create table if not exists public.integration_provider_settings (
  provider text primary key,
  configured boolean not null default false,
  missing_env_vars text[] not null default '{}',
  checked_at bigint,
  notes text
);

alter table public.integration_provider_settings enable row level security;
revoke all on table public.integration_provider_settings from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Guards
--
-- Every function below authorizes its own caller: service-only functions refuse
-- any real user session, and tenant functions resolve the organization from the
-- CALLER'S OWN membership (never from a client-supplied tenant id).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 8a. connections_list_catalog — sanitized catalog for the Connections UI.
--
-- This RPC did not exist, which is why /dashboard/connections rendered an empty
-- catalog. It returns ONLY non-sensitive columns: credentials live in
-- connectiontokens and `settings` never leaves the server.
-- ---------------------------------------------------------------------------

create or replace function public.connections_list_catalog()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.get_current_tenant_id();
begin
  if v_tenant is null then
    raise exception 'Access denied: no active Atlas organization' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'connections', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          '_id', c._id,
          'name', c.name,
          'provider', c.provider,
          'category', c.category,
          'status', c.status,
          'connectionType', c."connectionType",
          'capabilities', c.capabilities,
          'accountName', c."accountName",
          'accountEmail', c."accountEmail",
          'externalAccountId', c."externalAccountId",
          'scopes', c.scopes,
          'lastSyncAt', c."lastSyncAt",
          'lastAttemptedSyncAt', c."lastAttemptedSyncAt",
          'lastError', c.lastError,
          'healthStatus', c."healthStatus",
          'lastTestedAt', c."lastTestedAt",
          'lastTestSuccessAt', c."lastTestSuccessAt",
          'lastTestFailureAt', c."lastTestFailureAt",
          'lastTestLatencyMs', c."lastTestLatencyMs",
          'disconnectedAt', c."disconnectedAt"
        )
        order by c._creationTime
      )
      from public.connections c
      where c."tenantId" = v_tenant
        and c."disconnectedAt" is null
    ), '[]'::jsonb),
    'providers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider', s.provider,
        'configured', s.configured,
        'missingEnvVars', to_jsonb(s.missing_env_vars),
        'checkedAt', s.checked_at
      ))
      from public.integration_provider_settings s
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.connections_list_catalog() from public, anon;
grant execute on function public.connections_list_catalog() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8b. connections_register — server-side connection upsert (OAuth callback).
-- ---------------------------------------------------------------------------

create or replace function public.connections_register(
  p_organization_id uuid,
  p_provider text,
  p_name text default null,
  p_category text default 'other',
  p_connection_type text default null,
  p_account_name text default null,
  p_account_email text default null,
  p_external_account_id text default null,
  p_scopes jsonb default '[]'::jsonb,
  p_capabilities jsonb default '[]'::jsonb,
  p_access_token_enc text default null,
  p_refresh_token_enc text default null,
  p_token_expires_at bigint default null,
  p_token_key_version integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection_id uuid;
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  if auth.uid() is not null or coalesce(auth.role(), 'service_role') = 'anon' then
    raise exception 'Access denied: trusted server connection required' using errcode = '42501';
  end if;
  if p_organization_id is null or p_provider is null then
    raise exception 'organization and provider are required' using errcode = '22004';
  end if;

  select c._id into v_connection_id
  from public.connections c
  where c."tenantId" = p_organization_id
    and c.provider = p_provider
    and c."disconnectedAt" is null
  limit 1;

  if v_connection_id is null then
    insert into public.connections (
      "tenantId", name, provider, category, status, "connectionType",
      "accountName", "accountEmail", "externalAccountId",
      scopes, capabilities, "healthStatus", settings, "disconnectedAt"
    ) values (
      p_organization_id,
      coalesce(p_name, p_provider),
      p_provider,
      coalesce(p_category, 'other'),
      'connected',
      p_connection_type,
      p_account_name,
      p_account_email,
      p_external_account_id,
      coalesce(p_scopes, '[]'::jsonb),
      coalesce(p_capabilities, '[]'::jsonb),
      'untested',
      '{}'::jsonb,
      null
    )
    returning _id into v_connection_id;
  else
    update public.connections set
      status = 'connected',
      "connectionType" = coalesce(p_connection_type, "connectionType"),
      "accountName" = coalesce(p_account_name, "accountName"),
      "accountEmail" = coalesce(p_account_email, "accountEmail"),
      "externalAccountId" = coalesce(p_external_account_id, "externalAccountId"),
      scopes = coalesce(p_scopes, scopes),
      capabilities = coalesce(p_capabilities, capabilities),
      "disconnectedAt" = null,
      "lastError" = null
    where _id = v_connection_id;
  end if;

  if p_access_token_enc is not null or p_refresh_token_enc is not null then
    delete from public.connectiontokens where "connectionId" = v_connection_id;
    insert into public.connectiontokens (
      "tenantId", provider, "connectionId",
      access_token_enc, refresh_token_enc, "tokenExpiresAt",
      token_key_version, "accountEmail", "accountName", scopes,
      "lastRefreshedAt"
    ) values (
      p_organization_id, p_provider, v_connection_id,
      p_access_token_enc, p_refresh_token_enc, p_token_expires_at,
      coalesce(p_token_key_version, 1), p_account_email, p_account_name,
      coalesce(p_scopes, '[]'::jsonb),
      v_now
    );
  end if;

  insert into public.atlas_audit_log (action, target_type, target_id, details)
  values (
    'integration.connected', 'connection', v_connection_id,
    jsonb_build_object('provider', p_provider, 'organization_id', p_organization_id)
  );

  return jsonb_build_object('ok', true, 'connection_id', v_connection_id);
end;
$$;

revoke execute on function public.connections_register(uuid, text, text, text, text, text, text, text, jsonb, jsonb, text, text, bigint, integer) from public, anon, authenticated;
grant execute on function public.connections_register(uuid, text, text, text, text, text, text, text, jsonb, jsonb, text, text, bigint, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 8c. connections_set_status — server-side status/health write.
-- ---------------------------------------------------------------------------

create or replace function public.connections_set_status(
  p_connection_id uuid,
  p_status text default null,
  p_health_status text default null,
  p_error text default null,
  p_last_sync_at bigint default null,
  p_last_attempted_sync_at bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null or coalesce(auth.role(), 'service_role') = 'anon' then
    raise exception 'Access denied: trusted server connection required' using errcode = '42501';
  end if;

  update public.connections set
    status = coalesce(p_status, status),
    "healthStatus" = coalesce(p_health_status, "healthStatus"),
    "lastError" = p_error,
    "lastSyncAt" = coalesce(p_last_sync_at, "lastSyncAt"),
    "lastAttemptedSyncAt" = coalesce(p_last_attempted_sync_at, "lastAttemptedSyncAt")
  where _id = p_connection_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.connections_set_status(uuid, text, text, text, bigint, bigint) from public, anon, authenticated;
grant execute on function public.connections_set_status(uuid, text, text, text, bigint, bigint) to service_role;

-- ---------------------------------------------------------------------------
-- 8d. connections_disconnect — organization manager only.
-- ---------------------------------------------------------------------------

create or replace function public.connections_disconnect(p_connection_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.get_current_tenant_id();
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
  v_provider text;
begin
  if v_tenant is null then
    raise exception 'Access denied: no active Atlas organization' using errcode = '42501';
  end if;
  if not (
    public.is_atlas_admin()
    or exists (
      select 1 from public.memberships m
      where m."tenantId" = v_tenant
        and m."userId" = auth.uid()
        and m.status = 'active'
        and m.role in ('owner', 'admin', 'manager')
    )
  ) then
    raise exception 'Access denied: organization manager role required' using errcode = '42501';
  end if;

  -- The tenant predicate is what stops a member of organization A from
  -- disconnecting a connection that belongs to organization B.
  update public.connections
  set status = 'disconnected', "disconnectedAt" = v_now
  where _id = p_connection_id and "tenantId" = v_tenant
  returning provider into v_provider;

  if v_provider is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  delete from public.connectiontokens where "connectionId" = p_connection_id;
  delete from public.integration_sync_state where connection_id = p_connection_id;

  insert into public.atlas_audit_log (actor_id, action, target_type, target_id, details)
  values (
    auth.uid(), 'integration.disconnected', 'connection', p_connection_id,
    jsonb_build_object('provider', v_provider)
  );

  return jsonb_build_object('ok', true, 'provider', v_provider);
end;
$$;

revoke execute on function public.connections_disconnect(uuid) from public, anon;
grant execute on function public.connections_disconnect(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8e. OAuth state — create / consume (server only).
-- ---------------------------------------------------------------------------

create or replace function public.integration_oauth_state_create(
  p_state_hash text,
  p_organization_id uuid,
  p_user_id uuid,
  p_provider text,
  p_redirect_uri text,
  p_return_to text default null,
  p_code_verifier text default null,
  p_scopes jsonb default '[]'::jsonb,
  p_ttl_ms bigint default 600000
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  if auth.uid() is not null or coalesce(auth.role(), 'service_role') = 'anon' then
    raise exception 'Access denied: trusted server connection required' using errcode = '42501';
  end if;

  -- Opportunistic cleanup: expired states can never be replayed anyway, and this
  -- keeps the table bounded without a scheduler.
  delete from public.integration_oauth_states where expires_at < v_now;

  insert into public.integration_oauth_states (
    state_hash, organization_id, user_id, provider, redirect_uri,
    return_to, code_verifier, scopes, created_at, expires_at
  ) values (
    p_state_hash, p_organization_id, p_user_id, p_provider, p_redirect_uri,
    p_return_to, p_code_verifier, coalesce(p_scopes, '[]'::jsonb), v_now,
    v_now + coalesce(p_ttl_ms, 600000)
  );

  return jsonb_build_object('ok', true, 'expires_at', v_now + coalesce(p_ttl_ms, 600000));
end;
$$;

revoke execute on function public.integration_oauth_state_create(text, uuid, uuid, text, text, text, text, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.integration_oauth_state_create(text, uuid, uuid, text, text, text, text, jsonb, bigint) to service_role;

create or replace function public.integration_oauth_state_consume(
  p_state_hash text,
  p_provider text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state public.integration_oauth_states;
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  if auth.uid() is not null or coalesce(auth.role(), 'service_role') = 'anon' then
    raise exception 'Access denied: trusted server connection required' using errcode = '42501';
  end if;

  -- Single use: the row is locked, validated and marked consumed in one
  -- statement, so two concurrent callbacks cannot both exchange the same code.
  select * into v_state
  from public.integration_oauth_states
  where state_hash = p_state_hash
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_state');
  end if;
  if v_state.consumed_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'replayed_state');
  end if;
  if v_state.expires_at < v_now then
    return jsonb_build_object('ok', false, 'reason', 'expired_state');
  end if;
  if p_provider is not null and v_state.provider <> p_provider then
    return jsonb_build_object('ok', false, 'reason', 'provider_mismatch');
  end if;

  update public.integration_oauth_states
  set consumed_at = v_now
  where state_hash = p_state_hash;

  return jsonb_build_object(
    'ok', true,
    'organization_id', v_state.organization_id,
    'user_id', v_state.user_id,
    'provider', v_state.provider,
    'redirect_uri', v_state.redirect_uri,
    'return_to', v_state.return_to,
    'code_verifier', v_state.code_verifier,
    'scopes', v_state.scopes
  );
end;
$$;

revoke execute on function public.integration_oauth_state_consume(text, text) from public, anon, authenticated;
grant execute on function public.integration_oauth_state_consume(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 8f. integration_event_ingest — idempotent event intake (server only).
--
-- Duplicate delivery returns the SAME event id with duplicate=true and creates
-- nothing new, which is what makes the webhook path replay-safe.
-- ---------------------------------------------------------------------------

create or replace function public.integration_event_ingest(
  p_organization_id uuid,
  p_provider text,
  p_external_event_id text,
  p_event_type text,
  p_payload jsonb default '{}'::jsonb,
  p_payload_sha256 text default null,
  p_connection_id uuid default null,
  p_signature_verified boolean default false,
  p_received_at bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.integration_events;
  v_id uuid;
  v_now bigint := coalesce(p_received_at, (extract(epoch from now()) * 1000)::bigint);
begin
  if auth.uid() is not null or coalesce(auth.role(), 'service_role') = 'anon' then
    raise exception 'Access denied: trusted server connection required' using errcode = '42501';
  end if;
  if p_provider is null or p_external_event_id is null or p_event_type is null then
    raise exception 'provider, external_event_id and event_type are required' using errcode = '22004';
  end if;

  select * into v_existing
  from public.integration_events
  where provider = p_provider and external_event_id = p_external_event_id;

  if found then
    return jsonb_build_object(
      'ok', true, 'duplicate', true, 'event_id', v_existing.id,
      'processing_status', v_existing.processing_status,
      'job_id', v_existing.job_id
    );
  end if;

  insert into public.integration_events (
    organization_id, provider, connection_id, external_event_id, event_type,
    payload, payload_sha256, signature_verified, received_at
  ) values (
    p_organization_id, p_provider, p_connection_id, p_external_event_id, p_event_type,
    coalesce(p_payload, '{}'::jsonb), p_payload_sha256, coalesce(p_signature_verified, false), v_now
  )
  -- Belt and braces against a race between two concurrent deliveries.
  on conflict (provider, external_event_id) do nothing
  returning id into v_id;

  if v_id is null then
    select * into v_existing
    from public.integration_events
    where provider = p_provider and external_event_id = p_external_event_id;
    return jsonb_build_object(
      'ok', true, 'duplicate', true, 'event_id', v_existing.id,
      'processing_status', v_existing.processing_status, 'job_id', v_existing.job_id
    );
  end if;

  return jsonb_build_object('ok', true, 'duplicate', false, 'event_id', v_id);
end;
$$;

revoke execute on function public.integration_event_ingest(uuid, text, text, text, jsonb, text, uuid, boolean, bigint) from public, anon, authenticated;
grant execute on function public.integration_event_ingest(uuid, text, text, text, jsonb, text, uuid, boolean, bigint) to service_role;

create or replace function public.integration_event_finish(
  p_event_id uuid,
  p_status text,
  p_job_id uuid default null,
  p_error text default null,
  p_error_class text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  if auth.uid() is not null or coalesce(auth.role(), 'service_role') = 'anon' then
    raise exception 'Access denied: trusted server connection required' using errcode = '42501';
  end if;
  if p_status not in ('pending', 'processing', 'processed', 'ignored', 'failed') then
    raise exception 'invalid processing status' using errcode = '22023';
  end if;

  update public.integration_events set
    processing_status = p_status,
    job_id = coalesce(p_job_id, job_id),
    attempt_count = attempt_count + 1,
    last_error = p_error,
    error_class = p_error_class,
    processed_at = case when p_status in ('processed', 'ignored', 'failed') then v_now else processed_at end,
    updated_at = now()
  where id = p_event_id;

  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.integration_event_finish(uuid, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.integration_event_finish(uuid, text, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 8g. External identity mapping (server only, idempotent).
-- ---------------------------------------------------------------------------

create or replace function public.integration_external_ref_upsert(
  p_organization_id uuid,
  p_provider text,
  p_resource_type text,
  p_external_id text,
  p_atlas_object text,
  p_atlas_id uuid default null,
  p_connection_id uuid default null,
  p_external_parent_id text default null,
  p_external_created_at bigint default null,
  p_external_updated_at bigint default null,
  p_provenance jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
  v_created boolean := false;
begin
  if auth.uid() is not null or coalesce(auth.role(), 'service_role') = 'anon' then
    raise exception 'Access denied: trusted server connection required' using errcode = '42501';
  end if;
  if p_organization_id is null or p_provider is null or p_resource_type is null
     or p_external_id is null or p_atlas_object is null then
    raise exception 'organization, provider, resource_type, external_id and atlas_object are required'
      using errcode = '22004';
  end if;

  select id into v_id
  from public.integration_external_refs
  where organization_id = p_organization_id
    and provider = p_provider
    and resource_type = p_resource_type
    and external_id = p_external_id;

  if v_id is null then
    insert into public.integration_external_refs (
      organization_id, provider, connection_id, resource_type, external_id,
      external_parent_id, atlas_object, atlas_id, external_created_at,
      external_updated_at, provenance, first_seen_at, last_seen_at
    ) values (
      p_organization_id, p_provider, p_connection_id, p_resource_type, p_external_id,
      p_external_parent_id, p_atlas_object, p_atlas_id, p_external_created_at,
      p_external_updated_at, coalesce(p_provenance, '{}'::jsonb), v_now, v_now
    )
    on conflict (organization_id, provider, resource_type, external_id) do nothing
    returning id into v_id;
    v_created := v_id is not null;
  end if;

  if v_id is null then
    select id into v_id
    from public.integration_external_refs
    where organization_id = p_organization_id and provider = p_provider
      and resource_type = p_resource_type and external_id = p_external_id;
    v_created := false;
  end if;

  if not v_created then
    update public.integration_external_refs set
      atlas_id = coalesce(p_atlas_id, atlas_id),
      atlas_object = p_atlas_object,
      connection_id = coalesce(p_connection_id, connection_id),
      external_parent_id = coalesce(p_external_parent_id, external_parent_id),
      external_created_at = coalesce(p_external_created_at, external_created_at),
      external_updated_at = coalesce(p_external_updated_at, external_updated_at),
      provenance = case when p_provenance is null or p_provenance = '{}'::jsonb then provenance else p_provenance end,
      last_seen_at = v_now,
      updated_at = now()
    where id = v_id;
  end if;

  return jsonb_build_object('ok', true, 'ref_id', v_id, 'created', v_created);
end;
$$;

revoke execute on function public.integration_external_ref_upsert(uuid, text, text, text, text, uuid, uuid, text, bigint, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.integration_external_ref_upsert(uuid, text, text, text, text, uuid, uuid, text, bigint, bigint, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 8h. Sync state (server write, manager read).
-- ---------------------------------------------------------------------------

create or replace function public.integration_sync_state_upsert(
  p_organization_id uuid,
  p_connection_id uuid,
  p_provider text,
  p_resource_type text,
  p_status text,
  p_cursor text default null,
  p_last_synced_at bigint default null,
  p_items_synced bigint default null,
  p_error text default null,
  p_error_class text default null,
  p_next_attempt_at bigint default null,
  p_reset_failures boolean default false,
  p_is_full_sync boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
  v_id uuid;
begin
  if auth.uid() is not null or coalesce(auth.role(), 'service_role') = 'anon' then
    raise exception 'Access denied: trusted server connection required' using errcode = '42501';
  end if;
  if p_status not in ('idle', 'running', 'ok', 'error', 'rate_limited', 'backoff') then
    raise exception 'invalid sync status' using errcode = '22023';
  end if;

  insert into public.integration_sync_state (
    organization_id, connection_id, provider, resource_type, cursor,
    last_synced_at, last_attempted_at, last_full_sync_at, status,
    items_synced, consecutive_failures, next_attempt_at, last_error, error_class
  ) values (
    p_organization_id, p_connection_id, p_provider, p_resource_type, p_cursor,
    case when p_status = 'ok' then coalesce(p_last_synced_at, v_now) else null end,
    v_now,
    case when p_is_full_sync and p_status = 'ok' then v_now else null end,
    p_status,
    coalesce(p_items_synced, 0),
    case when p_status in ('error', 'rate_limited') then 1 else 0 end,
    p_next_attempt_at, p_error, p_error_class
  )
  on conflict (connection_id, resource_type) do update set
    -- The cursor only advances on success: a failed page is retried, never
    -- skipped, so no record is silently lost.
    cursor = case when p_status = 'ok' then coalesce(p_cursor, public.integration_sync_state.cursor)
                  else public.integration_sync_state.cursor end,
    last_synced_at = case when p_status = 'ok' then coalesce(p_last_synced_at, v_now)
                          else public.integration_sync_state.last_synced_at end,
    last_attempted_at = v_now,
    last_full_sync_at = case when p_is_full_sync and p_status = 'ok' then v_now
                             else public.integration_sync_state.last_full_sync_at end,
    status = p_status,
    items_synced = case when p_items_synced is null then public.integration_sync_state.items_synced
                        else coalesce(p_items_synced, 0) end,
    consecutive_failures = case
      when p_reset_failures or p_status = 'ok' then 0
      else public.integration_sync_state.consecutive_failures + 1 end,
    next_attempt_at = p_next_attempt_at,
    last_error = p_error,
    error_class = p_error_class,
    updated_at = now()
  returning id into v_id;

  return jsonb_build_object('ok', true, 'sync_state_id', v_id);
end;
$$;

revoke execute on function public.integration_sync_state_upsert(uuid, uuid, text, text, text, text, bigint, bigint, text, text, bigint, boolean, boolean) from public, anon, authenticated;
grant execute on function public.integration_sync_state_upsert(uuid, uuid, text, text, text, text, bigint, bigint, text, text, bigint, boolean, boolean) to service_role;

create or replace function public.integration_sync_state_list()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.get_current_tenant_id();
begin
  if v_tenant is null then
    raise exception 'Access denied: no active Atlas organization' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'connectionId', s.connection_id,
      'provider', s.provider,
      'resourceType', s.resource_type,
      'status', s.status,
      'cursor', s.cursor,
      'lastSyncedAt', s.last_synced_at,
      'lastAttemptedAt', s.last_attempted_at,
      'itemsSynced', s.items_synced,
      'consecutiveFailures', s.consecutive_failures,
      'nextAttemptAt', s.next_attempt_at,
      'lastError', s.last_error,
      'errorClass', s.error_class
    ) order by s.resource_type)
    from public.integration_sync_state s
    where s.organization_id = v_tenant
  ), '[]'::jsonb);
end;
$$;

revoke execute on function public.integration_sync_state_list() from public, anon;
grant execute on function public.integration_sync_state_list() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8i. Provider settings (server write).
-- ---------------------------------------------------------------------------

create or replace function public.integration_provider_settings_upsert(
  p_provider text,
  p_configured boolean,
  p_missing_env_vars text[] default '{}',
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null or coalesce(auth.role(), 'service_role') = 'anon' then
    raise exception 'Access denied: trusted server connection required' using errcode = '42501';
  end if;

  insert into public.integration_provider_settings (provider, configured, missing_env_vars, checked_at, notes)
  values (p_provider, coalesce(p_configured, false), coalesce(p_missing_env_vars, '{}'), (extract(epoch from now()) * 1000)::bigint, p_notes)
  on conflict (provider) do update set
    configured = coalesce(p_configured, false),
    missing_env_vars = coalesce(p_missing_env_vars, '{}'),
    checked_at = (extract(epoch from now()) * 1000)::bigint,
    notes = p_notes;

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.integration_provider_settings_upsert(text, boolean, text[], text) from public, anon, authenticated;
grant execute on function public.integration_provider_settings_upsert(text, boolean, text[], text) to service_role;

-- ---------------------------------------------------------------------------
-- 8j. Observability — organization manager diagnostics (no secrets).
-- ---------------------------------------------------------------------------

create or replace function public.integration_admin_overview()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.get_current_tenant_id();
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  if v_tenant is null then
    raise exception 'Access denied: no active Atlas organization' using errcode = '42501';
  end if;
  if not (
    public.is_atlas_admin()
    or exists (
      select 1 from public.memberships m
      where m."tenantId" = v_tenant and m."userId" = auth.uid()
        and m.status = 'active' and m.role in ('owner', 'admin', 'manager')
    )
  ) then
    raise exception 'Access denied: organization manager role required' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'generatedAt', v_now,
    'connections', jsonb_build_object(
      'total', (select count(*) from public.connections c where c."tenantId" = v_tenant and c."disconnectedAt" is null),
      'connected', (select count(*) from public.connections c where c."tenantId" = v_tenant and c.status = 'connected'),
      'erroring', (select count(*) from public.connections c where c."tenantId" = v_tenant and c.status = 'error')
    ),
    'events', jsonb_build_object(
      'last24h', (select count(*) from public.integration_events e where e.organization_id = v_tenant and e.received_at > v_now - 86400000),
      'pending', (select count(*) from public.integration_events e where e.organization_id = v_tenant and e.processing_status in ('pending', 'processing')),
      'failed', (select count(*) from public.integration_events e where e.organization_id = v_tenant and e.processing_status = 'failed'),
      'lastReceivedAt', (select max(e.received_at) from public.integration_events e where e.organization_id = v_tenant),
      'lastFailure', (
        select jsonb_build_object('eventType', e.event_type, 'provider', e.provider, 'errorClass', e.error_class)
        from public.integration_events e
        where e.organization_id = v_tenant and e.processing_status = 'failed'
        order by e.received_at desc limit 1
      )
    ),
    'sync', jsonb_build_object(
      'trackedResources', (select count(*) from public.integration_sync_state s where s.organization_id = v_tenant),
      'failing', (select count(*) from public.integration_sync_state s where s.organization_id = v_tenant and s.status in ('error', 'rate_limited')),
      'lastSyncedAt', (select max(s.last_synced_at) from public.integration_sync_state s where s.organization_id = v_tenant)
    ),
    'mappedRecords', (select count(*) from public.integration_external_refs r where r.organization_id = v_tenant),
    -- Deliberately NOT a token value: only a count of credentials that will need
    -- a refresh inside the next hour.
    'credentialsExpiringSoon', (
      select count(*) from public.connectiontokens t
      where t."tenantId" = v_tenant
        and t."tokenExpiresAt" is not null
        and t."tokenExpiresAt" < v_now + 3600000
    )
  );
end;
$$;

revoke execute on function public.integration_admin_overview() from public, anon;
grant execute on function public.integration_admin_overview() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. Server-only RPC that leaked whole connection rows to client roles.
-- ---------------------------------------------------------------------------

do $$ begin
  revoke execute on function public.connections_raw() from public, anon, authenticated;
exception when undefined_function then null;
end $$;
