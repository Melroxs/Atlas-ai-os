-- Test Company cleanup (the one organization being retained).
-- 1. Remove the 3 invites (all for users being deleted).
-- 2. Remove the co-member (ycdemo2026@gmail.com) so Melissa is sole owner.
-- 3. Remove all claim data plus the claim-linked files and documents.
--
-- Order matters: documents first (documentchunks CASCADE, and
-- archivefiles.documentId is SET NULL), then the ingestion
-- (archivefiles CASCADE). Deleting the ingestion first would leave the
-- documents orphaned with no claim link to find them by.

-- 1. Invites
delete from public.invites
where "tenantId" = '877bf5ec-fd93-4ea1-8e55-280e320f32aa'::uuid;

-- 2. Memberships other than Melissa's
delete from public.memberships
where "tenantId" = '877bf5ec-fd93-4ea1-8e55-280e320f32aa'::uuid
  and "userId" <> '0e914537-e62b-4982-a49d-3056f0deb2b8'::uuid;

-- 3a. Claim documents (and their chunks via CASCADE)
delete from public.documents d
where d."tenantId" = '877bf5ec-fd93-4ea1-8e55-280e320f32aa'::uuid
  and d."_id" in (
    select f."documentId"
    from public.archivefiles f
    where f."tenantId" = '877bf5ec-fd93-4ea1-8e55-280e320f32aa'::uuid
      and f."documentId" is not null
      and f."archiveId" in (
        select c."archiveId" from public.claimcandidates c
        where c."tenantId" = '877bf5ec-fd93-4ea1-8e55-280e320f32aa'::uuid
          and c."archiveId" is not null
      )
  );

-- 3b. Claims (claimfindings + claimsupplements CASCADE)
delete from public.insuranceclaims
where "tenantId" = '877bf5ec-fd93-4ea1-8e55-280e320f32aa'::uuid;

-- 3c. Claim candidates
delete from public.claimcandidates
where "tenantId" = '877bf5ec-fd93-4ea1-8e55-280e320f32aa'::uuid;

-- 3d. The claim-linked archive ingestion (archivefiles CASCADE)
delete from public.archiveingestions
where "_id" = '63f19014-79da-420d-8c3c-1f650874f84a'::uuid;
