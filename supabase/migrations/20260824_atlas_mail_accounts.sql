-- ==========================================================================
-- Atlas Mail — Add missing columns + RPCs for email accounts/messages
-- Migration: 20260824_atlas_mail_accounts.sql
--
-- IMPORTANT: The 20260820_atlas_mail_combined.sql migration already created
-- the email_accounts, email_messages, email_drafts, email_labels, and
-- email_message_labels tables. That migration's email_messages and
-- email_drafts do NOT have a tenant_id column — they use account_id to
-- resolve tenant via email_accounts.
--
-- This migration:
--   1. Adds tenant_id to email_messages and email_drafts (denormalized for
--      direct RLS and simpler RPC queries)
--   2. Backfills tenant_id from email_accounts
--   3. Adds missing columns to email_accounts (jsonb credentials, etc.)
--   4. Adds missing columns to email_messages (body_fetched, etc.)
--   5. Recreates RLS policies to use the new tenant_id columns
--   6. Creates all RPC functions using get_current_tenant_id()
-- ==========================================================================

-- ── 1. Add tenant_id to email_messages ──────────────────────────────────

DO $$ BEGIN
  ALTER TABLE public.email_messages ADD COLUMN IF NOT EXISTS tenant_id uuid;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Backfill tenant_id from email_accounts
UPDATE public.email_messages m
SET tenant_id = a.tenant_id
FROM public.email_accounts a
WHERE m.account_id = a.id AND m.tenant_id IS NULL;

-- Make NOT NULL after backfill (skip if no rows exist yet)
DO $$ BEGIN
  ALTER TABLE public.email_messages ALTER COLUMN tenant_id SET NOT NULL;
EXCEPTION WHEN others THEN NULL;
END $$;

-- ── 2. Add tenant_id to email_drafts ────────────────────────────────────

DO $$ BEGIN
  ALTER TABLE public.email_drafts ADD COLUMN IF NOT EXISTS tenant_id uuid;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Backfill tenant_id from email_accounts
UPDATE public.email_drafts d
SET tenant_id = a.tenant_id
FROM public.email_accounts a
WHERE d.account_id = a.id AND d.tenant_id IS NULL;

DO $$ BEGIN
  ALTER TABLE public.email_drafts ALTER COLUMN tenant_id SET NOT NULL;
EXCEPTION WHEN others THEN NULL;
END $$;

-- ── 3. Add missing columns to email_accounts ────────────────────────────

DO $$ BEGIN
  ALTER TABLE public.email_accounts ADD COLUMN IF NOT EXISTS encrypted_credentials jsonb;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.email_accounts ADD COLUMN IF NOT EXISTS connection_status text DEFAULT 'untested';
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
  ALTER TABLE public.email_accounts ADD COLUMN IF NOT EXISTS sync_folders text[] DEFAULT '{}';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- ── 4. Add missing columns to email_messages ────────────────────────────

DO $$ BEGIN
  ALTER TABLE public.email_messages ADD COLUMN IF NOT EXISTS body_fetched boolean DEFAULT false;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.email_messages ADD COLUMN IF NOT EXISTS uid_validity bigint;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.email_messages ADD COLUMN IF NOT EXISTS last_uid bigint;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- ── 5. Rename references column if it exists as quoted identifier ───────
-- (The earlier migration used "references" with quotes — rename to safe name)

DO $$ BEGIN
  ALTER TABLE public.email_messages RENAME COLUMN "references" TO message_references;
EXCEPTION WHEN undefined_column THEN NULL; -- column may not exist
          WHEN duplicate_column THEN NULL; -- already renamed
END $$;

DO $$ BEGIN
  ALTER TABLE public.email_drafts RENAME COLUMN "references" TO message_references;
EXCEPTION WHEN undefined_column THEN NULL;
          WHEN duplicate_column THEN NULL;
END $$;

-- ── 6. Add indexes ─────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_email_messages_tenant ON public.email_messages(tenant_id);
CREATE INDEX IF NOT EXISTS idx_email_messages_folder ON public.email_messages(account_id, folder);
CREATE INDEX IF NOT EXISTS idx_email_messages_thread ON public.email_messages(account_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_email_drafts_tenant ON public.email_drafts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_email_drafts_account ON public.email_drafts(account_id);
CREATE INDEX IF NOT EXISTS idx_email_labels_tenant ON public.email_labels(tenant_id);

-- ── 7. RLS policies (drop and recreate with tenant_id on messages/drafts)

ALTER TABLE public.email_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_message_labels ENABLE ROW LEVEL SECURITY;

-- Messages — use tenant_id directly (denormalized)
DROP POLICY IF EXISTS "email_messages_select" ON public.email_messages;
DROP POLICY IF EXISTS "email_messages_insert" ON public.email_messages;
DROP POLICY IF EXISTS "email_messages_update" ON public.email_messages;
DROP POLICY IF EXISTS "email_messages_delete" ON public.email_messages;

DROP POLICY IF EXISTS "email_messages_select" ON public.email_messages;
CREATE POLICY "email_messages_select" ON public.email_messages
  FOR SELECT USING (tenant_id = public.get_current_tenant_id());
DROP POLICY IF EXISTS "email_messages_insert" ON public.email_messages;
CREATE POLICY "email_messages_insert" ON public.email_messages
  FOR INSERT WITH CHECK (tenant_id = public.get_current_tenant_id());
DROP POLICY IF EXISTS "email_messages_update" ON public.email_messages;
CREATE POLICY "email_messages_update" ON public.email_messages
  FOR UPDATE USING (tenant_id = public.get_current_tenant_id());
DROP POLICY IF EXISTS "email_messages_delete" ON public.email_messages;
CREATE POLICY "email_messages_delete" ON public.email_messages
  FOR DELETE USING (tenant_id = public.get_current_tenant_id());

-- Drafts — use tenant_id directly (denormalized)
DROP POLICY IF EXISTS "email_drafts_select" ON public.email_drafts;
DROP POLICY IF EXISTS "email_drafts_insert" ON public.email_drafts;
DROP POLICY IF EXISTS "email_drafts_update" ON public.email_drafts;
DROP POLICY IF EXISTS "email_drafts_delete" ON public.email_drafts;

DROP POLICY IF EXISTS "email_drafts_select" ON public.email_drafts;
CREATE POLICY "email_drafts_select" ON public.email_drafts
  FOR SELECT USING (tenant_id = public.get_current_tenant_id());
DROP POLICY IF EXISTS "email_drafts_insert" ON public.email_drafts;
CREATE POLICY "email_drafts_insert" ON public.email_drafts
  FOR INSERT WITH CHECK (tenant_id = public.get_current_tenant_id());
DROP POLICY IF EXISTS "email_drafts_update" ON public.email_drafts;
CREATE POLICY "email_drafts_update" ON public.email_drafts
  FOR UPDATE USING (tenant_id = public.get_current_tenant_id());
DROP POLICY IF EXISTS "email_drafts_delete" ON public.email_drafts;
CREATE POLICY "email_drafts_delete" ON public.email_drafts
  FOR DELETE USING (tenant_id = public.get_current_tenant_id());

-- Labels — already has tenant_id, recreate policies
DROP POLICY IF EXISTS "email_labels_select" ON public.email_labels;
DROP POLICY IF EXISTS "email_labels_insert" ON public.email_labels;
DROP POLICY IF EXISTS "email_labels_delete" ON public.email_labels;

DROP POLICY IF EXISTS "email_labels_select" ON public.email_labels;
CREATE POLICY "email_labels_select" ON public.email_labels
  FOR SELECT USING (tenant_id = public.get_current_tenant_id());
DROP POLICY IF EXISTS "email_labels_insert" ON public.email_labels;
CREATE POLICY "email_labels_insert" ON public.email_labels
  FOR INSERT WITH CHECK (tenant_id = public.get_current_tenant_id());
DROP POLICY IF EXISTS "email_labels_delete" ON public.email_labels;
CREATE POLICY "email_labels_delete" ON public.email_labels
  FOR DELETE USING (tenant_id = public.get_current_tenant_id());

-- Message labels — join through messages to resolve tenant
DROP POLICY IF EXISTS "email_message_labels_select" ON public.email_message_labels;
DROP POLICY IF EXISTS "email_message_labels_insert" ON public.email_message_labels;
DROP POLICY IF EXISTS "email_message_labels_delete" ON public.email_message_labels;

DROP POLICY IF EXISTS "email_message_labels_select" ON public.email_message_labels;
CREATE POLICY "email_message_labels_select" ON public.email_message_labels
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.email_messages m
    WHERE m.id = email_message_labels.message_id AND m.tenant_id = public.get_current_tenant_id()
  ));
DROP POLICY IF EXISTS "email_message_labels_insert" ON public.email_message_labels;
CREATE POLICY "email_message_labels_insert" ON public.email_message_labels
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM public.email_messages m
    WHERE m.id = email_message_labels.message_id AND m.tenant_id = public.get_current_tenant_id()
  ));
DROP POLICY IF EXISTS "email_message_labels_delete" ON public.email_message_labels;
CREATE POLICY "email_message_labels_delete" ON public.email_message_labels
  FOR DELETE USING (EXISTS (
    SELECT 1 FROM public.email_messages m
    WHERE m.id = email_message_labels.message_id AND m.tenant_id = public.get_current_tenant_id()
  ));


-- ══════════════════════════════════════════════════════════════════════════
-- RPC FUNCTIONS
-- Uses get_current_tenant_id() (from 20260820 migration) for tenant scoping
-- ══════════════════════════════════════════════════════════════════════════

-- ── Email Accounts ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.email_accounts_list()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant uuid;
BEGIN
  v_tenant := public.get_current_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(a.*) ORDER BY a.created_at DESC)
    FROM public.email_accounts a
    WHERE a.tenant_id = v_tenant
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.email_accounts_create(
  p_email_address text,
  p_display_name text DEFAULT NULL,
  p_provider text DEFAULT 'custom',
  p_imap_host text DEFAULT NULL,
  p_imap_port integer DEFAULT 993,
  p_imap_secure boolean DEFAULT true,
  p_smtp_host text DEFAULT NULL,
  p_smtp_port integer DEFAULT 465,
  p_smtp_secure boolean DEFAULT true
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant uuid; v_account jsonb;
BEGIN
  v_tenant := public.get_current_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;

  INSERT INTO public.email_accounts (
    tenant_id, created_by, email_address, display_name, provider,
    imap_host, imap_port, imap_secure,
    smtp_host, smtp_port, smtp_secure,
    connection_status
  ) VALUES (
    v_tenant, auth.uid(), p_email_address, p_display_name, p_provider,
    p_imap_host, p_imap_port, p_imap_secure,
    p_smtp_host, p_smtp_port, p_smtp_secure,
    'untested'
  )
  RETURNING row_to_json(email_accounts.*) INTO v_account;

  RETURN v_account;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_accounts_update(
  p_id uuid,
  p_email_address text DEFAULT NULL,
  p_display_name text DEFAULT NULL,
  p_imap_host text DEFAULT NULL,
  p_imap_port integer DEFAULT NULL,
  p_imap_secure boolean DEFAULT NULL,
  p_smtp_host text DEFAULT NULL,
  p_smtp_port integer DEFAULT NULL,
  p_smtp_secure boolean DEFAULT NULL,
  p_sync_enabled boolean DEFAULT NULL,
  p_sync_folders text DEFAULT NULL,
  p_connection_status text DEFAULT NULL,
  p_connection_error text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant uuid; v_account jsonb;
BEGIN
  v_tenant := public.get_current_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;

  UPDATE public.email_accounts SET
    email_address = COALESCE(p_email_address, email_address),
    display_name = COALESCE(p_display_name, display_name),
    imap_host = COALESCE(p_imap_host, imap_host),
    imap_port = COALESCE(p_imap_port, imap_port),
    imap_secure = COALESCE(p_imap_secure, imap_secure),
    smtp_host = COALESCE(p_smtp_host, smtp_host),
    smtp_port = COALESCE(p_smtp_port, smtp_port),
    smtp_secure = COALESCE(p_smtp_secure, smtp_secure),
    sync_enabled = COALESCE(p_sync_enabled, sync_enabled),
    sync_folders = COALESCE(
      CASE WHEN p_sync_folders IS NOT NULL THEN string_to_array(p_sync_folders, ',') END,
      sync_folders
    ),
    connection_status = COALESCE(p_connection_status, connection_status),
    connection_error = p_connection_error,
    updated_at = now()
  WHERE id = p_id AND tenant_id = v_tenant
  RETURNING row_to_json(email_accounts.*) INTO v_account;

  IF v_account IS NULL THEN RAISE EXCEPTION 'Account not found'; END IF;
  RETURN v_account;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_accounts_delete(p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant uuid;
BEGIN
  v_tenant := public.get_current_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  DELETE FROM public.email_accounts WHERE id = p_id AND tenant_id = v_tenant;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_accounts_set_sync_state(
  p_id uuid,
  p_sync_enabled boolean DEFAULT NULL,
  p_sync_folders text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant uuid;
BEGIN
  v_tenant := public.get_current_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  UPDATE public.email_accounts SET
    sync_enabled = COALESCE(p_sync_enabled, sync_enabled),
    sync_folders = COALESCE(
      CASE WHEN p_sync_folders IS NOT NULL THEN string_to_array(p_sync_folders, ',') END,
      sync_folders
    ),
    updated_at = now()
  WHERE id = p_id AND tenant_id = v_tenant;
  RETURN FOUND;
END;
$$;

-- ── Email Messages ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.email_messages_list(
  p_account_id uuid,
  p_folder text DEFAULT 'INBOX',
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_search text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant uuid;
BEGIN
  v_tenant := public.get_current_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(m.*) ORDER BY m.received_at DESC NULLS LAST)
    FROM public.email_messages m
    WHERE m.tenant_id = v_tenant
      AND m.account_id = p_account_id
      AND m.folder = p_folder
      AND (p_search IS NULL OR m.subject ILIKE '%' || p_search || '%'
           OR m.from_name ILIKE '%' || p_search || '%'
           OR m.from_address ILIKE '%' || p_search || '%')
    LIMIT p_limit OFFSET p_offset
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.email_messages_list_sent(
  p_account_id uuid,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant uuid;
BEGIN
  v_tenant := public.get_current_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(m.*) ORDER BY m.sent_at DESC NULLS LAST)
    FROM public.email_messages m
    WHERE m.tenant_id = v_tenant
      AND m.account_id = p_account_id
      AND m.folder = 'Sent'
    LIMIT p_limit OFFSET p_offset
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.email_messages_list_drafts(
  p_account_id uuid,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant uuid;
BEGIN
  v_tenant := public.get_current_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(d.*) ORDER BY d.updated_at DESC)
    FROM public.email_drafts d
    WHERE d.tenant_id = v_tenant
      AND d.account_id = p_account_id
    LIMIT p_limit OFFSET p_offset
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.email_messages_list_starred(
  p_account_id uuid,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant uuid;
BEGIN
  v_tenant := public.get_current_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(m.*) ORDER BY m.received_at DESC NULLS LAST)
    FROM public.email_messages m
    WHERE m.tenant_id = v_tenant
      AND m.account_id = p_account_id
      AND m.is_starred = true
    LIMIT p_limit OFFSET p_offset
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.email_messages_list_all(
  p_account_id uuid,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_search text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant uuid;
BEGIN
  v_tenant := public.get_current_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(m.*) ORDER BY m.received_at DESC NULLS LAST)
    FROM public.email_messages m
    WHERE m.tenant_id = v_tenant
      AND m.account_id = p_account_id
      AND (p_search IS NULL OR m.subject ILIKE '%' || p_search || '%'
           OR m.from_name ILIKE '%' || p_search || '%'
           OR m.from_address ILIKE '%' || p_search || '%'
           OR m.snippet ILIKE '%' || p_search || '%')
    LIMIT p_limit OFFSET p_offset
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.email_messages_get(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant uuid; v_msg jsonb;
BEGIN
  v_tenant := public.get_current_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;

  SELECT row_to_json(m.*) INTO v_msg
  FROM public.email_messages m
  WHERE m.id = p_id AND m.tenant_id = v_tenant;

  IF v_msg IS NULL THEN RETURN NULL; END IF;

  RETURN jsonb_build_object(
    'message', v_msg,
    'attachments', '[]'::jsonb
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.email_messages_list_thread(
  p_thread_id text,
  p_account_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant uuid;
BEGIN
  v_tenant := public.get_current_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(m.*) ORDER BY m.received_at ASC NULLS LAST)
    FROM public.email_messages m
    WHERE m.tenant_id = v_tenant
      AND m.account_id = p_account_id
      AND m.thread_id = p_thread_id
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.email_messages_mark_read(
  p_id uuid,
  p_is_read boolean DEFAULT true
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant uuid;
BEGIN
  v_tenant := public.get_current_tenant_id();
  UPDATE public.email_messages SET is_read = p_is_read
  WHERE id = p_id AND tenant_id = v_tenant;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_messages_mark_starred(
  p_id uuid,
  p_is_starred boolean DEFAULT true
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant uuid;
BEGIN
  v_tenant := public.get_current_tenant_id();
  UPDATE public.email_messages SET is_starred = p_is_starred
  WHERE id = p_id AND tenant_id = v_tenant;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_messages_move(
  p_id uuid,
  p_folder text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant uuid;
BEGIN
  v_tenant := public.get_current_tenant_id();
  UPDATE public.email_messages SET folder = p_folder
  WHERE id = p_id AND tenant_id = v_tenant;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_messages_delete(p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant uuid;
BEGIN
  v_tenant := public.get_current_tenant_id();
  DELETE FROM public.email_messages
  WHERE id = p_id AND tenant_id = v_tenant;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_messages_count(
  p_account_id uuid,
  p_folder text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant uuid; v_total integer; v_unread integer;
BEGIN
  v_tenant := public.get_current_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;

  SELECT count(*) INTO v_total
  FROM public.email_messages
  WHERE tenant_id = v_tenant AND account_id = p_account_id
    AND (p_folder IS NULL OR folder = p_folder);

  SELECT count(*) INTO v_unread
  FROM public.email_messages
  WHERE tenant_id = v_tenant AND account_id = p_account_id
    AND (p_folder IS NULL OR folder = p_folder)
    AND is_read = false;

  RETURN jsonb_build_object('total', v_total, 'unread', v_unread);
END;
$$;

CREATE OR REPLACE FUNCTION public.email_messages_set_labels(
  p_message_id uuid,
  p_label_ids text DEFAULT '[]'
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant uuid; v_label_ids uuid[];
BEGIN
  v_tenant := public.get_current_tenant_id();

  DELETE FROM public.email_message_labels WHERE message_id = p_message_id;

  IF p_label_ids != '[]' THEN
    v_label_ids := string_to_array(replace(replace(p_label_ids, '[', ''), ']', ''), ',')::uuid[];
    INSERT INTO public.email_message_labels (message_id, label_id)
    SELECT p_message_id, unnest(v_label_ids);
  END IF;

  RETURN true;
END;
$$;

-- ── Email Drafts ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.email_drafts_save(
  p_account_id uuid,
  p_id uuid DEFAULT NULL,
  p_thread_id text DEFAULT NULL,
  p_in_reply_to text DEFAULT NULL,
  p_references text DEFAULT NULL,
  p_to_addresses text DEFAULT '[]',
  p_cc_addresses text DEFAULT '[]',
  p_bcc_addresses text DEFAULT '[]',
  p_subject text DEFAULT NULL,
  p_text_body text DEFAULT NULL,
  p_html_body text DEFAULT NULL,
  p_attachments text DEFAULT '[]',
  p_signature_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant uuid; v_draft jsonb;
BEGIN
  v_tenant := public.get_current_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;

  IF p_id IS NOT NULL THEN
    UPDATE public.email_drafts SET
      thread_id = COALESCE(p_thread_id, thread_id),
      in_reply_to = COALESCE(p_in_reply_to, in_reply_to),
      message_references = COALESCE(
        CASE WHEN p_references IS NOT NULL THEN string_to_array(replace(replace(replace(p_references, '[', ''), ']', ''), '"', ''), ',') END,
        message_references
      ),
      to_addresses = COALESCE(p_to_addresses::jsonb, to_addresses),
      cc_addresses = COALESCE(p_cc_addresses::jsonb, cc_addresses),
      bcc_addresses = COALESCE(p_bcc_addresses::jsonb, bcc_addresses),
      subject = COALESCE(p_subject, subject),
      text_body = COALESCE(p_text_body, text_body),
      html_body = COALESCE(p_html_body, html_body),
      attachments = COALESCE(p_attachments::jsonb, attachments),
      signature_id = COALESCE(p_signature_id, signature_id),
      updated_at = now()
    WHERE id = p_id AND tenant_id = v_tenant
    RETURNING row_to_json(email_drafts.*) INTO v_draft;
  ELSE
    INSERT INTO public.email_drafts (
      tenant_id, account_id, thread_id, in_reply_to, message_references,
      to_addresses, cc_addresses, bcc_addresses,
      subject, text_body, html_body, attachments, signature_id
    ) VALUES (
      v_tenant, p_account_id, p_thread_id, p_in_reply_to,
      CASE WHEN p_references IS NOT NULL THEN string_to_array(replace(replace(replace(p_references, '[', ''), ']', ''), '"', ''), ',') END,
      p_to_addresses::jsonb, p_cc_addresses::jsonb, p_bcc_addresses::jsonb,
      p_subject, p_text_body, p_html_body, p_attachments::jsonb, p_signature_id
    )
    RETURNING row_to_json(email_drafts.*) INTO v_draft;
  END IF;

  RETURN v_draft;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_drafts_delete(p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant uuid;
BEGIN
  v_tenant := public.get_current_tenant_id();
  DELETE FROM public.email_drafts WHERE id = p_id AND tenant_id = v_tenant;
  RETURN FOUND;
END;
$$;

-- ── Email Labels ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.email_labels_list()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant uuid;
BEGIN
  v_tenant := public.get_current_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(l.*) ORDER BY l.name)
    FROM public.email_labels l WHERE l.tenant_id = v_tenant
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.email_labels_save(
  p_name text,
  p_id uuid DEFAULT NULL,
  p_color text DEFAULT '#6b7280'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant uuid; v_label jsonb;
BEGIN
  v_tenant := public.get_current_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;

  IF p_id IS NOT NULL THEN
    UPDATE public.email_labels SET name = p_name, color = p_color
    WHERE id = p_id AND tenant_id = v_tenant
    RETURNING row_to_json(email_labels.*) INTO v_label;
  ELSE
    INSERT INTO public.email_labels (tenant_id, name, color)
    VALUES (v_tenant, p_name, p_color)
    RETURNING row_to_json(email_labels.*) INTO v_label;
  END IF;
  RETURN v_label;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_labels_delete(p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant uuid;
BEGIN
  v_tenant := public.get_current_tenant_id();
  DELETE FROM public.email_labels WHERE id = p_id AND tenant_id = v_tenant;
  RETURN FOUND;
END;
$$;

-- ── Verify ──────────────────────────────────────────────────────────────
SELECT 'Atlas Mail columns added and RPCs created' as status;
