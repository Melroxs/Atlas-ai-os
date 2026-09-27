### connections_list_catalog()
md5=98793a5d7fee89a86d7c56b25665922a


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


### everest_update_organization_context(p_patch jsonb)
md5=d66cb78462c37bad3d2ea74867694c98


declare
  v_user uuid := auth.uid();
  v_tenant uuid := public.my_tenant_id();
  v_timezone text;
begin
  if v_user is null or v_tenant is null then raise exception 'You must be signed in and belong to a workspace.'; end if;

  insert into public.organizationContexts ("tenantId", "updatedAt")
  values (v_tenant, public.epoch_ms())
  on conflict ("tenantId") do nothing;

  execute 'update public.organizationContexts set "updatedAt" = ' || public.epoch_ms() || ', ' ||
    (select string_agg(quote_ident(k) || ' = ' || case when v is null then 'null' else quote_literal(v #>> '{}') end, ', ')
     from jsonb_each(p_patch) e(k, v)
     where k not in ('_id', '_creationTime', 'tenantId'))
    || ' where "tenantId" = ' || quote_literal(v_tenant::text);

  select "primaryTimezone" into v_timezone from public.organizationContexts where "tenantId" = v_tenant;
  perform public.log_audit('org_context_updated', 'organization_context', null,
    jsonb_build_object('timezone', v_timezone));
  return jsonb_build_object('timezone', v_timezone);
end;


### industry_get_document_detail(p_documentid uuid)
md5=7a21d60984e477d5949dc70e6371fdf7


DECLARE
  v_user uuid := auth.uid();
  v_doc jsonb;
  v_chunks jsonb;
  v_knowledge jsonb;
BEGIN

  IF v_user IS NULL THEN
    RETURN NULL;
  END IF;


  SELECT jsonb_build_object(
    '_id', d."_id",
    'title', d."title",
    'filename', d."filename",
    'status', d."status",
    'classification', d."classification",
    'chunkCount', d."chunkCount",
    'entityCount', d."entityCount",
    'industry', d."industry",
    'jurisdiction', d."jurisdiction",
    'version', d."version",
    'publishedAt', d."publishedAt",
    '_creationTime', d."_creationTime",
    'tags', d."tags",
    'description', d."description",
    'sourceId', d."sourceId",
    'contentHash', d."contentHash"
  )
  INTO v_doc
  FROM public."atlasIndustryDocuments" d
  WHERE d."_id" = p_documentId;


  IF v_doc IS NULL THEN
    RETURN NULL;
  END IF;


  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        '_id', c."_id",
        'chunkIndex', c."chunkIndex",
        'content', c."content",
        'tokenCount', c."tokenCount"
      )
      ORDER BY c."chunkIndex"
    ),
    '[]'::jsonb
  )
  INTO v_chunks
  FROM public."atlasIndustryChunks" c
  WHERE c."documentId" = p_documentId;


  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        '_id', k."_id",
        'title', k."title",
        'statement', k."statement",
        'interpretation', k."interpretation",
        'knowledgeType', k."knowledgeType",
        'sourceClassification', k."sourceClassification",
        'confidence', k."confidence",
        'status', k."status",
        'industry', k."industry",
        'jurisdiction', k."jurisdiction"
      )
      ORDER BY k."confidence" DESC
    ),
    '[]'::jsonb
  )
  INTO v_knowledge
  FROM public."atlasIndustryKnowledge" k
  WHERE k."documentId" = p_documentId;


  RETURN jsonb_build_object(
    'doc', v_doc,
    'chunks', v_chunks,
    'knowledge', v_knowledge
  );

END;


### industry_list_documents()
md5=b927bd636ff4f740012cc2c4f576bec7


DECLARE
  v_user uuid := auth.uid();
BEGIN

  IF v_user IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  RETURN (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          '_id', d."_id",
          'title', d."title",
          'filename', d."filename",
          'status', d."status",
          'classification', d."classification",
          'chunkCount', d."chunkCount",
          'entityCount', d."entityCount",
          'industry', d."industry",
          'jurisdiction', d."jurisdiction",
          'version', d."version",
          'publishedAt', d."publishedAt",
          '_creationTime', d."_creationTime",
          'tags', d."tags"
        )
        ORDER BY d."_creationTime" DESC
      ),
      '[]'::jsonb
    )
    FROM public."atlasIndustryDocuments" d
  );

END;


### ingestion_patch_document(p_documentid uuid, p_patch jsonb)
md5=398d209956bd4b589ecb107bba31a752


declare
  v_tenant uuid := public.my_tenant_id();
  v_set text;
begin
  if v_tenant is null then raise exception 'You must be signed in and belong to a workspace.'; end if;
  if not exists (select 1 from public.documents d where d._id = p_documentId and d."tenantId" = v_tenant) then
    raise exception 'Document not found.';
  end if;
  select string_agg(quote_ident(k) || ' = ' || case when v is null then 'null' else quote_literal(v #>> '{}') end, ', ')
  into v_set
  from jsonb_each(p_patch) e(k, v)
  where k not in ('_id', '_creationTime', 'tenantId')
    and exists (
      select 1 from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = 'documents' and c.column_name = k
    );
  if v_set is not null then
    execute 'update public.documents set ' || v_set || ' where _id = ' || quote_literal(p_documentId::text);
  end if;
  return jsonb_build_object('ok', true);
end;


### ingestion_patch_entity(p_entityid uuid, p_patch jsonb)
md5=11500bee10aa9eb356d1dfb6db4a8ef4


declare
  v_tenant uuid := public.my_tenant_id();
begin
  if v_tenant is null then raise exception 'You must be signed in and belong to a workspace.'; end if;
  if not exists (select 1 from public.entities e where e._id = p_entityId and e."tenantId" = v_tenant) then
    raise exception 'Entity not found.';
  end if;
  execute 'update public.entities set ' ||
    (select string_agg(quote_ident(k) || ' = ' || case when v is null then 'null' else quote_literal(v #>> '{}') end, ', ')
     from jsonb_each(p_patch) e(k, v)
     where k not in ('_id', '_creationTime', 'tenantId'))
    || ' where _id = ' || quote_literal(p_entityId::text);
  return jsonb_build_object('ok', true);
end;


### insurance_update_claim(p_claimid uuid, p_patch jsonb)
md5=0f42f880a51943e340a15c15e62d720f


declare
  v_user uuid := auth.uid();
  v_tenant uuid := public.my_tenant_id();
begin
  if v_user is null or v_tenant is null then raise exception 'You must be signed in and belong to a workspace.'; end if;
  if public.my_member_role() not in ('owner', 'admin', 'manager', 'analyst') then
    raise exception 'Only editors and above can update claims.';
  end if;
  if not exists (select 1 from public.insuranceClaims c where c._id = p_claimId and c."tenantId" = v_tenant) then
    raise exception 'Claim not found.';
  end if;
  if p_patch is null or p_patch = '{}'::jsonb then raise exception 'Nothing to update.'; end if;
  execute 'update public.insuranceClaims set "updatedAt" = ' || public.epoch_ms() || ', ' ||
    (select string_agg(quote_ident(k) || ' = ' || case when v is null then 'null' else quote_literal(v #>> '{}') end, ', ')
     from jsonb_each(p_patch) e(k, v)
     where k not in ('_id', '_creationTime', 'tenantId'))
    || ' where _id = ' || quote_literal(p_claimId::text);
  perform public.log_audit('claim_updated', 'insuranceClaim', p_claimId::text,
    jsonb_build_object('fields', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(p_patch) k)));
  return jsonb_build_object('claimId', p_claimId);
end;
