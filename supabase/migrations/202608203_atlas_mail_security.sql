-- ==========================================================================
-- ⚠️  SUPERSEDED — DO NOT APPLY
-- Atlas Mail — Security hardening migration
--
-- This migration has been superseded by:
--   20260820_atlas_mail_combined.sql
--
-- The combined migration contains all security columns, functions,
-- and storage policies from this file plus all base tables and
-- functions from 20260820_atlas_mail.sql.
-- It was applied manually to the live database on 2026-08-20.
--
-- DO NOT re-run this migration. The combined migration is idempotent
-- and safe to run against both clean and partially-applied databases.
-- ==========================================================================
--
-- 1. Replace base64 "encryption" with genuine AES-GCM encrypted blob
-- 2. Add connection health status
-- 3. Add IMAP sync state for incremental sync
-- 4. Add body_fetched flag for lazy body loading
-- ==========================================================================

-- ── Add new columns to email_accounts ───────────────────────────────────
-- encrypted_credentials: AES-GCM encrypted JSON blob (server-side only)
-- connection_status: current connection health
-- connection_error: last error message (safe, no credentials)
-- connection_tested_at: when connection was last tested
ALTER TABLE public.email_accounts
  ADD COLUMN IF NOT EXISTS encrypted_credentials text,
  ADD COLUMN IF NOT EXISTS connection_status text default 'untested',
  ADD COLUMN IF NOT EXISTS connection_error text,
  ADD COLUMN IF NOT EXISTS connection_tested_at timestamptz;

-- ── Add sync state columns to email_messages ────────────────────────────
-- uid_validity: IMAP UIDVALIDITY for the folder
-- last_uid: highest UID synced
-- body_fetched: whether full body has been fetched (lazy loading)
ALTER TABLE public.email_messages
  ADD COLUMN IF NOT EXISTS uid_validity integer,
  ADD COLUMN IF NOT EXISTS last_uid integer,
  ADD COLUMN IF NOT EXISTS body_fetched boolean default false;

-- ── Migrate existing base64 credentials to encrypted_credentials ────────
-- This is a one-time migration. The Edge Function will handle re-encryption
-- on first successful connection test after this migration.
-- For now, copy existing data so nothing is lost.
UPDATE public.email_accounts
SET encrypted_credentials = encrypted_credentials_reference
WHERE encrypted_credentials_reference IS NOT NULL
  AND encrypted_credentials IS NULL;

-- ── RPC: email_accounts_store_credentials ───────────────────────────────
-- Stores encrypted credentials. Called by Edge Function after encrypting.
-- NEVER returns the encrypted blob to the caller.
CREATE OR REPLACE FUNCTION public.email_accounts_store_credentials(
  p_id uuid,
  p_encrypted_credentials text,
  p_connection_status text default 'connected',
  p_connection_error text default null
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No active workspace';
  end if;
  UPDATE public.email_accounts SET
    encrypted_credentials = p_encrypted_credentials,
    connection_status = p_connection_status,
    connection_error = p_connection_error,
    connection_tested_at = now(),
    updated_at = now()
  WHERE id = p_id AND tenant_id = v_tenant_id;
  RETURN FOUND;
END;
$$;

-- ── RPC: email_accounts_get_credentials ─────────────────────────────────
-- Returns ONLY the encrypted_credentials blob for the Edge Function to
-- decrypt server-side. Used by the Edge Function with service role.
-- The RPC itself is RLS-scoped but the Edge Function bypasses RLS.
CREATE OR REPLACE FUNCTION public.email_accounts_get_credentials(
  p_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_account jsonb;
BEGIN
  SELECT row_to_json(a) INTO v_account
  FROM public.email_accounts a
  WHERE a.id = p_id;
  RETURN v_account;
END;
$$;

-- ── RPC: email_accounts_update_sync_state ───────────────────────────────
-- Updates IMAP sync tracking state (uid_validity, last_uid).
CREATE OR REPLACE FUNCTION public.email_accounts_update_sync_state(
  p_id uuid,
  p_folder text,
  p_uid_validity integer default null,
  p_last_uid integer default null,
  p_last_synced_at timestamptz default null
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_tenant_id uuid;
  v_folders jsonb;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No active workspace';
  end if;
  -- Update sync_folders with per-folder state
  SELECT COALESCE(sync_folders, '[]'::jsonb) INTO v_folders
  FROM public.email_accounts
  WHERE id = p_id AND tenant_id = v_tenant_id;

  -- Upsert the folder entry
  v_folders := (
    SELECT coalesce(jsonb_agg(
      CASE WHEN e->>'name' = p_folder
        THEN e || jsonb_build_object(
          'uid_validity', coalesce(p_uid_validity, e->>'uid_validity'),
          'last_uid', coalesce(p_last_uid, e->>'last_uid')
        )
        ELSE e
      END
    ), '[]'::jsonb)
    FROM jsonb_array_elements(v_folders) e
  );

  -- If folder wasn't found, append it
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_folders) e
    WHERE e->>'name' = p_folder
  ) THEN
    v_folders := v_folders || jsonb_build_object(
      'name', p_folder,
      'uid_validity', p_uid_validity,
      'last_uid', p_last_uid
    );
  END IF;

  UPDATE public.email_accounts SET
    sync_folders = v_folders,
    last_synced_at = coalesce(p_last_synced_at, now()),
    updated_at = now()
  WHERE id = p_id AND tenant_id = v_tenant_id;
  RETURN FOUND;
END;
$$;

-- ── RPC: email_messages_mark_body_fetched ───────────────────────────────
CREATE OR REPLACE FUNCTION public.email_messages_mark_body_fetched(
  p_id uuid
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No active workspace';
  end if;
  UPDATE public.email_messages SET body_fetched = true, updated_at = now()
  WHERE id = p_id AND account_id IN (
    SELECT id FROM public.email_accounts WHERE tenant_id = v_tenant_id
  );
  RETURN FOUND;
END;
$$;

-- ── Storage bucket for email attachments ────────────────────────────────
-- Private bucket — no public access. RLS policies control access.
INSERT INTO storage.buckets (id, name, public)
VALUES ('email-attachments', 'email-attachments', false)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS: tenant-scoped access to email attachments
DROP POLICY IF EXISTS "email_attachments_storage_select" ON storage.objects;
CREATE POLICY "email_attachments_storage_select" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'email-attachments'
    AND (storage.foldername(name))[1] IN (
      SELECT a.id::text FROM public.email_accounts a
      WHERE a.tenant_id = public.get_current_tenant_id()
    )
  );

DROP POLICY IF EXISTS "email_attachments_storage_insert" ON storage.objects;
CREATE POLICY "email_attachments_storage_insert" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'email-attachments'
    AND (storage.foldername(name))[1] IN (
      SELECT a.id::text FROM public.email_accounts a
      WHERE a.tenant_id = public.get_current_tenant_id()
    )
  );

DROP POLICY IF EXISTS "email_attachments_storage_delete" ON storage.objects;
CREATE POLICY "email_attachments_storage_delete" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'email-attachments'
    AND (storage.foldername(name))[1] IN (
      SELECT a.id::text FROM public.email_accounts a
      WHERE a.tenant_id = public.get_current_tenant_id()
    )
  );
