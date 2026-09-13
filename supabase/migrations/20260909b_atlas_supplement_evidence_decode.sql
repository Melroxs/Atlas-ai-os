-- ============================================================================
-- Atlas — decode legacy supplement evidence shapes at the read boundary
--
-- PROBLEM:
--   claimSupplements.evidence / affectedLineItems / requestedItems are jsonb
--   columns, and the current write path (insurance_create_supplement) always
--   inserts JSON arrays. Legacy rows written by older clients can carry a
--   JSON string literal, a plain text string, or an object instead of an
--   array. insurance_get_supplement_document serializes those raw values, so
--   a page consuming them with `.join()`/`.map()` could crash on a legacy
--   row (and its raw { claim, supplement } shape could not render the
--   derived document at all).
--
-- FIX (non-destructive, idempotent, reversible):
--   1. Re-create insurance_get_supplement_document so the supplement's
--      list-valued jsonb fields are decoded through decode_evidence_text
--      (created in 20260909_atlas_findings_evidence_jsonb.sql) — arrays stay
--      arrays, legacy text is preserved as a single evidence entry, nothing
--      is dropped or fabricated. Works whether or not the migration that
--      alters claimFindings.evidence has been applied, because the decoder
--      is column-agnostic.
--   2. The frontend additionally normalizes this response at the api
--      boundary (normalizeSupplementDocumentResponse), so the page is safe
--      even before this migration is applied.
--
-- No schema, RLS, index or FK changes. Tenant isolation is unchanged.
-- ============================================================================

create or replace function public.insurance_get_supplement_document(p_claimId uuid, p_supplementId uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_tenant uuid := public.my_tenant_id();
  v_claim jsonb;
  v_sup jsonb;
begin
  if v_tenant is null then raise exception 'You must be signed in and belong to a workspace.'; end if;
  select to_jsonb(c) into v_claim from public.insuranceClaims c
  where c._id = p_claimId and c."tenantId" = v_tenant;
  if v_claim is null then raise exception 'Claim not found.'; end if;
  select to_jsonb(s) into v_sup from public.claimSupplements s
  where s._id = p_supplementId and s."tenantId" = v_tenant and s."claimId" = p_claimId;
  if v_sup is null then raise exception 'Supplement not found.'; end if;

  -- Legacy rows may hold a JSON string literal, plain text, or an object
  -- where an array is expected. decode_evidence_text turns any of those into
  -- a real array (preserving the original value as a single entry when it is
  -- not an array), so readers can always iterate the result.
  v_sup := jsonb_set(
    v_sup, '{evidence}',
    public.decode_evidence_text(v_sup -> 'evidence' #>> '{}')
  );
  v_sup := jsonb_set(
    v_sup, '{requestedItems}',
    public.decode_evidence_text(v_sup -> 'requestedItems' #>> '{}')
  );
  v_sup := jsonb_set(
    v_sup, '{affectedLineItems}',
    public.decode_evidence_text(v_sup -> 'affectedLineItems' #>> '{}')
  );

  return jsonb_build_object('claim', v_claim, 'supplement', v_sup);
end;
$$;