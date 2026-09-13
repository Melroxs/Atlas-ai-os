-- ============================================================================
-- Atlas — canonicalize claimFindings.evidence as JSONB + harden readers
--
-- PROBLEM (root cause of "f.evidence.map is not a function" style page
-- failures on ClaimDetail / package surfaces):
--
--   claimFindings.evidence is declared TEXT while every other evidence field
--   in the schema is JSONB (claimCandidates.evidence, claimSupplements.
--   evidence, insuranceClaims.evidenceDocumentIds / evidenceSummary,
--   governance knowledge_gaps). The write path always inserts a jsonb value
--   (insurance_upsert_findings inserts `v_finding -> 'evidence'`), which
--   PostgreSQL assignment-casts to its text rendering (e.g. the string
--   `["estimate"]`), and the read path serializes the column with to_jsonb(),
--   which turns that text back into a JSON *string* — not an array. Any
--   consumer that called `.map()` on finding evidence threw
--   `TypeError: f.evidence.map is not a function`, and normalizers that
--   gated with `Array.isArray` silently dropped the evidence.
--
-- FIX (non-destructive, idempotent, reversible):
--
--   1. decode_evidence_text(text) — safe decoder. NULL/'' → []; a JSON array
--      (current write path, or an already-jsonb column cast to text) parses
--      back to that array; any other legacy text (plain string, malformed
--      JSON) is preserved as a single-element array — evidence is never
--      fabricated and never dropped.
--   2. ALTER claimFindings.evidence to jsonb USING the decoder. Existing
--      values are migrated through the decoder, so no data is lost. The
--      column now matches the canonical jsonb evidence contract used by the
--      rest of the pipeline. Reversible: `alter table public.claimFindings
--      alter column evidence type text using evidence::text`.
--   3. Re-create every findings-serializing RPC with a defensive decode
--      (jsonb_set + decode_evidence_text). The readers work whether the
--      column is still text (migration not yet applied) or already jsonb,
--      so the RPC layer never depends on migration order.
--
-- No data is deleted, rewritten destructively, or re-generated here. No RLS
-- policy, index, or foreign key changes. Tenant isolation is unchanged.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Safe evidence decoder (public, immutable, idempotent)
-- ---------------------------------------------------------------------------
create or replace function public.decode_evidence_text(p_value text)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_parsed jsonb;
begin
  if p_value is null or p_value = '' then
    return '[]'::jsonb;
  end if;
  -- Current write path stores a JSON array as text; parse it back verbatim.
  if left(trim(p_value), 1) = '[' then
    begin
      v_parsed := p_value::jsonb;
      if jsonb_typeof(v_parsed) = 'array' then
        return v_parsed;
      end if;
    exception when others then
      null; -- malformed array-looking text: preserve below, never crash
    end;
  end if;
  -- Legacy plain text (e.g. "estimate, invoice") or malformed JSON: keep the
  -- original value discoverable as a single evidence entry.
  return jsonb_build_array(p_value);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Column type: TEXT → JSONB via the safe decoder (data-preserving cast)
-- ---------------------------------------------------------------------------
alter table public.claimFindings
  alter column evidence type jsonb
  using public.decode_evidence_text(evidence::text);

-- ---------------------------------------------------------------------------
-- 3. Hardened readers — findings rows always carry evidence as a JSON array
-- ---------------------------------------------------------------------------
create or replace function public.insurance_list_claims(p_status text default null)
returns jsonb
language plpgsql
stable
as $$
declare
  v_tenant uuid := public.my_tenant_id();
begin
  if v_tenant is null then raise exception 'You must be signed in and belong to a workspace.'; end if;
  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'claim', to_jsonb(c),
        'supplements', coalesce((
          select jsonb_agg(to_jsonb(s) order by s."_creationTime")
          from public.claimSupplements s where s."claimId" = c._id
        ), '[]'::jsonb),
        'findings', coalesce((
          select jsonb_agg(
            jsonb_set(to_jsonb(f), '{evidence}', public.decode_evidence_text(f.evidence::text))
            order by f."_creationTime"
          )
          from public.claimFindings f where f."claimId" = c._id
        ), '[]'::jsonb)
      )
      order by c."_creationTime" desc
    )
    from (
      select * from public.insuranceClaims c
      where c."tenantId" = v_tenant
        and (p_status is null or p_status = '' or c.status = p_status)
      order by "_creationTime" desc limit 200
    ) c
  ), '[]'::jsonb);
end;
$$;

create or replace function public.insurance_get_claim_package(p_claimId uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_tenant uuid := public.my_tenant_id();
  v_claim jsonb;
  v_supplements jsonb;
  v_findings jsonb;
  v_evidence jsonb;
begin
  if v_tenant is null then raise exception 'You must be signed in and belong to a workspace.'; end if;
  select to_jsonb(c) into v_claim from public.insuranceClaims c
  where c._id = p_claimId and c."tenantId" = v_tenant;
  if v_claim is null then raise exception 'Claim not found.'; end if;

  select coalesce(jsonb_agg(to_jsonb(s) order by s."_creationTime" desc), '[]'::jsonb) into v_supplements
  from public.claimSupplements s where s."claimId" = p_claimId;

  select coalesce(jsonb_agg(
    jsonb_set(to_jsonb(f), '{evidence}', public.decode_evidence_text(f.evidence::text))
    order by f."_creationTime" desc
  ), '[]'::jsonb) into v_findings
  from public.claimFindings f where f."claimId" = p_claimId;

  -- Only string elements are document ids. Legacy rows written by the old
  -- attach (nested {"value": …} wrappers) are skipped rather than crashing,
  -- and malformed strings are never cast to uuid.
  select coalesce(jsonb_agg(jsonb_build_object(
    '_id', d._id, 'title', d.title, 'classification', d.classification
  )), '[]'::jsonb) into v_evidence
  from jsonb_array_elements(
    coalesce(nullif(v_claim -> 'evidenceDocumentIds', 'null'::jsonb), '[]'::jsonb)
  ) e
  join public.documents d
    on d._id = e::text
    and e::text like '________-____-____-____-____________'
    and d."tenantId" = v_tenant;

  return jsonb_build_object(
    'claim', v_claim, 'supplements', v_supplements, 'findings', v_findings, 'evidenceDocs', v_evidence
  );
end;
$$;

create or replace function public.insurance_get_claim_timeline(p_claimId uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_tenant uuid := public.my_tenant_id();
  v_claim jsonb;
  v_supplements jsonb;
  v_findings jsonb;
begin
  if v_tenant is null then raise exception 'You must be signed in and belong to a workspace.'; end if;
  select to_jsonb(c) into v_claim from public.insuranceClaims c
  where c._id = p_claimId and c."tenantId" = v_tenant;
  if v_claim is null then raise exception 'Claim not found.'; end if;

  select coalesce(jsonb_agg(to_jsonb(s) order by s."_creationTime"), '[]'::jsonb) into v_supplements
  from public.claimSupplements s where s."claimId" = p_claimId;
  select coalesce(jsonb_agg(
    jsonb_set(to_jsonb(f), '{evidence}', public.decode_evidence_text(f.evidence::text))
    order by f."_creationTime"
  ), '[]'::jsonb) into v_findings
  from public.claimFindings f where f."claimId" = p_claimId;

  return jsonb_build_object('claim', v_claim, 'supplements', v_supplements, 'findings', v_findings);
end;
$$;

create or replace function public.insurance_recovery_analytics()
returns jsonb
language plpgsql
stable
as $$
declare
  v_tenant uuid := public.my_tenant_id();
begin
  if v_tenant is null then raise exception 'You must be signed in and belong to a workspace.'; end if;
  return jsonb_build_object(
    'claims', coalesce((
      select jsonb_agg(to_jsonb(c) order by c."_creationTime")
      from public.insuranceClaims c where c."tenantId" = v_tenant
    ), '[]'::jsonb),
    'findings', coalesce((
      select jsonb_agg(
        jsonb_set(to_jsonb(f), '{evidence}', public.decode_evidence_text(f.evidence::text))
        order by f."_creationTime"
      )
      from public.claimFindings f where f."tenantId" = v_tenant
    ), '[]'::jsonb),
    'supplements', coalesce((
      select jsonb_agg(to_jsonb(s) order by s."_creationTime")
      from public.claimSupplements s where s."tenantId" = v_tenant
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.insurance_analyze_all_claims()
returns jsonb
language plpgsql
stable
as $$
declare
  v_tenant uuid := public.my_tenant_id();
begin
  if v_tenant is null then raise exception 'You must be signed in and belong to a workspace.'; end if;
  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'claim', to_jsonb(c),
        'supplements', coalesce((
          select jsonb_agg(to_jsonb(s) order by s."_creationTime")
          from public.claimSupplements s where s."claimId" = c._id
        ), '[]'::jsonb),
        'findings', coalesce((
          select jsonb_agg(
            jsonb_set(to_jsonb(f), '{evidence}', public.decode_evidence_text(f.evidence::text))
            order by f."_creationTime"
          )
          from public.claimFindings f where f."claimId" = c._id
        ), '[]'::jsonb)
      )
      order by c."_creationTime" desc
    )
    from (
      select * from public.insuranceClaims c
      where c."tenantId" = v_tenant order by "_creationTime" desc limit 100
    ) c
  ), '[]'::jsonb);
end;
$$;