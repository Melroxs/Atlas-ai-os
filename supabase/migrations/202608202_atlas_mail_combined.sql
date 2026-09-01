-- ==========================================================================
-- ATLAS MAIL — COMBINED IDEMPOTENT MIGRATION
--
-- Safe to run against:
--   - A clean database (no Atlas Mail objects)
--   - A database where the first migration partially applied
--   - A database where both migrations partially applied
--
-- Order: tables → RLS → functions → security columns → storage
-- Uses IF NOT EXISTS / OR REPLACE / DO blocks for idempotency.
-- ==========================================================================

-- ── 1. TABLES ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.email_accounts (
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

CREATE TABLE IF NOT EXISTS public.email_messages (
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

CREATE TABLE IF NOT EXISTS public.email_threads (
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

CREATE TABLE IF NOT EXISTS public.email_attachments (
  id                    uuid primary key default gen_random_uuid(),
  message_id            uuid not null references public.email_messages (id) on delete cascade,
  filename              text,
  mime_type             text,
  size                  bigint,
  provider_attachment_id text,
  storage_path          text,
  created_at            timestamptz default now()
);

CREATE TABLE IF NOT EXISTS public.email_drafts (
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

CREATE TABLE IF NOT EXISTS public.email_signatures (
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

CREATE TABLE IF NOT EXISTS public.email_labels (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (_id) on delete cascade,
  name        text not null,
  color       text default '#6b7280',
  created_at  timestamptz default now()
);

CREATE TABLE IF NOT EXISTS public.email_message_labels (
  message_id  uuid not null references public.email_messages (id) on delete cascade,
  label_id    uuid not null references public.email_labels (id) on delete cascade,
  primary key (message_id, label_id)
);

-- Indexes (idempotent)
CREATE INDEX IF NOT EXISTS email_messages_account_idx ON public.email_messages (account_id);
CREATE INDEX IF NOT EXISTS email_messages_thread_idx ON public.email_messages (thread_id);
CREATE INDEX IF NOT EXISTS email_messages_folder_idx ON public.email_messages (account_id, folder);
CREATE INDEX IF NOT EXISTS email_messages_received_idx ON public.email_messages (received_at desc);
CREATE INDEX IF NOT EXISTS email_messages_message_id_idx ON public.email_messages (message_id);
CREATE INDEX IF NOT EXISTS email_threads_account_idx ON public.email_threads (account_id);
CREATE INDEX IF NOT EXISTS email_attachments_msg_idx ON public.email_attachments (message_id);
CREATE UNIQUE INDEX IF NOT EXISTS email_labels_tenant_name_idx ON public.email_labels (tenant_id, name);

-- ── 2. SECURITY COLUMNS (from security migration) ───────────────────────

DO $$ BEGIN
  ALTER TABLE public.email_accounts ADD COLUMN IF NOT EXISTS encrypted_credentials text;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.email_accounts ADD COLUMN IF NOT EXISTS connection_status text default 'untested';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.email_accounts ADD COLUMN IF NOT EXISTS connection_error text;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.email_accounts ADD COLUMN IF NOT EXISTS connection_tested_at timestamptz;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.email_messages ADD COLUMN IF NOT EXISTS uid_validity integer;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.email_messages ADD COLUMN IF NOT EXISTS last_uid integer;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.email_messages ADD COLUMN IF NOT EXISTS body_fetched boolean default false;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- ── 3. RLS ──────────────────────────────────────────────────────────────

ALTER TABLE public.email_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_message_labels ENABLE ROW LEVEL SECURITY;

-- Helper function
CREATE OR REPLACE FUNCTION public.get_current_tenant_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT "tenantId" FROM public.memberships
  WHERE "userId" = auth.uid() AND status = 'active'
  LIMIT 1;
$$;

-- RLS Policies (DROP IF EXISTS + CREATE for idempotency)
DO $$ BEGIN DROP POLICY IF EXISTS "email_accounts_select" ON public.email_accounts; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "email_accounts_insert" ON public.email_accounts; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "email_accounts_update" ON public.email_accounts; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "email_accounts_delete" ON public.email_accounts; END $$;

CREATE POLICY "email_accounts_select" ON public.email_accounts
  FOR SELECT USING (tenant_id = public.get_current_tenant_id());
CREATE POLICY "email_accounts_insert" ON public.email_accounts
  FOR INSERT WITH CHECK (tenant_id = public.get_current_tenant_id());
CREATE POLICY "email_accounts_update" ON public.email_accounts
  FOR UPDATE USING (tenant_id = public.get_current_tenant_id());
CREATE POLICY "email_accounts_delete" ON public.email_accounts
  FOR DELETE USING (tenant_id = public.get_current_tenant_id());

DO $$ BEGIN DROP POLICY IF EXISTS "email_messages_select" ON public.email_messages; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "email_messages_insert" ON public.email_messages; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "email_messages_update" ON public.email_messages; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "email_messages_delete" ON public.email_messages; END $$;

CREATE POLICY "email_messages_select" ON public.email_messages
  FOR SELECT USING (account_id IN (SELECT id FROM public.email_accounts WHERE tenant_id = public.get_current_tenant_id()));
CREATE POLICY "email_messages_insert" ON public.email_messages
  FOR INSERT WITH CHECK (account_id IN (SELECT id FROM public.email_accounts WHERE tenant_id = public.get_current_tenant_id()));
CREATE POLICY "email_messages_update" ON public.email_messages
  FOR UPDATE USING (account_id IN (SELECT id FROM public.email_accounts WHERE tenant_id = public.get_current_tenant_id()));
CREATE POLICY "email_messages_delete" ON public.email_messages
  FOR DELETE USING (account_id IN (SELECT id FROM public.email_accounts WHERE tenant_id = public.get_current_tenant_id()));

DO $$ BEGIN DROP POLICY IF EXISTS "email_threads_select" ON public.email_threads; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "email_threads_insert" ON public.email_threads; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "email_threads_update" ON public.email_threads; END $$;

CREATE POLICY "email_threads_select" ON public.email_threads
  FOR SELECT USING (account_id IN (SELECT id FROM public.email_accounts WHERE tenant_id = public.get_current_tenant_id()));
CREATE POLICY "email_threads_insert" ON public.email_threads
  FOR INSERT WITH CHECK (account_id IN (SELECT id FROM public.email_accounts WHERE tenant_id = public.get_current_tenant_id()));
CREATE POLICY "email_threads_update" ON public.email_threads
  FOR UPDATE USING (account_id IN (SELECT id FROM public.email_accounts WHERE tenant_id = public.get_current_tenant_id()));

DO $$ BEGIN DROP POLICY IF EXISTS "email_attachments_select" ON public.email_attachments; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "email_attachments_insert" ON public.email_attachments; END $$;

CREATE POLICY "email_attachments_select" ON public.email_attachments
  FOR SELECT USING (message_id IN (SELECT m.id FROM public.email_messages m JOIN public.email_accounts a ON a.id = m.account_id WHERE a.tenant_id = public.get_current_tenant_id()));
CREATE POLICY "email_attachments_insert" ON public.email_attachments
  FOR INSERT WITH CHECK (message_id IN (SELECT m.id FROM public.email_messages m JOIN public.email_accounts a ON a.id = m.account_id WHERE a.tenant_id = public.get_current_tenant_id()));

DO $$ BEGIN DROP POLICY IF EXISTS "email_drafts_select" ON public.email_drafts; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "email_drafts_insert" ON public.email_drafts; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "email_drafts_update" ON public.email_drafts; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "email_drafts_delete" ON public.email_drafts; END $$;

CREATE POLICY "email_drafts_select" ON public.email_drafts
  FOR SELECT USING (account_id IN (SELECT id FROM public.email_accounts WHERE tenant_id = public.get_current_tenant_id()));
CREATE POLICY "email_drafts_insert" ON public.email_drafts
  FOR INSERT WITH CHECK (account_id IN (SELECT id FROM public.email_accounts WHERE tenant_id = public.get_current_tenant_id()));
CREATE POLICY "email_drafts_update" ON public.email_drafts
  FOR UPDATE USING (account_id IN (SELECT id FROM public.email_accounts WHERE tenant_id = public.get_current_tenant_id()));
CREATE POLICY "email_drafts_delete" ON public.email_drafts
  FOR DELETE USING (account_id IN (SELECT id FROM public.email_accounts WHERE tenant_id = public.get_current_tenant_id()));

DO $$ BEGIN DROP POLICY IF EXISTS "email_signatures_select" ON public.email_signatures; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "email_signatures_insert" ON public.email_signatures; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "email_signatures_update" ON public.email_signatures; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "email_signatures_delete" ON public.email_signatures; END $$;

CREATE POLICY "email_signatures_select" ON public.email_signatures
  FOR SELECT USING (tenant_id = public.get_current_tenant_id());
CREATE POLICY "email_signatures_insert" ON public.email_signatures
  FOR INSERT WITH CHECK (tenant_id = public.get_current_tenant_id());
CREATE POLICY "email_signatures_update" ON public.email_signatures
  FOR UPDATE USING (tenant_id = public.get_current_tenant_id());
CREATE POLICY "email_signatures_delete" ON public.email_signatures
  FOR DELETE USING (tenant_id = public.get_current_tenant_id());

DO $$ BEGIN DROP POLICY IF EXISTS "email_labels_select" ON public.email_labels; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "email_labels_insert" ON public.email_labels; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "email_labels_delete" ON public.email_labels; END $$;

CREATE POLICY "email_labels_select" ON public.email_labels
  FOR SELECT USING (tenant_id = public.get_current_tenant_id());
CREATE POLICY "email_labels_insert" ON public.email_labels
  FOR INSERT WITH CHECK (tenant_id = public.get_current_tenant_id());
CREATE POLICY "email_labels_delete" ON public.email_labels
  FOR DELETE USING (tenant_id = public.get_current_tenant_id());

DO $$ BEGIN DROP POLICY IF EXISTS "email_message_labels_select" ON public.email_message_labels; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "email_message_labels_insert" ON public.email_message_labels; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "email_message_labels_delete" ON public.email_message_labels; END $$;

CREATE POLICY "email_message_labels_select" ON public.email_message_labels
  FOR SELECT USING (message_id IN (SELECT m.id FROM public.email_messages m JOIN public.email_accounts a ON a.id = m.account_id WHERE a.tenant_id = public.get_current_tenant_id()));
CREATE POLICY "email_message_labels_insert" ON public.email_message_labels
  FOR INSERT WITH CHECK (message_id IN (SELECT m.id FROM public.email_messages m JOIN public.email_accounts a ON a.id = m.account_id WHERE a.tenant_id = public.get_current_tenant_id()));
CREATE POLICY "email_message_labels_delete" ON public.email_message_labels
  FOR DELETE USING (message_id IN (SELECT m.id FROM public.email_messages m JOIN public.email_accounts a ON a.id = m.account_id WHERE a.tenant_id = public.get_current_tenant_id()));

-- ── 4. FUNCTIONS ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.email_accounts_list()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(a) - 'encrypted_credentials_reference' - 'encrypted_credentials')
    FROM public.email_accounts a WHERE a.tenant_id = v_tenant_id ORDER BY a.created_at DESC
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.email_accounts_create(
  p_email_address text, p_display_name text DEFAULT NULL, p_provider text DEFAULT 'custom',
  p_imap_host text DEFAULT NULL, p_imap_port integer DEFAULT 993, p_imap_secure boolean DEFAULT true,
  p_smtp_host text DEFAULT NULL, p_smtp_port integer DEFAULT 465, p_smtp_secure boolean DEFAULT true,
  p_encrypted_credentials_reference text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id uuid; v_account jsonb;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  INSERT INTO public.email_accounts (tenant_id, email_address, display_name, provider,
    imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, encrypted_credentials_reference)
  VALUES (v_tenant_id, p_email_address, p_display_name, p_provider,
    p_imap_host, p_imap_port, p_imap_secure, p_smtp_host, p_smtp_port, p_smtp_secure, p_encrypted_credentials_reference)
  RETURNING row_to_json(email_accounts.*) - 'encrypted_credentials_reference' - 'encrypted_credentials' INTO v_account;
  RETURN v_account;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_accounts_update(
  p_id uuid, p_email_address text DEFAULT NULL, p_display_name text DEFAULT NULL,
  p_imap_host text DEFAULT NULL, p_imap_port integer DEFAULT NULL, p_imap_secure boolean DEFAULT NULL,
  p_smtp_host text DEFAULT NULL, p_smtp_port integer DEFAULT NULL, p_smtp_secure boolean DEFAULT NULL,
  p_encrypted_credentials_reference text DEFAULT NULL, p_sync_enabled boolean DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id uuid; v_account jsonb;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  UPDATE public.email_accounts SET
    email_address = coalesce(p_email_address, email_address),
    display_name = coalesce(p_display_name, display_name),
    imap_host = coalesce(p_imap_host, imap_host), imap_port = coalesce(p_imap_port, imap_port),
    imap_secure = coalesce(p_imap_secure, imap_secure), smtp_host = coalesce(p_smtp_host, smtp_host),
    smtp_port = coalesce(p_smtp_port, smtp_port), smtp_secure = coalesce(p_smtp_secure, smtp_secure),
    encrypted_credentials_reference = coalesce(p_encrypted_credentials_reference, encrypted_credentials_reference),
    sync_enabled = coalesce(p_sync_enabled, sync_enabled), updated_at = now()
  WHERE id = p_id AND tenant_id = v_tenant_id
  RETURNING row_to_json(email_accounts.*) - 'encrypted_credentials_reference' - 'encrypted_credentials' INTO v_account;
  RETURN v_account;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_accounts_delete(p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  DELETE FROM public.email_accounts WHERE id = p_id AND tenant_id = v_tenant_id;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_accounts_set_sync_state(
  p_id uuid, p_sync_enabled boolean DEFAULT NULL, p_sync_folders jsonb DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  UPDATE public.email_accounts SET
    sync_enabled = coalesce(p_sync_enabled, sync_enabled),
    sync_folders = coalesce(p_sync_folders, sync_folders),
    last_synced_at = now(), updated_at = now()
  WHERE id = p_id AND tenant_id = v_tenant_id;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_messages_list(
  p_account_id uuid, p_folder text DEFAULT 'INBOX', p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0, p_search text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.email_accounts WHERE id = p_account_id AND tenant_id = v_tenant_id) THEN RAISE EXCEPTION 'Account not found'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(m)) FROM public.email_messages m
    WHERE m.account_id = p_account_id AND m.folder = p_folder AND m.is_draft = false
      AND (p_search IS NULL OR m.subject ILIKE '%' || p_search || '%' OR m.from_address ILIKE '%' || p_search || '%'
        OR m.from_name ILIKE '%' || p_search || '%' OR m.snippet ILIKE '%' || p_search || '%' OR m.text_body ILIKE '%' || p_search || '%')
    ORDER BY m.received_at DESC LIMIT p_limit OFFSET p_offset
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.email_messages_list_sent(
  p_account_id uuid, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.email_accounts WHERE id = p_account_id AND tenant_id = v_tenant_id) THEN RAISE EXCEPTION 'Account not found'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(m)) FROM public.email_messages m
    WHERE m.account_id = p_account_id AND m.folder = 'Sent' AND m.is_draft = false
    ORDER BY m.sent_at DESC NULLS LAST, m.created_at DESC LIMIT p_limit OFFSET p_offset
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.email_messages_list_drafts(
  p_account_id uuid, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.email_accounts WHERE id = p_account_id AND tenant_id = v_tenant_id) THEN RAISE EXCEPTION 'Account not found'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(d)) FROM public.email_drafts d
    WHERE d.account_id = p_account_id ORDER BY d.updated_at DESC LIMIT p_limit OFFSET p_offset
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.email_messages_list_starred(
  p_account_id uuid, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.email_accounts WHERE id = p_account_id AND tenant_id = v_tenant_id) THEN RAISE EXCEPTION 'Account not found'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(m)) FROM public.email_messages m
    WHERE m.account_id = p_account_id AND m.is_starred = true AND m.is_draft = false
    ORDER BY m.received_at DESC LIMIT p_limit OFFSET p_offset
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.email_messages_list_all(
  p_account_id uuid, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_search text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.email_accounts WHERE id = p_account_id AND tenant_id = v_tenant_id) THEN RAISE EXCEPTION 'Account not found'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(m)) FROM public.email_messages m
    WHERE m.account_id = p_account_id AND m.is_draft = false
      AND (p_search IS NULL OR m.subject ILIKE '%' || p_search || '%' OR m.from_address ILIKE '%' || p_search || '%'
        OR m.from_name ILIKE '%' || p_search || '%' OR m.snippet ILIKE '%' || p_search || '%' OR m.text_body ILIKE '%' || p_search || '%')
    ORDER BY m.received_at DESC LIMIT p_limit OFFSET p_offset
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.email_messages_get(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id uuid; v_message jsonb; v_attachments jsonb;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  SELECT row_to_json(m) INTO v_message FROM public.email_messages m
    JOIN public.email_accounts a ON a.id = m.account_id
    WHERE m.id = p_id AND a.tenant_id = v_tenant_id;
  IF v_message IS NULL THEN RETURN NULL; END IF;
  SELECT COALESCE(jsonb_agg(row_to_json(at)), '[]'::jsonb) INTO v_attachments
    FROM public.email_attachments at WHERE at.message_id = p_id;
  v_message := v_message || jsonb_build_object('attachments', v_attachments);
  RETURN v_message;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_messages_list_thread(p_thread_id text, p_account_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.email_accounts WHERE id = p_account_id AND tenant_id = v_tenant_id) THEN RAISE EXCEPTION 'Account not found'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(m) || jsonb_build_object('attachments', COALESCE((
      SELECT jsonb_agg(row_to_json(at)) FROM public.email_attachments at WHERE at.message_id = m.id
    ), '[]'::jsonb)) ORDER BY m.received_at ASC)
    FROM public.email_messages m WHERE m.account_id = p_account_id AND m.thread_id = p_thread_id AND m.is_draft = false
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.email_messages_mark_read(p_id uuid, p_is_read boolean DEFAULT true)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  UPDATE public.email_messages SET is_read = p_is_read, updated_at = now()
  WHERE id = p_id AND account_id IN (SELECT id FROM public.email_accounts WHERE tenant_id = v_tenant_id);
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_messages_mark_starred(p_id uuid, p_is_starred boolean DEFAULT true)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  UPDATE public.email_messages SET is_starred = p_is_starred, updated_at = now()
  WHERE id = p_id AND account_id IN (SELECT id FROM public.email_accounts WHERE tenant_id = v_tenant_id);
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_messages_move(p_id uuid, p_folder text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  UPDATE public.email_messages SET folder = p_folder, updated_at = now()
  WHERE id = p_id AND account_id IN (SELECT id FROM public.email_accounts WHERE tenant_id = v_tenant_id);
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_messages_delete(p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  DELETE FROM public.email_messages WHERE id = p_id
    AND account_id IN (SELECT id FROM public.email_accounts WHERE tenant_id = v_tenant_id);
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_messages_count(p_account_id uuid, p_folder text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id uuid; v_total integer; v_unread integer;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.email_accounts WHERE id = p_account_id AND tenant_id = v_tenant_id) THEN RAISE EXCEPTION 'Account not found'; END IF;
  SELECT count(*), count(*) FILTER (WHERE NOT is_read) INTO v_total, v_unread
  FROM public.email_messages WHERE account_id = p_account_id AND is_draft = false
    AND (p_folder IS NULL OR folder = p_folder);
  RETURN jsonb_build_object('total', v_total, 'unread', v_unread);
END;
$$;

CREATE OR REPLACE FUNCTION public.email_drafts_save(
  p_account_id uuid, p_id uuid DEFAULT NULL, p_thread_id text DEFAULT NULL,
  p_in_reply_to text DEFAULT NULL, p_references jsonb DEFAULT NULL,
  p_to_addresses jsonb DEFAULT '[]'::jsonb, p_cc_addresses jsonb DEFAULT '[]'::jsonb,
  p_bcc_addresses jsonb DEFAULT '[]'::jsonb, p_subject text DEFAULT NULL,
  p_text_body text DEFAULT NULL, p_html_body text DEFAULT NULL,
  p_attachments jsonb DEFAULT '[]'::jsonb, p_signature_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id uuid; v_draft jsonb;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.email_accounts WHERE id = p_account_id AND tenant_id = v_tenant_id) THEN RAISE EXCEPTION 'Account not found'; END IF;
  IF p_id IS NOT NULL THEN
    UPDATE public.email_drafts SET thread_id = coalesce(p_thread_id, thread_id),
      in_reply_to = coalesce(p_in_reply_to, in_reply_to), "references" = coalesce(p_references, "references"),
      to_addresses = p_to_addresses, cc_addresses = p_cc_addresses, bcc_addresses = p_bcc_addresses,
      subject = coalesce(p_subject, subject), text_body = coalesce(p_text_body, text_body),
      html_body = coalesce(p_html_body, html_body), attachments = p_attachments,
      signature_id = coalesce(p_signature_id, signature_id), updated_at = now()
    WHERE id = p_id AND account_id = p_account_id
    RETURNING row_to_json(email_drafts.*) INTO v_draft;
  ELSE
    INSERT INTO public.email_drafts (account_id, thread_id, in_reply_to, "references",
      to_addresses, cc_addresses, bcc_addresses, subject, text_body, html_body, attachments, signature_id)
    VALUES (p_account_id, p_thread_id, p_in_reply_to, p_references,
      p_to_addresses, p_cc_addresses, p_bcc_addresses, p_subject, p_text_body, p_html_body, p_attachments, p_signature_id)
    RETURNING row_to_json(email_drafts.*) INTO v_draft;
  END IF;
  RETURN v_draft;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_drafts_delete(p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  DELETE FROM public.email_drafts WHERE id = p_id
    AND account_id IN (SELECT id FROM public.email_accounts WHERE tenant_id = v_tenant_id);
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_signatures_list()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(s)) FROM public.email_signatures s
    WHERE s.tenant_id = v_tenant_id ORDER BY s.is_default DESC, s.name
  ), '[]'::jsonb);
END;
$$;

-- FIXED: p_name (required) BEFORE p_id (optional with default)
CREATE OR REPLACE FUNCTION public.email_signatures_save(
  p_name text, p_id uuid DEFAULT NULL, p_signature_html text DEFAULT NULL,
  p_signature_text text DEFAULT NULL, p_is_default boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id uuid; v_sig jsonb;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  IF p_is_default THEN UPDATE public.email_signatures SET is_default = false WHERE tenant_id = v_tenant_id; END IF;
  IF p_id IS NOT NULL THEN
    UPDATE public.email_signatures SET name = p_name,
      signature_html = coalesce(p_signature_html, signature_html),
      signature_text = coalesce(p_signature_text, signature_text),
      is_default = p_is_default, updated_at = now()
    WHERE id = p_id AND tenant_id = v_tenant_id
    RETURNING row_to_json(email_signatures.*) INTO v_sig;
  ELSE
    INSERT INTO public.email_signatures (user_id, tenant_id, name, signature_html, signature_text, is_default)
    VALUES (auth.uid(), v_tenant_id, p_name, p_signature_html, p_signature_text, p_is_default)
    RETURNING row_to_json(email_signatures.*) INTO v_sig;
  END IF;
  RETURN v_sig;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_signatures_delete(p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  DELETE FROM public.email_signatures WHERE id = p_id AND tenant_id = v_tenant_id;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_labels_list()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(l)) FROM public.email_labels l
    WHERE l.tenant_id = v_tenant_id ORDER BY l.name
  ), '[]'::jsonb);
END;
$$;

-- FIXED: p_name (required) BEFORE p_id (optional with default)
CREATE OR REPLACE FUNCTION public.email_labels_save(
  p_name text, p_id uuid DEFAULT NULL, p_color text DEFAULT '#6b7280'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id uuid; v_label jsonb;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  IF p_id IS NOT NULL THEN
    UPDATE public.email_labels SET name = p_name, color = p_color
    WHERE id = p_id AND tenant_id = v_tenant_id
    RETURNING row_to_json(email_labels.*) INTO v_label;
  ELSE
    INSERT INTO public.email_labels (tenant_id, name, color)
    VALUES (v_tenant_id, p_name, p_color)
    RETURNING row_to_json(email_labels.*) INTO v_label;
  END IF;
  RETURN v_label;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_labels_delete(p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  DELETE FROM public.email_labels WHERE id = p_id AND tenant_id = v_tenant_id;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_messages_set_labels(p_message_id uuid, p_label_ids jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id uuid; v_label_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  DELETE FROM public.email_message_labels WHERE message_id = p_message_id;
  FOR v_label_id IN SELECT jsonb_array_elements_text(p_label_ids)::uuid LOOP
    INSERT INTO public.email_message_labels (message_id, label_id) VALUES (p_message_id, v_label_id);
  END LOOP;
  RETURN true;
END;
$$;

-- ── 5. SECURITY FUNCTIONS ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.email_accounts_store_credentials(
  p_id uuid, p_encrypted_credentials text,
  p_connection_status text DEFAULT 'connected', p_connection_error text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  UPDATE public.email_accounts SET
    encrypted_credentials = p_encrypted_credentials,
    connection_status = p_connection_status, connection_error = p_connection_error,
    connection_tested_at = now(), updated_at = now()
  WHERE id = p_id AND tenant_id = v_tenant_id;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_accounts_get_credentials(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_account jsonb;
BEGIN
  SELECT row_to_json(a) INTO v_account FROM public.email_accounts a WHERE a.id = p_id;
  RETURN v_account;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_accounts_update_sync_state(
  p_id uuid, p_folder text, p_uid_validity integer DEFAULT NULL,
  p_last_uid integer DEFAULT NULL, p_last_synced_at timestamptz DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id uuid; v_folders jsonb;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  SELECT COALESCE(sync_folders, '[]'::jsonb) INTO v_folders
  FROM public.email_accounts WHERE id = p_id AND tenant_id = v_tenant_id;
  v_folders := (
    SELECT COALESCE(jsonb_agg(
      CASE WHEN e->>'name' = p_folder
        THEN e || jsonb_build_object('uid_validity', coalesce(p_uid_validity::text, e->>'uid_validity'),
          'last_uid', coalesce(p_last_uid::text, e->>'last_uid'))
        ELSE e END
    ), '[]'::jsonb) FROM jsonb_array_elements(v_folders) e
  );
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_folders) e WHERE e->>'name' = p_folder) THEN
    v_folders := v_folders || jsonb_build_object('name', p_folder,
      'uid_validity', p_uid_validity, 'last_uid', p_last_uid);
  END IF;
  UPDATE public.email_accounts SET sync_folders = v_folders,
    last_synced_at = coalesce(p_last_synced_at, now()), updated_at = now()
  WHERE id = p_id AND tenant_id = v_tenant_id;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_messages_mark_body_fetched(p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  UPDATE public.email_messages SET body_fetched = true, updated_at = now()
  WHERE id = p_id AND account_id IN (SELECT id FROM public.email_accounts WHERE tenant_id = v_tenant_id);
  RETURN FOUND;
END;
$$;

-- ── 6. STORAGE ──────────────────────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public)
VALUES ('email-attachments', 'email-attachments', false)
ON CONFLICT (id) DO NOTHING;

DO $$ BEGIN DROP POLICY IF EXISTS "email_attachments_storage_select" ON storage.objects; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "email_attachments_storage_insert" ON storage.objects; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "email_attachments_storage_delete" ON storage.objects; END $$;

CREATE POLICY "email_attachments_storage_select" ON storage.objects
  FOR SELECT USING (bucket_id = 'email-attachments'
    AND (storage.foldername(name))[1] IN (SELECT a.id::text FROM public.email_accounts a WHERE a.tenant_id = public.get_current_tenant_id()));
CREATE POLICY "email_attachments_storage_insert" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'email-attachments'
    AND (storage.foldername(name))[1] IN (SELECT a.id::text FROM public.email_accounts a WHERE a.tenant_id = public.get_current_tenant_id()));
CREATE POLICY "email_attachments_storage_delete" ON storage.objects
  FOR DELETE USING (bucket_id = 'email-attachments'
    AND (storage.foldername(name))[1] IN (SELECT a.id::text FROM public.email_accounts a WHERE a.tenant_id = public.get_current_tenant_id()));
