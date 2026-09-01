-- ==========================================================================
-- Atlas CRM — Resend Outreach Integration Tables
-- ==========================================================================
-- Creates: outreach_records, outreach_templates, outreach_suppression
-- All tables have tenant isolation via RLS and admin authorization checks.
-- ==========================================================================

-- ── Outreach Records ────────────────────────────────────────────────────
-- Tracks every outbound email sent through Atlas CRM (via Resend).

CREATE TABLE IF NOT EXISTS outreach_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(_id) ON DELETE CASCADE,
  created_by uuid NOT NULL,

  -- Recipient
  lead_id uuid,
  recipient_email text NOT NULL,
  recipient_name text,
  recipient_company text,

  -- Email content
  subject text NOT NULL,
  body text NOT NULL,
  html_body text,
  outreach_type text DEFAULT 'manual' CHECK (outreach_type IN (
    'manual', 'ai_generated', 'template', 'sequence', 'bulk'
  )),
  template_id uuid,

  -- Delivery tracking
  status text DEFAULT 'draft' CHECK (status IN (
    'draft', 'queued', 'sent', 'delivered', 'opened', 'clicked',
    'replied', 'bounced', 'failed', 'cancelled', 'sent-test'
  )),
  provider text DEFAULT 'resend',
  provider_message_id text,
  error_message text,

  -- Timestamps
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  replied_at timestamptz,
  bounced_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_outreach_records_tenant ON outreach_records(tenant_id);
CREATE INDEX IF NOT EXISTS idx_outreach_records_lead ON outreach_records(lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outreach_records_status ON outreach_records(status);
CREATE INDEX IF NOT EXISTS idx_outreach_records_email ON outreach_records(recipient_email);
CREATE INDEX IF NOT EXISTS idx_outreach_records_created ON outreach_records(created_at DESC);

-- ── Outreach Templates ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS outreach_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(_id) ON DELETE CASCADE,
  created_by uuid NOT NULL,

  name text NOT NULL,
  description text,
  subject text NOT NULL,
  body text NOT NULL,
  html_body text,
  stage text,
  variables text[],  -- e.g. ['first_name', 'company_name']

  is_active boolean DEFAULT true,
  use_count integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outreach_templates_tenant ON outreach_templates(tenant_id);

-- ── Outreach Suppression ────────────────────────────────────────────────
-- Global suppression list — emails here are NEVER sent through Atlas outreach.
-- Email is unique across all tenants (a bounced address is suppressed everywhere).

CREATE TABLE IF NOT EXISTS outreach_suppression (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  reason text DEFAULT 'manual' CHECK (reason IN (
    'manual', 'unsubscribed', 'bounced', 'complaint', 'invalid'
  )),
  added_by uuid,
  notes text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outreach_suppression_email ON outreach_suppression(email);

-- ── RLS Policies ────────────────────────────────────────────────────────

ALTER TABLE outreach_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_suppression ENABLE ROW LEVEL SECURITY;

-- outreach_records: tenant isolation
DROP POLICY IF EXISTS "outreach_records_tenant_isolation" ON outreach_records;
DROP POLICY IF EXISTS "outreach_records_tenant_isolation" ON outreach_records;
CREATE POLICY "outreach_records_tenant_isolation" ON outreach_records
  FOR ALL
  USING (
    tenant_id = public.get_current_tenant_id()
    OR public.is_super_admin()
  );

-- outreach_templates: tenant isolation
DROP POLICY IF EXISTS "outreach_templates_tenant_isolation" ON outreach_templates;
DROP POLICY IF EXISTS "outreach_templates_tenant_isolation" ON outreach_templates;
CREATE POLICY "outreach_templates_tenant_isolation" ON outreach_templates
  FOR ALL
  USING (
    tenant_id = public.get_current_tenant_id()
    OR public.is_super_admin()
  );

-- outreach_suppression: readable by all authenticated users, writable by admins
DROP POLICY IF EXISTS "outreach_suppression_read" ON outreach_suppression;
DROP POLICY IF EXISTS "outreach_suppression_read" ON outreach_suppression;
CREATE POLICY "outreach_suppression_read" ON outreach_suppression
  FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "outreach_suppression_admin_write" ON outreach_suppression;
DROP POLICY IF EXISTS "outreach_suppression_admin_write" ON outreach_suppression;
CREATE POLICY "outreach_suppression_admin_write" ON outreach_suppression
  FOR ALL
  USING (public.is_super_admin() OR public.is_atlas_admin());

-- ── RPCs ────────────────────────────────────────────────────────────────

-- outreach_records_list: list outreach records for a tenant, with lead info
CREATE OR REPLACE FUNCTION public.outreach_records_list(
  p_lead_id uuid DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid;
  v_result jsonb;
BEGIN
  v_tenant_id := public.get_current_tenant_id();

  SELECT jsonb_agg(row_to_json(r)) INTO v_result
  FROM (
    SELECT
      o.id, o.lead_id, o.recipient_email, o.recipient_name,
      o.recipient_company, o.subject, o.outreach_type, o.status,
      o.provider, o.provider_message_id, o.error_message,
      o.sent_at, o.delivered_at, o.opened_at, o.created_at,
      l.company_name, l.contact_name
    FROM outreach_records o
    LEFT JOIN public."crmLeads" l ON l._id = o.lead_id
    WHERE o.tenant_id = v_tenant_id
      AND (p_lead_id IS NULL OR o.lead_id = p_lead_id)
      AND (p_status IS NULL OR o.status = p_status)
    ORDER BY o.created_at DESC
    LIMIT p_limit OFFSET p_offset
  ) r;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

-- outreach_records_create: insert a new outreach record
CREATE OR REPLACE FUNCTION public.outreach_records_create(
  p_lead_id uuid,
  p_recipient_email text,
  p_recipient_name text,
  p_recipient_company text,
  p_subject text,
  p_body text,
  p_html_body text DEFAULT NULL,
  p_outreach_type text DEFAULT 'manual',
  p_template_id uuid DEFAULT NULL,
  p_status text DEFAULT 'sent',
  p_provider_message_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid;
  v_id uuid;
  v_result jsonb;
BEGIN
  v_tenant_id := public.get_current_tenant_id();

  INSERT INTO outreach_records (
    tenant_id, created_by, lead_id, recipient_email, recipient_name,
    recipient_company, subject, body, html_body, outreach_type,
    template_id, status, provider_message_id, sent_at
  ) VALUES (
    v_tenant_id, auth.uid(), p_lead_id, p_recipient_email, p_recipient_name,
    p_recipient_company, p_subject, p_body, p_html_body, p_outreach_type,
    p_template_id, p_status, p_provider_message_id,
    CASE WHEN p_status IN ('sent', 'sent-test') THEN now() ELSE NULL END
  )
  RETURNING id INTO v_id;

  SELECT row_to_json(r) INTO v_result
  FROM (
    SELECT id, status, sent_at, created_at
    FROM outreach_records WHERE id = v_id
  ) r;

  RETURN v_result;
END;
$$;

-- outreach_records_update_status: update delivery status (for webhook/callback)
CREATE OR REPLACE FUNCTION public.outreach_records_update_status(
  p_provider_message_id text,
  p_status text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE outreach_records
  SET
    status = p_status,
    updated_at = now(),
    delivered_at = CASE WHEN p_status = 'delivered' THEN now() ELSE delivered_at END,
    opened_at = CASE WHEN p_status = 'opened' THEN now() ELSE opened_at END,
    clicked_at = CASE WHEN p_status = 'clicked' THEN now() ELSE clicked_at END,
    replied_at = CASE WHEN p_status = 'replied' THEN now() ELSE replied_at END,
    bounced_at = CASE WHEN p_status = 'bounced' THEN now() ELSE bounced_at END,
    failed_at = CASE WHEN p_status = 'failed' THEN now() ELSE failed_at END
  WHERE provider_message_id = p_provider_message_id
    AND status NOT IN ('cancelled');

  RETURN FOUND;
END;
$$;

-- outreach_templates_list: list templates for a tenant
CREATE OR REPLACE FUNCTION public.outreach_templates_list(
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid;
  v_result jsonb;
BEGIN
  v_tenant_id := public.get_current_tenant_id();

  SELECT jsonb_agg(row_to_json(r)) INTO v_result
  FROM (
    SELECT id, name, description, subject, body, stage, variables,
           is_active, use_count, created_at
    FROM outreach_templates
    WHERE tenant_id = v_tenant_id AND is_active = true
    ORDER BY created_at DESC
    LIMIT p_limit
  ) r;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

-- outreach_templates_create: create a new template
CREATE OR REPLACE FUNCTION public.outreach_templates_create(
  p_name text,
  p_subject text,
  p_body text,
  p_description text DEFAULT NULL,
  p_stage text DEFAULT NULL,
  p_html_body text DEFAULT NULL,
  p_variables text[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid;
  v_id uuid;
  v_result jsonb;
BEGIN
  v_tenant_id := public.get_current_tenant_id();

  INSERT INTO outreach_templates (
    tenant_id, created_by, name, description, subject, body, html_body, stage, variables
  ) VALUES (
    v_tenant_id, auth.uid(), p_name, p_description, p_subject, p_body,
    p_html_body, p_stage, p_variables
  )
  RETURNING id INTO v_id;

  SELECT row_to_json(r) INTO v_result
  FROM (
    SELECT id, name, subject, body, stage, created_at
    FROM outreach_templates WHERE id = v_id
  ) r;

  RETURN v_result;
END;
$$;

-- outreach_templates_delete: soft-delete a template
CREATE OR REPLACE FUNCTION public.outreach_templates_delete(
  p_template_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid;
BEGIN
  v_tenant_id := public.get_current_tenant_id();

  UPDATE outreach_templates
  SET is_active = false, updated_at = now()
  WHERE id = p_template_id AND tenant_id = v_tenant_id;

  RETURN FOUND;
END;
$$;

-- outreach_stats: summary stats for the outreach center
CREATE OR REPLACE FUNCTION public.outreach_stats()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid;
  v_result jsonb;
BEGIN
  v_tenant_id := public.get_current_tenant_id();

  SELECT jsonb_build_object(
    'total', COUNT(*),
    'sent', COUNT(*) FILTER (WHERE status IN ('sent', 'sent-test', 'delivered')),
    'opened', COUNT(*) FILTER (WHERE status = 'opened'),
    'replied', COUNT(*) FILTER (WHERE status = 'replied'),
    'bounced', COUNT(*) FILTER (WHERE status = 'bounced'),
    'failed', COUNT(*) FILTER (WHERE status = 'failed'),
    'drafts', COUNT(*) FILTER (WHERE status = 'draft')
  ) INTO v_result
  FROM outreach_records
  WHERE tenant_id = v_tenant_id;

  RETURN v_result;
END;
$$;
