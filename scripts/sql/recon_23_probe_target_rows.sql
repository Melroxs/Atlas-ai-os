select
  "actionType", "actorType", "actorId"::text, "tenantId"::text, "targetId"::text,
  "metadata" as metadata
from public.auditlogs
where "targetId" in ('e5c1000c-2494-4f4e-b377-69d086dfa4cc','3150a8e8-dee7-4906-8a22-14fa333cf9ee');
