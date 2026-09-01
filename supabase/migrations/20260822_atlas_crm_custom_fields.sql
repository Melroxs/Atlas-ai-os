-- ==========================================================================
-- Atlas CRM — Custom Fields (Schema-Flexible CSV Import)
-- Migration: 20260822_atlas_crm_custom_fields.sql
--
-- Adds:
--   crm_custom_fields       — field definitions per workspace
--   crm_custom_field_values — stored values per lead per field
--
-- Enables users to create new CRM columns directly from the CSV mapping UI
-- without touching database schemas or code deployments.
-- ==========================================================================

-- ── 1. Custom Field Definitions ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_custom_fields (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES public.tenants(_id) ON DELETE CASCADE,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  name          text NOT NULL,          -- human-readable: "Insurance Focus"
  key           text NOT NULL,          -- machine key: "insurance_focus"
  field_type    text NOT NULL DEFAULT 'text', -- text, long_text, number, boolean, date, url, select, multi_select
  entity_type   text NOT NULL DEFAULT 'lead', -- lead, company, contact
  description   text,
  options       jsonb,                  -- for select/multi_select: ["Option A", "Option B"]

  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now(),

  UNIQUE (tenant_id, key)
);

CREATE INDEX IF NOT EXISTS idx_crm_custom_fields_tenant ON public.crm_custom_fields(tenant_id);
CREATE INDEX IF NOT EXISTS idx_crm_custom_fields_entity ON public.crm_custom_fields(tenant_id, entity_type);

ALTER TABLE public.crm_custom_fields ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "crm_custom_fields_isolation" ON public.crm_custom_fields;
DROP POLICY IF EXISTS "crm_custom_fields_isolation" ON public.crm_custom_fields;
CREATE POLICY "crm_custom_fields_isolation" ON public.crm_custom_fields
  USING (tenant_id = public.my_tenant_id());

-- ── 2. Custom Field Values ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_custom_field_values (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES public.tenants(_id) ON DELETE CASCADE,
  field_id        uuid NOT NULL REFERENCES public.crm_custom_fields(id) ON DELETE CASCADE,
  lead_id         uuid NOT NULL REFERENCES public.crm_leads(id) ON DELETE CASCADE,
  value           jsonb,               -- stored as JSONB for flexible types

  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),

  UNIQUE (tenant_id, field_id, lead_id)
);

CREATE INDEX IF NOT EXISTS idx_cfv_tenant ON public.crm_custom_field_values(tenant_id);
CREATE INDEX IF NOT EXISTS idx_cfv_field ON public.crm_custom_field_values(field_id);
CREATE INDEX IF NOT EXISTS idx_cfv_lead ON public.crm_custom_field_values(lead_id);

ALTER TABLE public.crm_custom_field_values ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "crm_custom_field_values_isolation" ON public.crm_custom_field_values;
DROP POLICY IF EXISTS "crm_custom_field_values_isolation" ON public.crm_custom_field_values;
CREATE POLICY "crm_custom_field_values_isolation" ON public.crm_custom_field_values
  USING (tenant_id = public.my_tenant_id());

-- ── 3. Custom Fields CRUD ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.crm_list_custom_fields(
  p_entity_type text DEFAULT 'lead'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(f.*))
    FROM public.crm_custom_fields f
    WHERE f.tenant_id = public.my_tenant_id()
      AND f.entity_type = p_entity_type
    ORDER BY f.created_at ASC
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_create_custom_field(
  p_name text,
  p_key text,
  p_field_type text DEFAULT 'text',
  p_entity_type text DEFAULT 'lead',
  p_description text DEFAULT NULL,
  p_options jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_field jsonb;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  -- Validate field_type
  IF p_field_type NOT IN ('text', 'long_text', 'number', 'boolean', 'date', 'url', 'select', 'multi_select') THEN
    RAISE EXCEPTION 'Invalid field type: %', p_field_type;
  END IF;

  -- Check for duplicate key within workspace
  IF EXISTS (
    SELECT 1 FROM public.crm_custom_fields
    WHERE tenant_id = public.my_tenant_id() AND key = p_key
  ) THEN
    RAISE EXCEPTION 'A field with key "%" already exists', p_key;
  END IF;

  INSERT INTO public.crm_custom_fields (tenant_id, created_by, name, key, field_type, entity_type, description, options)
  VALUES (public.my_tenant_id(), auth.uid(), p_name, p_key, p_field_type, p_entity_type, p_description, p_options)
  RETURNING row_to_json(crm_custom_fields.*) INTO v_field;

  RETURN v_field;
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_delete_custom_field(
  p_field_id uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  DELETE FROM public.crm_custom_fields WHERE id = p_field_id AND tenant_id = public.my_tenant_id();
  RETURN FOUND;
END;
$$;

-- ── 4. Custom Field Values CRUD ────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.crm_get_custom_field_values(
  p_lead_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'fieldId', v.field_id,
      'fieldKey', f.key,
      'fieldName', f.name,
      'fieldType', f.field_type,
      'value', v.value
    ))
    FROM public.crm_custom_field_values v
    JOIN public.crm_custom_fields f ON f.id = v.field_id
    WHERE v.lead_id = p_lead_id AND v.tenant_id = public.my_tenant_id()
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_upsert_custom_field_value(
  p_lead_id uuid,
  p_field_id uuid,
  p_value jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_row jsonb;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  -- Validate the field belongs to this workspace
  IF NOT EXISTS (
    SELECT 1 FROM public.crm_custom_fields
    WHERE id = p_field_id AND tenant_id = public.my_tenant_id()
  ) THEN
    RAISE EXCEPTION 'Field not found';
  END IF;

  -- Upsert
  INSERT INTO public.crm_custom_field_values (tenant_id, field_id, lead_id, value)
  VALUES (public.my_tenant_id(), p_field_id, p_lead_id, p_value)
  ON CONFLICT (tenant_id, field_id, lead_id)
  DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  RETURNING row_to_json(crm_custom_field_values.*) INTO v_row;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_bulk_upsert_custom_field_values(
  p_lead_id uuid,
  p_values jsonb  -- [{"fieldId": "...", "value": ...}, ...]
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_item jsonb;
  v_count integer := 0;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_values)
  LOOP
    -- Validate field belongs to workspace
    IF NOT EXISTS (
      SELECT 1 FROM public.crm_custom_fields
      WHERE id = (v_item ->> 'fieldId')::uuid AND tenant_id = public.my_tenant_id()
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO public.crm_custom_field_values (tenant_id, field_id, lead_id, value)
    VALUES (public.my_tenant_id(), (v_item ->> 'fieldId')::uuid, p_lead_id, v_item -> 'value')
    ON CONFLICT (tenant_id, field_id, lead_id)
    DO UPDATE SET value = EXCLUDED.value, updated_at = now();

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;
