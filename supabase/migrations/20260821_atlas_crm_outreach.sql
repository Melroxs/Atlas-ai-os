-- ==========================================================================
-- Atlas CRM + Outreach + Pilot Management
-- Migration: 20260821_atlas_crm_outreach.sql
--
-- Adds:
--   crm_leads              — relationship source of truth
--   crm_activities         — activity timeline per lead
--   crm_tasks              — follow-ups and tasks
--   email_templates        — template library
--   email_outreach         — outreach tracking
--   email_signatures_table — signature management (renamed to avoid clash)
--   pilot_applications     — extends existing table (adds crm_lead_id)
--
-- All tables are tenant-scoped via RLS.
-- ==========================================================================

-- ── 1. CRM Leads ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_leads (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES public.tenants(_id) ON DELETE CASCADE,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Company
  company_name  text NOT NULL,
  website       text,
  location      text,
  service_area  text,
  company_size  text,
  contractor_type text,

  -- Contact
  contact_name  text,
  contact_email text,
  contact_phone text,
  contact_title text,

  -- Pipeline
  pipeline_stage text NOT NULL DEFAULT 'new',
  source        text,
  owner_id      uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Sales signals
  last_contacted_at timestamptz,
  last_reply_at     timestamptz,
  next_follow_up_at timestamptz,

  -- Internal
  notes         text,
  tags          text[] DEFAULT '{}',
  priority      text DEFAULT 'normal',

  -- Relationships
  pilot_application_id uuid REFERENCES public.pilot_applications(id) ON DELETE SET NULL,

  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_leads_tenant ON public.crm_leads(tenant_id);
CREATE INDEX IF NOT EXISTS idx_crm_leads_stage ON public.crm_leads(tenant_id, pipeline_stage);
CREATE INDEX IF NOT EXISTS idx_crm_leads_email ON public.crm_leads(tenant_id, contact_email);

-- RLS
ALTER TABLE public.crm_leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "crm_leads_isolation" ON public.crm_leads;
DROP POLICY IF EXISTS "crm_leads_isolation" ON public.crm_leads;
CREATE POLICY "crm_leads_isolation" ON public.crm_leads
  USING (tenant_id = public.my_tenant_id());

-- ── 2. CRM Activities ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_activities (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES public.tenants(_id) ON DELETE CASCADE,
  lead_id       uuid NOT NULL REFERENCES public.crm_leads(id) ON DELETE CASCADE,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  activity_type text NOT NULL, -- note, call, email, meeting, status_change, follow_up, task, application, pilot_event
  title         text,
  description   text,
  metadata      jsonb DEFAULT '{}',

  old_value     text,  -- for status changes
  new_value     text,  -- for status changes

  created_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_activities_lead ON public.crm_activities(lead_id);
CREATE INDEX IF NOT EXISTS idx_crm_activities_tenant ON public.crm_activities(tenant_id);

ALTER TABLE public.crm_activities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "crm_activities_isolation" ON public.crm_activities;
DROP POLICY IF EXISTS "crm_activities_isolation" ON public.crm_activities;
CREATE POLICY "crm_activities_isolation" ON public.crm_activities
  USING (tenant_id = public.my_tenant_id());

-- ── 3. CRM Tasks ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_tasks (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES public.tenants(_id) ON DELETE CASCADE,
  lead_id       uuid REFERENCES public.crm_leads(id) ON DELETE SET NULL,
  assigned_to   uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  title         text NOT NULL,
  description   text,
  task_type     text DEFAULT 'follow_up', -- follow_up, call, email, meeting, demo, other
  status        text DEFAULT 'pending',   -- pending, completed, overdue, cancelled
  priority      text DEFAULT 'normal',    -- low, normal, high, urgent

  due_date      timestamptz,
  completed_at  timestamptz,

  created_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_tasks_tenant ON public.crm_tasks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_due ON public.crm_tasks(tenant_id, due_date) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_crm_tasks_lead ON public.crm_tasks(lead_id);

ALTER TABLE public.crm_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "crm_tasks_isolation" ON public.crm_tasks;
DROP POLICY IF EXISTS "crm_tasks_isolation" ON public.crm_tasks;
CREATE POLICY "crm_tasks_isolation" ON public.crm_tasks
  USING (tenant_id = public.my_tenant_id());

-- ── 4. Email Templates ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.email_templates (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES public.tenants(_id) ON DELETE CASCADE,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  name          text NOT NULL,
  description   text,
  stage         text, -- day_0, day_3, day_7, day_14, pilot_invitation, demo_confirmation, etc.
  subject       text NOT NULL,
  body          text NOT NULL,
  variables     text[] DEFAULT '{}', -- {{first_name}}, {{company_name}}, etc.
  status        text DEFAULT 'active', -- active, archived

  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_templates_tenant ON public.email_templates(tenant_id);

ALTER TABLE public.email_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "email_templates_isolation" ON public.email_templates;
DROP POLICY IF EXISTS "email_templates_isolation" ON public.email_templates;
CREATE POLICY "email_templates_isolation" ON public.email_templates
  USING (tenant_id = public.my_tenant_id());

-- ── 5. Email Outreach ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.email_outreach (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES public.tenants(_id) ON DELETE CASCADE,
  lead_id       uuid REFERENCES public.crm_leads(id) ON DELETE SET NULL,
  template_id   uuid REFERENCES public.email_templates(id) ON DELETE SET NULL,
  sent_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  recipient_email text NOT NULL,
  recipient_name  text,
  subject       text NOT NULL,
  body          text NOT NULL,
  status        text DEFAULT 'draft', -- draft, scheduled, sent, delivered, opened, replied, bounced

  outreach_type text DEFAULT 'manual', -- manual, sequence, ai_generated
  sequence_step text, -- day_0, day_3, etc.
  sequence_id   uuid,

  sent_at       timestamptz,
  opened_at     timestamptz,
  replied_at    timestamptz,

  created_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_outreach_tenant ON public.email_outreach(tenant_id);
CREATE INDEX IF NOT EXISTS idx_email_outreach_lead ON public.email_outreach(lead_id);
CREATE INDEX IF NOT EXISTS idx_email_outreach_status ON public.email_outreach(tenant_id, status);

ALTER TABLE public.email_outreach ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "email_outreach_isolation" ON public.email_outreach;
DROP POLICY IF EXISTS "email_outreach_isolation" ON public.email_outreach;
CREATE POLICY "email_outreach_isolation" ON public.email_outreach
  USING (tenant_id = public.my_tenant_id());

-- ── 6. Email Signatures ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.email_signatures (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES public.tenants(_id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  name          text NOT NULL DEFAULT 'Default',
  html          text NOT NULL,
  is_primary    boolean DEFAULT true,

  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_signatures_user ON public.email_signatures(user_id);

ALTER TABLE public.email_signatures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "email_signatures_own" ON public.email_signatures;
DROP POLICY IF EXISTS "email_signatures_own" ON public.email_signatures;
CREATE POLICY "email_signatures_own" ON public.email_signatures
  USING (user_id = auth.uid());

-- ── 7. Extend pilot_applications with CRM link ──────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pilot_applications' AND column_name = 'crm_lead_id'
  ) THEN
    ALTER TABLE public.pilot_applications ADD COLUMN crm_lead_id uuid REFERENCES public.crm_leads(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pilot_applications' AND column_name = 'internal_notes'
  ) THEN
    ALTER TABLE public.pilot_applications ADD COLUMN internal_notes text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pilot_applications' AND column_name = 'source'
  ) THEN
    ALTER TABLE public.pilot_applications ADD COLUMN source text DEFAULT 'pilot_page';
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- RPC FUNCTIONS
-- ══════════════════════════════════════════════════════════════════════════

-- ── CRM Leads ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.crm_list_leads(
  p_stage text DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(l.*))
    FROM public.crm_leads l
    WHERE l.tenant_id = public.my_tenant_id()
      AND (p_stage IS NULL OR l.pipeline_stage = p_stage)
      AND (p_search IS NULL OR l.company_name ILIKE '%' || p_search || '%'
           OR l.contact_name ILIKE '%' || p_search || '%'
           OR l.contact_email ILIKE '%' || p_search || '%')
    ORDER BY l.updated_at DESC
    LIMIT p_limit OFFSET p_offset
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_get_lead(
  p_lead_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_lead jsonb; v_activities jsonb; v_tasks jsonb; v_outreach jsonb;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT row_to_json(l.*) INTO v_lead
  FROM public.crm_leads l WHERE l.id = p_lead_id AND l.tenant_id = public.my_tenant_id();

  IF v_lead IS NULL THEN
    RAISE EXCEPTION 'Lead not found';
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(a.*) ORDER BY a.created_at DESC), '[]'::jsonb) INTO v_activities
  FROM public.crm_activities a WHERE a.lead_id = p_lead_id;

  SELECT COALESCE(jsonb_agg(row_to_json(t.*) ORDER BY t.due_date ASC), '[]'::jsonb) INTO v_tasks
  FROM public.crm_tasks t WHERE t.lead_id = p_lead_id AND t.status != 'cancelled';

  SELECT COALESCE(jsonb_agg(row_to_json(o.*) ORDER BY o.created_at DESC), '[]'::jsonb) INTO v_outreach
  FROM public.email_outreach o WHERE o.lead_id = p_lead_id;

  RETURN jsonb_build_object(
    'lead', v_lead,
    'activities', v_activities,
    'tasks', v_tasks,
    'outreach', v_outreach
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_create_lead(
  p_company_name text,
  p_contact_name text DEFAULT NULL,
  p_contact_email text DEFAULT NULL,
  p_contact_phone text DEFAULT NULL,
  p_contact_title text DEFAULT NULL,
  p_website text DEFAULT NULL,
  p_location text DEFAULT NULL,
  p_service_area text DEFAULT NULL,
  p_company_size text DEFAULT NULL,
  p_contractor_type text DEFAULT NULL,
  p_source text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_pilot_application_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_lead jsonb;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  INSERT INTO public.crm_leads (
    tenant_id, created_by, company_name, contact_name, contact_email,
    contact_phone, contact_title, website, location, service_area,
    company_size, contractor_type, source, notes, pilot_application_id,
    pipeline_stage
  ) VALUES (
    public.my_tenant_id(), auth.uid(), p_company_name, p_contact_name, p_contact_email,
    p_contact_phone, p_contact_title, p_website, p_location, p_service_area,
    p_company_size, p_contractor_type, p_source, p_notes, p_pilot_application_id,
    'new'
  )
  RETURNING row_to_json(crm_leads.*) INTO v_lead;

  -- Log activity
  INSERT INTO public.crm_activities (tenant_id, lead_id, created_by, activity_type, title, description)
  VALUES (public.my_tenant_id(), v_lead->>'id', auth.uid(), 'note', 'Lead created', 'New CRM lead created');

  RETURN v_lead;
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_update_lead(
  p_lead_id uuid,
  p_company_name text DEFAULT NULL,
  p_contact_name text DEFAULT NULL,
  p_contact_email text DEFAULT NULL,
  p_contact_phone text DEFAULT NULL,
  p_contact_title text DEFAULT NULL,
  p_website text DEFAULT NULL,
  p_location text DEFAULT NULL,
  p_service_area text DEFAULT NULL,
  p_company_size text DEFAULT NULL,
  p_contractor_type text DEFAULT NULL,
  p_pipeline_stage text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_priority text DEFAULT NULL,
  p_next_follow_up_at timestamptz DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_old_stage text; v_lead jsonb;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT pipeline_stage INTO v_old_stage FROM public.crm_leads WHERE id = p_lead_id AND tenant_id = public.my_tenant_id();

  UPDATE public.crm_leads SET
    company_name = COALESCE(p_company_name, company_name),
    contact_name = COALESCE(p_contact_name, contact_name),
    contact_email = COALESCE(p_contact_email, contact_email),
    contact_phone = COALESCE(p_contact_phone, contact_phone),
    contact_title = COALESCE(p_contact_title, contact_title),
    website = COALESCE(p_website, website),
    location = COALESCE(p_location, location),
    service_area = COALESCE(p_service_area, service_area),
    company_size = COALESCE(p_company_size, company_size),
    contractor_type = COALESCE(p_contractor_type, contractor_type),
    pipeline_stage = COALESCE(p_pipeline_stage, pipeline_stage),
    notes = COALESCE(p_notes, notes),
    priority = COALESCE(p_priority, priority),
    next_follow_up_at = COALESCE(p_next_follow_up_at, next_follow_up_at),
    updated_at = now()
  WHERE id = p_lead_id AND tenant_id = public.my_tenant_id()
  RETURNING row_to_json(crm_leads.*) INTO v_lead;

  IF v_lead IS NULL THEN
    RAISE EXCEPTION 'Lead not found';
  END IF;

  -- Log stage change
  IF p_pipeline_stage IS NOT NULL AND p_pipeline_stage != v_old_stage THEN
    INSERT INTO public.crm_activities (tenant_id, lead_id, created_by, activity_type, title, old_value, new_value)
    VALUES (public.my_tenant_id(), p_lead_id, auth.uid(), 'status_change', 'Stage changed', v_old_stage, p_pipeline_stage);
  END IF;

  RETURN v_lead;
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_delete_lead(
  p_lead_id uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  DELETE FROM public.crm_leads WHERE id = p_lead_id AND tenant_id = public.my_tenant_id();
  RETURN FOUND;
END;
$$;

-- ── CRM Activities ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.crm_add_activity(
  p_lead_id uuid,
  p_activity_type text,
  p_title text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_activity jsonb;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  INSERT INTO public.crm_activities (tenant_id, lead_id, created_by, activity_type, title, description, metadata)
  VALUES (public.my_tenant_id(), p_lead_id, auth.uid(), p_activity_type, p_title, p_description, p_metadata)
  RETURNING row_to_json(crm_activities.*) INTO v_activity;

  -- Update lead's last_contacted for email/call/meeting types
  IF p_activity_type IN ('email', 'call', 'meeting') THEN
    UPDATE public.crm_leads SET last_contacted_at = now(), updated_at = now() WHERE id = p_lead_id;
  END IF;

  RETURN v_activity;
END;
$$;

-- ── CRM Tasks ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.crm_list_tasks(
  p_status text DEFAULT NULL,
  p_limit integer DEFAULT 50
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(t.*))
    FROM public.crm_tasks t
    WHERE t.tenant_id = public.my_tenant_id()
      AND (p_status IS NULL OR t.status = p_status)
    ORDER BY t.due_date ASC NULLS LAST
    LIMIT p_limit
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_create_task(
  p_title text,
  p_lead_id uuid DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_task_type text DEFAULT 'follow_up',
  p_priority text DEFAULT 'normal',
  p_due_date timestamptz DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_task jsonb;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  INSERT INTO public.crm_tasks (tenant_id, lead_id, assigned_to, title, description, task_type, priority, due_date)
  VALUES (public.my_tenant_id(), p_lead_id, auth.uid(), p_title, p_description, p_task_type, p_priority, p_due_date)
  RETURNING row_to_json(crm_tasks.*) INTO v_task;

  RETURN v_task;
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_complete_task(
  p_task_id uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  UPDATE public.crm_tasks SET status = 'completed', completed_at = now()
  WHERE id = p_task_id AND tenant_id = public.my_tenant_id();
  RETURN FOUND;
END;
$$;

-- ── CRM Stats (Today Command Center) ────────────────────────────────────

CREATE OR REPLACE FUNCTION public.crm_dashboard_stats()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_total_leads integer;
  v_new_leads integer;
  v_new_apps integer;
  v_followups_due integer;
  v_followups_overdue integer;
  v_replies_waiting integer;
  v_active_pilots integer;
  v_stage_counts jsonb;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT count(*) INTO v_total_leads FROM public.crm_leads WHERE tenant_id = public.my_tenant_id();
  SELECT count(*) INTO v_new_leads FROM public.crm_leads WHERE tenant_id = public.my_tenant_id() AND pipeline_stage = 'new';
  SELECT count(*) INTO v_new_apps FROM public.pilot_applications WHERE status = 'new';

  SELECT count(*) INTO v_followups_due
  FROM public.crm_tasks WHERE tenant_id = public.my_tenant_id() AND status = 'pending' AND due_date::date <= now()::date;

  SELECT count(*) INTO v_followups_overdue
  FROM public.crm_tasks WHERE tenant_id = public.my_tenant_id() AND status = 'pending' AND due_date < now();

  SELECT count(*) INTO v_replies_waiting
  FROM public.email_outreach WHERE tenant_id = public.my_tenant_id() AND status = 'sent' AND replied_at IS NULL;

  SELECT count(*) INTO v_active_pilots
  FROM public.crm_leads WHERE tenant_id = public.my_tenant_id() AND pipeline_stage = 'pilot_active';

  SELECT jsonb_agg(jsonb_build_object('stage', s.stage, 'count', s.cnt)) INTO v_stage_counts
  FROM (
    SELECT pipeline_stage as stage, count(*) as cnt
    FROM public.crm_leads WHERE tenant_id = public.my_tenant_id()
    GROUP BY pipeline_stage
  ) s;

  RETURN jsonb_build_object(
    'totalLeads', v_total_leads,
    'newLeads', v_new_leads,
    'newApplications', v_new_apps,
    'followupsDue', v_followups_due,
    'followupsOverdue', v_followups_overdue,
    'repliesWaiting', v_replies_waiting,
    'activePilots', v_active_pilots,
    'pipelineCounts', COALESCE(v_stage_counts, '[]'::jsonb)
  );
END;
$$;

-- ── Email Templates ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.email_list_templates()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(t.*) ORDER BY t.created_at DESC)
    FROM public.email_templates t WHERE t.tenant_id = public.my_tenant_id()
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.email_save_template(
  p_name text,
  p_subject text,
  p_body text,
  p_description text DEFAULT NULL,
  p_stage text DEFAULT NULL,
  p_variables text[] DEFAULT '{}'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_template jsonb;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  INSERT INTO public.email_templates (tenant_id, created_by, name, subject, body, description, stage, variables)
  VALUES (public.my_tenant_id(), auth.uid(), p_name, p_subject, p_body, p_description, p_stage, p_variables)
  RETURNING row_to_json(email_templates.*) INTO v_template;

  RETURN v_template;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_delete_template(
  p_template_id uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  DELETE FROM public.email_templates WHERE id = p_template_id AND tenant_id = public.my_tenant_id();
  RETURN FOUND;
END;
$$;

-- ── Email Outreach ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.email_create_outreach(
  p_recipient_email text,
  p_subject text,
  p_body text,
  p_lead_id uuid DEFAULT NULL,
  p_recipient_name text DEFAULT NULL,
  p_template_id uuid DEFAULT NULL,
  p_outreach_type text DEFAULT 'manual'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_outreach jsonb;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  INSERT INTO public.email_outreach (
    tenant_id, lead_id, sent_by, recipient_email, recipient_name,
    subject, body, template_id, outreach_type, status
  ) VALUES (
    public.my_tenant_id(), p_lead_id, auth.uid(), p_recipient_email, p_recipient_name,
    p_subject, p_body, p_template_id, p_outreach_type, 'draft'
  )
  RETURNING row_to_json(email_outreach.*) INTO v_outreach;

  -- Log activity on the lead
  IF p_lead_id IS NOT NULL THEN
    INSERT INTO public.crm_activities (tenant_id, lead_id, created_by, activity_type, title, description)
    VALUES (public.my_tenant_id(), p_lead_id, auth.uid(), 'email', 'Outreach drafted', 'Draft: ' || p_subject);
  END IF;

  RETURN v_outreach;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_list_outreach(
  p_status text DEFAULT NULL,
  p_lead_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 50
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(o.*) ORDER BY o.created_at DESC)
    FROM public.email_outreach o
    WHERE o.tenant_id = public.my_tenant_id()
      AND (p_status IS NULL OR o.status = p_status)
      AND (p_lead_id IS NULL OR o.lead_id = p_lead_id)
    LIMIT p_limit
  ), '[]'::jsonb);
END;
$$;

-- ── Email Signatures ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.email_list_signatures()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(s.*) ORDER BY s.is_primary DESC, s.created_at DESC)
    FROM public.email_signatures s WHERE s.user_id = auth.uid()
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.email_save_signature(
  p_name text,
  p_html text,
  p_is_primary boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_sig jsonb;
BEGIN
  -- If primary, unset other primaries
  IF p_is_primary THEN
    UPDATE public.email_signatures SET is_primary = false WHERE user_id = auth.uid();
  END IF;

  INSERT INTO public.email_signatures (tenant_id, user_id, name, html, is_primary)
  VALUES (public.my_tenant_id(), auth.uid(), p_name, p_html, p_is_primary)
  RETURNING row_to_json(email_signatures.*) INTO v_sig;

  RETURN v_sig;
END;
$$;

CREATE OR REPLACE FUNCTION public.email_delete_signature(
  p_sig_id uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  DELETE FROM public.email_signatures WHERE id = p_sig_id AND user_id = auth.uid();
  RETURN FOUND;
END;
$$;

-- ── Pilot Application Management (extend existing) ──────────────────────

CREATE OR REPLACE FUNCTION public.pilot_get_application(
  p_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_app jsonb;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  SELECT row_to_json(a.*) INTO v_app FROM public.pilot_applications a WHERE a.id = p_id;
  IF v_app IS NULL THEN
    RAISE EXCEPTION 'Application not found';
  END IF;
  RETURN v_app;
END;
$$;

-- ── Verify ──────────────────────────────────────────────────────────────
SELECT 'CRM + Outreach migration complete' as status;
