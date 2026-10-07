-- 20260945 — the article-generation job carries its authoritative topic
--
-- THE DEFECT (proved in production, Phase 2)
-- ------------------------------------------
-- `content_engine_enqueue` is the ONLY producer for Atlas Content Engine jobs.
-- It forwarded the caller's payload verbatim, so the payload it created was
-- only as complete as the caller's. The Content Studio's "Regenerate article"
-- action (src/lib/content-engine/studio-api.ts → regenerate(packageId,"article"))
-- sends exactly:
--
--     { package_id, content_id, regenerate: true }
--
-- and the worker's `stepGeneratePackage()` requires BOTH `package_id` AND
-- `topic`, failing the job non-retryably otherwise. A real production job
-- released through the normal path (pg_cron `atlas-platform-tick` →
-- `content-engine-worker`) died 158 ms after dequeue with:
--
--     { "code": "VALIDATION", "message": "package_id and topic are required." }
--
-- before `resolveBrand()`, before any provider request: the article could never
-- be regenerated at all.
--
-- WHERE THE TOPIC ACTUALLY LIVES
-- ------------------------------
-- The topic is NOT invented here, and it is not a second source of truth. It is
-- already persisted, once, at package creation: `content_create` stores the
-- Studio's topic inside the package's `seo` document
-- (src/lib/content-engine/client.ts → createContentPackage sends
-- `seo: { tags, topic }`). Every package in the corpus carries it, and it is
-- deliberately NOT the title — the topic is the short subject token the article
-- is written from, the title is the article's headline.
--
-- WHY THE FIX BELONGS IN THE PRODUCER
-- -----------------------------------
-- `content_engine_enqueue` is the only place that already reads the package row
-- (to resolve the owning organization), so it resolves the topic from the SAME
-- row in the SAME statement. That means:
--
--   * the worker's validation stays strict — it is not relaxed to "topic
--     optional", so an incomplete payload is still rejected;
--   * no browser or caller is trusted for a value the platform already owns;
--   * no caller can forget the field, because filling it is not the caller's
--     job — the producer owns the contract it produces;
--   * the extra read costs nothing: it is the same single-row lookup.
--
-- Nothing is fabricated: a package with no stored topic is left exactly as it
-- was, and the worker's own guard still rejects it.
--
-- This is a body-only replacement of an existing function. It adds no table,
-- column, index, policy or grant, and it changes no data.

create or replace function public.content_engine_enqueue(
  p_package         uuid,
  p_job_type        text,
  p_payload         jsonb default '{}'::jsonb,
  p_idempotency_key text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_topic text;
  v_payload jsonb;
begin
  -- The package supplies BOTH the owning organization and the authoritative
  -- topic, in one read. `nullif(btrim(...), '')` so a blank or whitespace-only
  -- topic counts as absent rather than being forwarded as a topic.
  select "organizationId",
         nullif(btrim(coalesce("seo" ->> 'topic', '')), '')
    into v_org, v_topic
  from public."atlasContentItems" where "_id" = p_package;
  if not found then
    raise exception 'Unknown content package: %', p_package;
  end if;

  -- Authorization is explicit in every function (the repo's ratchet test requires
  -- an in-body guard): a platform admin may act, the TRUSTED SERVER (the content
  -- worker, which runs with the service role and has no user JWT) may act, and
  -- everyone else only on their OWN organization.
  if not (public.atlas_is_trusted_server()
          or public.is_atlas_admin()
          or (v_org is not null and v_org = public.my_tenant_id())) then
    raise exception 'Access denied: not a member of this organization'
      using errcode = '42501';
  end if;

  v_payload := coalesce(p_payload, '{}'::jsonb);

  -- Article generation works FROM a topic, and the package already knows it.
  -- Fill it only when the caller did not name one, so an explicit caller value
  -- is never overwritten and no other job type is touched. The worker keeps
  -- requiring the field, so this can only ever ADD the value it needs.
  if p_job_type = 'content_generate_package'
     and coalesce(btrim(v_payload ->> 'topic'), '') = ''
     and v_topic is not null
  then
    v_payload := jsonb_set(v_payload, '{topic}', to_jsonb(v_topic), true);
  end if;

  return public.jobs_create_job(
    p_tenant_id       => v_org,
    p_job_type        => p_job_type,
    p_idempotency_key => coalesce(p_idempotency_key,
                                  'content:' || p_job_type || ':' || p_package::text),
    p_priority        => 4,
    -- The payload the worker receives, not the payload the caller sent.
    p_payload         => v_payload,
    p_max_attempts    => 3,
    p_tags            => array['content-engine']
  );
end;
$$;

comment on function public.content_engine_enqueue(uuid, text, jsonb, text) is
  'Queues one Content Engine job for a package. The owning organization is read '
  'from the package, never from the caller. For content_generate_package the '
  'authoritative topic is read from the same package row (seo.topic, the value '
  'content_create persisted at creation) and added to the payload when the '
  'caller did not supply one, so a regenerate request cannot produce a payload '
  'the worker has to reject.';

-- The signature is unchanged and the function is replaced in place, so existing
-- grants survive; they are re-stated explicitly so the PUBLIC grant is proven
-- absent (relying on inheritance from PUBLIC is the defect 20260936 repaired).
revoke execute on function public.content_engine_enqueue(uuid, text, jsonb, text) from public, anon;
grant execute on function public.content_engine_enqueue(uuid, text, jsonb, text) to authenticated, service_role;
