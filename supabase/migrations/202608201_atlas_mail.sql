-- ==========================================================================
-- ⚠️  SUPERSEDED — DO NOT APPLY
-- Atlas Mail — Email client tables + RPC functions
--
-- This migration has been superseded by:
--   20260820_atlas_mail_combined.sql
--
-- The combined migration contains all tables, functions, RLS, and security
-- columns from both this file and 20260820_atlas_mail_security.sql.
-- It was applied manually to the live database on 2026-08-20.
--
-- DO NOT re-run this migration. The combined migration is idempotent
-- and safe to run against both clean and partially-applied databases.
-- ==========================================================================

-- ── email_accounts ──────────────────────────────────────────────────────
-- Stores configured mailbox accounts (credentials stored separately,
-- reference via encrypted_credentials_reference for IMAP/SMTP secrets).
create table if not exists public.email_accounts (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (_id) on delete cascade,
  email_address   text not null,
  display_name    text,
  provider        text not null default 'custom',
  imap_host       text,
  imap_port       integer default 993,
  imap_secure     boolean default true,
  smtp_host       text,
  smtp_port       integer default 465,
  smtp_secure     boolean default true,
  encrypted_credentials_reference text,
  sync_enabled    boolean default false,
  last_synced_at  timestamptz,
  sync_folders    jsonb default '[]'::jsonb,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ── email_messages ──────────────────────────────────────────────────────
create table if not exists public.email_messages (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references public.email_accounts (id) on delete cascade,
  provider_message_id text,
  message_id          text,
  thread_id           text,
  in_reply_to         text,
  "references"        jsonb,
  from_address        text,
  from_name           text,
  to_addresses        jsonb default '[]'::jsonb,
  cc_addresses        jsonb default '[]'::jsonb,
  bcc_addresses       jsonb default '[]'::jsonb,
  subject             text,
  text_body           text,
  html_body           text,
  snippet             text,
  received_at         timestamptz,
  sent_at             timestamptz,
  is_read             boolean default false,
  is_starred          boolean default false,
  is_draft            boolean default false,
  folder              text default 'INBOX',
  folder_path         text,
  has_attachments     boolean default false,
  attachment_count    integer default 0,
  labels              jsonb default '[]'::jsonb,
  contact_id          uuid,
  company_id          uuid,
  campaign_id         uuid,
  pilot_id            uuid,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

create index if not exists email_messages_account_idx on public.email_messages (account_id);
create index if not exists email_messages_thread_idx on public.email_messages (thread_id);
create index if not exists email_messages_folder_idx on public.email_messages (account_id, folder);
create index if not exists email_messages_received_idx on public.email_messages (received_at desc);
create index if not exists email_messages_message_id_idx on public.email_messages (message_id);

-- ── email_threads ───────────────────────────────────────────────────────
create table if not exists public.email_threads (
  id                   uuid primary key default gen_random_uuid(),
  account_id           uuid not null references public.email_accounts (id) on delete cascade,
  normalized_subject   text,
  message_ids          jsonb default '[]'::jsonb,
  latest_message_at    timestamptz,
  message_count        integer default 0,
  participant_addresses jsonb default '[]'::jsonb,
  created_at           timestamptz default now(),
  updated_at           timestamptz default now()
);

create index if not exists email_threads_account_idx on public.email_threads (account_id);

-- ── email_attachments ───────────────────────────────────────────────────
create table if not exists public.email_attachments (
  id                    uuid primary key default gen_random_uuid(),
  message_id            uuid not null references public.email_messages (id) on delete cascade,
  filename              text,
  mime_type             text,
  size                  bigint,
  provider_attachment_id text,
  storage_path          text,
  created_at            timestamptz default now()
);

create index if not exists email_attachments_msg_idx on public.email_attachments (message_id);

-- ── email_drafts ────────────────────────────────────────────────────────
create table if not exists public.email_drafts (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references public.email_accounts (id) on delete cascade,
  thread_id       text,
  in_reply_to     text,
  "references"    jsonb,
  to_addresses    jsonb default '[]'::jsonb,
  cc_addresses    jsonb default '[]'::jsonb,
  bcc_addresses   jsonb default '[]'::jsonb,
  subject         text,
  text_body       text,
  html_body       text,
  attachments     jsonb default '[]'::jsonb,
  labels          jsonb default '[]'::jsonb,
  signature_id    uuid,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ── email_signatures ────────────────────────────────────────────────────
create table if not exists public.email_signatures (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  tenant_id       uuid not null references public.tenants (_id) on delete cascade,
  name            text not null,
  signature_html  text,
  signature_text  text,
  is_default      boolean default false,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ── email_labels ────────────────────────────────────────────────────────
create table if not exists public.email_labels (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (_id) on delete cascade,
  name        text not null,
  color       text default '#6b7280',
  created_at  timestamptz default now()
);

create unique index if not exists email_labels_tenant_name_idx on public.email_labels (tenant_id, name);

-- ── email_message_labels ────────────────────────────────────────────────
create table if not exists public.email_message_labels (
  message_id  uuid not null references public.email_messages (id) on delete cascade,
  label_id    uuid not null references public.email_labels (id) on delete cascade,
  primary key (message_id, label_id)
);

-- ── RLS ─────────────────────────────────────────────────────────────────
alter table public.email_accounts enable row level security;
alter table public.email_messages enable row level security;
alter table public.email_threads enable row level security;
alter table public.email_attachments enable row level security;
alter table public.email_drafts enable row level security;
alter table public.email_signatures enable row level security;
alter table public.email_labels enable row level security;
alter table public.email_message_labels enable row level security;

-- Helper to get current tenant
create or replace function public.get_current_tenant_id()
returns uuid language sql stable security definer as $$
  select "tenantId" from public.memberships
  where "userId" = auth.uid() and status = 'active'
  limit 1;
$$;

-- ── email_accounts policies ─────────────────────────────────────────────
DROP POLICY IF EXISTS "email_accounts_select" ON public.email_accounts;
create policy "email_accounts_select" ON public.email_accounts
  for select using (tenant_id = public.get_current_tenant_id());

DROP POLICY IF EXISTS "email_accounts_insert" ON public.email_accounts;
create policy "email_accounts_insert" ON public.email_accounts
  for insert with check (tenant_id = public.get_current_tenant_id());

DROP POLICY IF EXISTS "email_accounts_update" ON public.email_accounts;
create policy "email_accounts_update" ON public.email_accounts
  for update using (tenant_id = public.get_current_tenant_id());

DROP POLICY IF EXISTS "email_accounts_delete" ON public.email_accounts;
create policy "email_accounts_delete" ON public.email_accounts
  for delete using (tenant_id = public.get_current_tenant_id());

-- ── email_messages policies ─────────────────────────────────────────────
DROP POLICY IF EXISTS "email_messages_select" ON public.email_messages;
create policy "email_messages_select" ON public.email_messages
  for select using (
    account_id in (
      select id from public.email_accounts
      where tenant_id = public.get_current_tenant_id()
    )
  );

DROP POLICY IF EXISTS "email_messages_insert" ON public.email_messages;
create policy "email_messages_insert" ON public.email_messages
  for insert with check (
    account_id in (
      select id from public.email_accounts
      where tenant_id = public.get_current_tenant_id()
    )
  );

DROP POLICY IF EXISTS "email_messages_update" ON public.email_messages;
create policy "email_messages_update" ON public.email_messages
  for update using (
    account_id in (
      select id from public.email_accounts
      where tenant_id = public.get_current_tenant_id()
    )
  );

DROP POLICY IF EXISTS "email_messages_delete" ON public.email_messages;
create policy "email_messages_delete" ON public.email_messages
  for delete using (
    account_id in (
      select id from public.email_accounts
      where tenant_id = public.get_current_tenant_id()
    )
  );

-- ── email_threads policies ──────────────────────────────────────────────
DROP POLICY IF EXISTS "email_threads_select" ON public.email_threads;
create policy "email_threads_select" ON public.email_threads
  for select using (
    account_id in (
      select id from public.email_accounts
      where tenant_id = public.get_current_tenant_id()
    )
  );

DROP POLICY IF EXISTS "email_threads_insert" ON public.email_threads;
create policy "email_threads_insert" ON public.email_threads
  for insert with check (
    account_id in (
      select id from public.email_accounts
      where tenant_id = public.get_current_tenant_id()
    )
  );

DROP POLICY IF EXISTS "email_threads_update" ON public.email_threads;
create policy "email_threads_update" ON public.email_threads
  for update using (
    account_id in (
      select id from public.email_accounts
      where tenant_id = public.get_current_tenant_id()
    )
  );

-- ── email_attachments policies ──────────────────────────────────────────
DROP POLICY IF EXISTS "email_attachments_select" ON public.email_attachments;
create policy "email_attachments_select" ON public.email_attachments
  for select using (
    message_id in (
      select m.id from public.email_messages m
      join public.email_accounts a on a.id = m.account_id
      where a.tenant_id = public.get_current_tenant_id()
    )
  );

DROP POLICY IF EXISTS "email_attachments_insert" ON public.email_attachments;
create policy "email_attachments_insert" ON public.email_attachments
  for insert with check (
    message_id in (
      select m.id from public.email_messages m
      join public.email_accounts a on a.id = m.account_id
      where a.tenant_id = public.get_current_tenant_id()
    )
  );

-- ── email_drafts policies ───────────────────────────────────────────────
DROP POLICY IF EXISTS "email_drafts_select" ON public.email_drafts;
create policy "email_drafts_select" ON public.email_drafts
  for select using (
    account_id in (
      select id from public.email_accounts
      where tenant_id = public.get_current_tenant_id()
    )
  );

DROP POLICY IF EXISTS "email_drafts_insert" ON public.email_drafts;
create policy "email_drafts_insert" ON public.email_drafts
  for insert with check (
    account_id in (
      select id from public.email_accounts
      where tenant_id = public.get_current_tenant_id()
    )
  );

DROP POLICY IF EXISTS "email_drafts_update" ON public.email_drafts;
create policy "email_drafts_update" ON public.email_drafts
  for update using (
    account_id in (
      select id from public.email_accounts
      where tenant_id = public.get_current_tenant_id()
    )
  );

DROP POLICY IF EXISTS "email_drafts_delete" ON public.email_drafts;
create policy "email_drafts_delete" ON public.email_drafts
  for delete using (
    account_id in (
      select id from public.email_accounts
      where tenant_id = public.get_current_tenant_id()
    )
  );

-- ── email_signatures policies ───────────────────────────────────────────
DROP POLICY IF EXISTS "email_signatures_select" ON public.email_signatures;
create policy "email_signatures_select" ON public.email_signatures
  for select using (tenant_id = public.get_current_tenant_id());

DROP POLICY IF EXISTS "email_signatures_insert" ON public.email_signatures;
create policy "email_signatures_insert" ON public.email_signatures
  for insert with check (tenant_id = public.get_current_tenant_id());

DROP POLICY IF EXISTS "email_signatures_update" ON public.email_signatures;
create policy "email_signatures_update" ON public.email_signatures
  for update using (tenant_id = public.get_current_tenant_id());

DROP POLICY IF EXISTS "email_signatures_delete" ON public.email_signatures;
create policy "email_signatures_delete" ON public.email_signatures
  for delete using (tenant_id = public.get_current_tenant_id());

-- ── email_labels policies ───────────────────────────────────────────────
DROP POLICY IF EXISTS "email_labels_select" ON public.email_labels;
create policy "email_labels_select" ON public.email_labels
  for select using (tenant_id = public.get_current_tenant_id());

DROP POLICY IF EXISTS "email_labels_insert" ON public.email_labels;
create policy "email_labels_insert" ON public.email_labels
  for insert with check (tenant_id = public.get_current_tenant_id());

DROP POLICY IF EXISTS "email_labels_delete" ON public.email_labels;
create policy "email_labels_delete" ON public.email_labels
  for delete using (tenant_id = public.get_current_tenant_id());

-- ── email_message_labels policies ───────────────────────────────────────
DROP POLICY IF EXISTS "email_message_labels_select" ON public.email_message_labels;
create policy "email_message_labels_select" ON public.email_message_labels
  for select using (
    message_id in (
      select m.id from public.email_messages m
      join public.email_accounts a on a.id = m.account_id
      where a.tenant_id = public.get_current_tenant_id()
    )
  );

DROP POLICY IF EXISTS "email_message_labels_insert" ON public.email_message_labels;
create policy "email_message_labels_insert" ON public.email_message_labels
  for insert with check (
    message_id in (
      select m.id from public.email_messages m
      join public.email_accounts a on a.id = m.account_id
      where a.tenant_id = public.get_current_tenant_id()
    )
  );

DROP POLICY IF EXISTS "email_message_labels_delete" ON public.email_message_labels;
create policy "email_message_labels_delete" ON public.email_message_labels
  for delete using (
    message_id in (
      select m.id from public.email_messages m
      join public.email_accounts a on a.id = m.account_id
      where a.tenant_id = public.get_current_tenant_id()
    )
  );

-- ── RPC: email_accounts_list ────────────────────────────────────────────
create or replace function public.email_accounts_list()
returns jsonb language plpgsql security definer as $$
declare
  v_tenant_id uuid;
begin
  v_tenant_id := public.get_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No active workspace';
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(a) - 'encrypted_credentials_reference')
    from public.email_accounts a
    where a.tenant_id = v_tenant_id
    order by a.created_at desc
  ), '[]'::jsonb);
end;
$$;

-- ── RPC: email_accounts_create ──────────────────────────────────────────
create or replace function public.email_accounts_create(
  p_email_address text,
  p_display_name text default null,
  p_provider text default 'custom',
  p_imap_host text default null,
  p_imap_port integer default 993,
  p_imap_secure boolean default true,
  p_smtp_host text default null,
  p_smtp_port integer default 465,
  p_smtp_secure boolean default true,
  p_encrypted_credentials_reference text default null
)
returns jsonb language plpgsql security definer as $$
declare
  v_tenant_id uuid;
  v_account jsonb;
begin
  v_tenant_id := public.get_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No active workspace';
  end if;
  insert into public.email_accounts (
    tenant_id, email_address, display_name, provider,
    imap_host, imap_port, imap_secure,
    smtp_host, smtp_port, smtp_secure,
    encrypted_credentials_reference
  ) values (
    v_tenant_id, p_email_address, p_display_name, p_provider,
    p_imap_host, p_imap_port, p_imap_secure,
    p_smtp_host, p_smtp_port, p_smtp_secure,
    p_encrypted_credentials_reference
  )
  returning row_to_json(email_accounts.*) - 'encrypted_credentials_reference'
  into v_account;
  return v_account;
end;
$$;

-- ── RPC: email_accounts_update ──────────────────────────────────────────
create or replace function public.email_accounts_update(
  p_id uuid,
  p_email_address text default null,
  p_display_name text default null,
  p_imap_host text default null,
  p_imap_port integer default null,
  p_imap_secure boolean default null,
  p_smtp_host text default null,
  p_smtp_port integer default null,
  p_smtp_secure boolean default null,
  p_encrypted_credentials_reference text default null,
  p_sync_enabled boolean default null
)
returns jsonb language plpgsql security definer as $$
declare
  v_tenant_id uuid;
  v_account jsonb;
begin
  v_tenant_id := public.get_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No active workspace';
  end if;
  update public.email_accounts set
    email_address = coalesce(p_email_address, email_address),
    display_name = coalesce(p_display_name, display_name),
    imap_host = coalesce(p_imap_host, imap_host),
    imap_port = coalesce(p_imap_port, imap_port),
    imap_secure = coalesce(p_imap_secure, imap_secure),
    smtp_host = coalesce(p_smtp_host, smtp_host),
    smtp_port = coalesce(p_smtp_port, smtp_port),
    smtp_secure = coalesce(p_smtp_secure, smtp_secure),
    encrypted_credentials_reference = coalesce(p_encrypted_credentials_reference, encrypted_credentials_reference),
    sync_enabled = coalesce(p_sync_enabled, sync_enabled),
    updated_at = now()
  where id = p_id and tenant_id = v_tenant_id
  returning row_to_json(email_accounts.*) - 'encrypted_credentials_reference'
  into v_account;
  return v_account;
end;
$$;

-- ── RPC: email_accounts_delete ──────────────────────────────────────────
create or replace function public.email_accounts_delete(
  p_id uuid
)
returns boolean language plpgsql security definer as $$
declare
  v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No active workspace';
  end if;
  DELETE FROM public.email_accounts WHERE id = p_id AND tenant_id = v_tenant_id;
  RETURN FOUND;
end;
$$;

-- ── RPC: email_accounts_set_sync_state ──────────────────────────────────
create or replace function public.email_accounts_set_sync_state(
  p_id uuid,
  p_sync_enabled boolean default null,
  p_sync_folders jsonb default null
)
returns boolean language plpgsql security definer as $$
declare
  v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No active workspace';
  end if;
  UPDATE public.email_accounts SET
    sync_enabled = coalesce(p_sync_enabled, sync_enabled),
    sync_folders = coalesce(p_sync_folders, sync_folders),
    last_synced_at = now(),
    updated_at = now()
  WHERE id = p_id AND tenant_id = v_tenant_id;
  RETURN FOUND;
end;
$$;

-- ── RPC: email_messages_list ────────────────────────────────────────────
create or replace function public.email_messages_list(
  p_account_id uuid,
  p_folder text default 'INBOX',
  p_limit integer default 50,
  p_offset integer default 0,
  p_search text default null
)
returns jsonb language plpgsql security definer as $$
declare
  v_tenant_id uuid;
begin
  v_tenant_id := public.get_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No active workspace';
  end if;
  if not exists (
    select 1 from public.email_accounts
    where id = p_account_id and tenant_id = v_tenant_id
  ) then
    raise exception 'Account not found';
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(m))
    from public.email_messages m
    where m.account_id = p_account_id
      and m.folder = p_folder
      and m.is_draft = false
      and (
        p_search is null
        or m.subject ilike '%' || p_search || '%'
        or m.from_address ilike '%' || p_search || '%'
        or m.from_name ilike '%' || p_search || '%'
        or m.snippet ilike '%' || p_search || '%'
        or m.text_body ilike '%' || p_search || '%'
      )
    order by m.received_at desc
    limit p_limit offset p_offset
  ), '[]'::jsonb);
end;
$$;

-- ── RPC: email_messages_list_sent ───────────────────────────────────────
create or replace function public.email_messages_list_sent(
  p_account_id uuid,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb language plpgsql security definer as $$
declare
  v_tenant_id uuid;
begin
  v_tenant_id := public.get_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No active workspace';
  end if;
  if not exists (
    select 1 from public.email_accounts
    where id = p_account_id and tenant_id = v_tenant_id
  ) then
    raise exception 'Account not found';
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(m))
    from public.email_messages m
    where m.account_id = p_account_id
      and m.folder = 'Sent'
      and m.is_draft = false
    order by m.sent_at desc nulls last, m.created_at desc
    limit p_limit offset p_offset
  ), '[]'::jsonb);
end;
$$;

-- ── RPC: email_messages_list_drafts ─────────────────────────────────────
create or replace function public.email_messages_list_drafts(
  p_account_id uuid,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb language plpgsql security definer as $$
declare
  v_tenant_id uuid;
begin
  v_tenant_id := public.get_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No active workspace';
  end if;
  if not exists (
    select 1 from public.email_accounts
    where id = p_account_id and tenant_id = v_tenant_id
  ) then
    raise exception 'Account not found';
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(d))
    from public.email_drafts d
    where d.account_id = p_account_id
    order by d.updated_at desc
    limit p_limit offset p_offset
  ), '[]'::jsonb);
end;
$$;

-- ── RPC: email_messages_list_starred ────────────────────────────────────
create or replace function public.email_messages_list_starred(
  p_account_id uuid,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb language plpgsql security definer as $$
declare
  v_tenant_id uuid;
begin
  v_tenant_id := public.get_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No active workspace';
  end if;
  if not exists (
    select 1 from public.email_accounts
    where id = p_account_id and tenant_id = v_tenant_id
  ) then
    raise exception 'Account not found';
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(m))
    from public.email_messages m
    where m.account_id = p_account_id
      and m.is_starred = true
      and m.is_draft = false
    order by m.received_at desc
    limit p_limit offset p_offset
  ), '[]'::jsonb);
end;
$$;

-- ── RPC: email_messages_list_all ────────────────────────────────────────
-- For search across all folders
create or replace function public.email_messages_list_all(
  p_account_id uuid,
  p_limit integer default 50,
  p_offset integer default 0,
  p_search text default null
)
returns jsonb language plpgsql security definer as $$
declare
  v_tenant_id uuid;
begin
  v_tenant_id := public.get_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No active workspace';
  end if;
  if not exists (
    select 1 from public.email_accounts
    where id = p_account_id and tenant_id = v_tenant_id
  ) then
    raise exception 'Account not found';
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(m))
    from public.email_messages m
    where m.account_id = p_account_id
      and m.is_draft = false
      and (
        p_search is null
        or m.subject ilike '%' || p_search || '%'
        or m.from_address ilike '%' || p_search || '%'
        or m.from_name ilike '%' || p_search || '%'
        or m.snippet ilike '%' || p_search || '%'
        or m.text_body ilike '%' || p_search || '%'
      )
    order by m.received_at desc
    limit p_limit offset p_offset
  ), '[]'::jsonb);
end;
$$;

-- ── RPC: email_messages_get ─────────────────────────────────────────────
create or replace function public.email_messages_get(
  p_id uuid
)
returns jsonb language plpgsql security definer as $$
declare
  v_tenant_id uuid;
  v_message jsonb;
  v_attachments jsonb;
begin
  v_tenant_id := public.get_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No active workspace';
  end if;
  select row_to_json(m)
  into v_message
  from public.email_messages m
  join public.email_accounts a on a.id = m.account_id
  where m.id = p_id and a.tenant_id = v_tenant_id;
  if v_message is null then
    return null;
  end if;
  select coalesce(jsonb_agg(row_to_json(at)), '[]'::jsonb)
  into v_attachments
  from public.email_attachments at
  where at.message_id = p_id;
  v_message := v_message || jsonb_build_object('attachments', v_attachments);
  return v_message;
end;
$$;

-- ── RPC: email_messages_list_thread ─────────────────────────────────────
create or replace function public.email_messages_list_thread(
  p_thread_id text,
  p_account_id uuid
)
returns jsonb language plpgsql security definer as $$
declare
  v_tenant_id uuid;
begin
  v_tenant_id := public.get_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No active workspace';
  end if;
  if not exists (
    select 1 from public.email_accounts
    where id = p_account_id and tenant_id = v_tenant_id
  ) then
    raise exception 'Account not found';
  end if;
  return coalesce((
    select jsonb_agg(
      row_to_json(m) || jsonb_build_object(
        'attachments', coalesce((
          select jsonb_agg(row_to_json(at))
          from public.email_attachments at
          where at.message_id = m.id
        ), '[]'::jsonb)
      )
      order by m.received_at asc
    )
    from public.email_messages m
    where m.account_id = p_account_id
      and m.thread_id = p_thread_id
      and m.is_draft = false
  ), '[]'::jsonb);
end;
$$;

-- ── RPC: email_messages_mark_read ───────────────────────────────────────
create or replace function public.email_messages_mark_read(
  p_id uuid,
  p_is_read boolean default true
)
returns boolean language plpgsql security definer as $$
declare
  v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No active workspace';
  end if;
  UPDATE public.email_messages SET is_read = p_is_read, updated_at = now()
  WHERE id = p_id AND account_id IN (
    SELECT id FROM public.email_accounts WHERE tenant_id = v_tenant_id
  );
  RETURN FOUND;
end;
$$;

-- ── RPC: email_messages_mark_starred ────────────────────────────────────
create or replace function public.email_messages_mark_starred(
  p_id uuid,
  p_is_starred boolean default true
)
returns boolean language plpgsql security definer as $$
declare
  v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No active workspace';
  end if;
  UPDATE public.email_messages SET is_starred = p_is_starred, updated_at = now()
  WHERE id = p_id AND account_id IN (
    SELECT id FROM public.email_accounts WHERE tenant_id = v_tenant_id
  );
  RETURN FOUND;
end;
$$;

-- ── RPC: email_messages_move ────────────────────────────────────────────
create or replace function public.email_messages_move(
  p_id uuid,
  p_folder text
)
returns boolean language plpgsql security definer as $$
declare
  v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No active workspace';
  end if;
  UPDATE public.email_messages SET folder = p_folder, updated_at = now()
  WHERE id = p_id AND account_id IN (
    SELECT id FROM public.email_accounts WHERE tenant_id = v_tenant_id
  );
  RETURN FOUND;
end;
$$;

-- ── RPC: email_messages_delete ──────────────────────────────────────────
create or replace function public.email_messages_delete(
  p_id uuid
)
returns boolean language plpgsql security definer as $$
declare
  v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No active workspace';
  end if;
  DELETE FROM public.email_messages
  WHERE id = p_id AND account_id IN (
    SELECT id FROM public.email_accounts WHERE tenant_id = v_tenant_id
  );
  RETURN FOUND;
end;
$$;

-- ── RPC: email_messages_count ───────────────────────────────────────────
create or replace function public.email_messages_count(
  p_account_id uuid,
  p_folder text default null
)
returns jsonb language plpgsql security definer as $$
declare
  v_tenant_id uuid;
  v_total integer;
  v_unread integer;
begin
  v_tenant_id := public.get_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No active workspace';
  end if;
  if not exists (
    select 1 from public.email_accounts
    where id = p_account_id and tenant_id = v_tenant_id
  ) then
    raise exception 'Account not found';
  end if;
  select count(*), count(*) filter (where not is_read)
  into v_total, v_unread
  from public.email_messages
  where account_id = p_account_id
    and is_draft = false
    and (p_folder is null or folder = p_folder);
  return jsonb_build_object(
    'total', v_total,
    'unread', v_unread
  );
end;
$$;

-- ── RPC: email_drafts_save ──────────────────────────────────────────────
create or replace function public.email_drafts_save(
  p_account_id uuid,
  p_id uuid default null,
  p_thread_id text default null,
  p_in_reply_to text default null,
  p_references jsonb default null,
  p_to_addresses jsonb default '[]'::jsonb,
  p_cc_addresses jsonb default '[]'::jsonb,
  p_bcc_addresses jsonb default '[]'::jsonb,
  p_subject text default null,
  p_text_body text default null,
  p_html_body text default null,
  p_attachments jsonb default '[]'::jsonb,
  p_signature_id uuid default null
)
returns jsonb language plpgsql security definer as $$
declare
  v_tenant_id uuid;
  v_draft jsonb;
begin
  v_tenant_id := public.get_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No active workspace';
  end if;
  if not exists (
    select 1 from public.email_accounts
    where id = p_account_id and tenant_id = v_tenant_id
  ) then
    raise exception 'Account not found';
  end if;
  if p_id is not null then
    update public.email_drafts set
      thread_id = coalesce(p_thread_id, thread_id),
      in_reply_to = coalesce(p_in_reply_to, in_reply_to),
      "references" = coalesce(p_references, "references"),
      to_addresses = p_to_addresses,
      cc_addresses = p_cc_addresses,
      bcc_addresses = p_bcc_addresses,
      subject = coalesce(p_subject, subject),
      text_body = coalesce(p_text_body, text_body),
      html_body = coalesce(p_html_body, html_body),
      attachments = p_attachments,
      signature_id = coalesce(p_signature_id, signature_id),
      updated_at = now()
    where id = p_id and account_id = p_account_id
    returning row_to_json(email_drafts.*) into v_draft;
  else
    insert into public.email_drafts (
      account_id, thread_id, in_reply_to, "references",
      to_addresses, cc_addresses, bcc_addresses,
      subject, text_body, html_body, attachments, signature_id
    ) values (
      p_account_id, p_thread_id, p_in_reply_to, p_references,
      p_to_addresses, p_cc_addresses, p_bcc_addresses,
      p_subject, p_text_body, p_html_body, p_attachments, p_signature_id
    )
    returning row_to_json(email_drafts.*) into v_draft;
  end if;
  return v_draft;
end;
$$;

-- ── RPC: email_drafts_delete ────────────────────────────────────────────
create or replace function public.email_drafts_delete(
  p_id uuid
)
returns boolean language plpgsql security definer as $$
declare
  v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No active workspace';
  end if;
  DELETE FROM public.email_drafts
  WHERE id = p_id AND account_id IN (
    SELECT id FROM public.email_accounts WHERE tenant_id = v_tenant_id
  );
  RETURN FOUND;
end;
$$;

-- ── RPC: email_signatures_list ──────────────────────────────────────────
create or replace function public.email_signatures_list()
returns jsonb language plpgsql security definer as $$
declare
  v_tenant_id uuid;
begin
  v_tenant_id := public.get_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No active workspace';
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(s))
    from public.email_signatures s
    where s.tenant_id = v_tenant_id
    order by s.is_default desc, s.name
  ), '[]'::jsonb);
end;
$$;

-- ── RPC: email_signatures_save ──────────────────────────────────────────
create or replace function public.email_signatures_save(
  p_name text,
  p_id uuid default null,
  p_signature_html text default null,
  p_signature_text text default null,
  p_is_default boolean default false
)
returns jsonb language plpgsql security definer as $$
declare
  v_tenant_id uuid;
  v_sig jsonb;
begin
  v_tenant_id := public.get_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No active workspace';
  end if;
  if p_is_default then
    update public.email_signatures set is_default = false
    where tenant_id = v_tenant_id;
  end if;
  if p_id is not null then
    update public.email_signatures set
      name = p_name,
      signature_html = coalesce(p_signature_html, signature_html),
      signature_text = coalesce(p_signature_text, signature_text),
      is_default = p_is_default,
      updated_at = now()
    where id = p_id and tenant_id = v_tenant_id
    returning row_to_json(email_signatures.*) into v_sig;
  else
    insert into public.email_signatures (
      user_id, tenant_id, name, signature_html, signature_text, is_default
    ) values (
      auth.uid(), v_tenant_id, p_name, p_signature_html, p_signature_text, p_is_default
    )
    returning row_to_json(email_signatures.*) into v_sig;
  end if;
  return v_sig;
end;
$$;

-- ── RPC: email_signatures_delete ────────────────────────────────────────
create or replace function public.email_signatures_delete(
  p_id uuid
)
returns boolean language plpgsql security definer as $$
declare
  v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No active workspace';
  end if;
  DELETE FROM public.email_signatures WHERE id = p_id AND tenant_id = v_tenant_id;
  RETURN FOUND;
end;
$$;

-- ── RPC: email_labels_list ──────────────────────────────────────────────
create or replace function public.email_labels_list()
returns jsonb language plpgsql security definer as $$
declare
  v_tenant_id uuid;
begin
  v_tenant_id := public.get_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No active workspace';
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(l))
    from public.email_labels l
    where l.tenant_id = v_tenant_id
    order by l.name
  ), '[]'::jsonb);
end;
$$;

-- ── RPC: email_labels_save ──────────────────────────────────────────────
create or replace function public.email_labels_save(
  p_name text,
  p_id uuid default null,
  p_color text default '#6b7280'
)
returns jsonb language plpgsql security definer as $$
declare
  v_tenant_id uuid;
  v_label jsonb;
begin
  v_tenant_id := public.get_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No active workspace';
  end if;
  if p_id is not null then
    update public.email_labels set
      name = p_name,
      color = p_color
    where id = p_id and tenant_id = v_tenant_id
    returning row_to_json(email_labels.*) into v_label;
  else
    insert into public.email_labels (tenant_id, name, color)
    values (v_tenant_id, p_name, p_color)
    returning row_to_json(email_labels.*) into v_label;
  end if;
  return v_label;
end;
$$;

-- ── RPC: email_labels_delete ────────────────────────────────────────────
create or replace function public.email_labels_delete(
  p_id uuid
)
returns boolean language plpgsql security definer as $$
declare
  v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No active workspace';
  end if;
  DELETE FROM public.email_labels WHERE id = p_id AND tenant_id = v_tenant_id;
  RETURN FOUND;
end;
$$;

-- ── RPC: email_messages_set_labels ──────────────────────────────────────
create or replace function public.email_messages_set_labels(
  p_message_id uuid,
  p_label_ids jsonb
)
returns boolean language plpgsql security definer as $$
declare
  v_tenant_id uuid;
  v_label_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No active workspace';
  end if;
  delete from public.email_message_labels where message_id = p_message_id;
  for v_label_id in select jsonb_array_elements_text(p_label_ids)::uuid loop
    insert into public.email_message_labels (message_id, label_id)
    values (p_message_id, v_label_id);
  end loop;
  RETURN true;
end;
$$;
