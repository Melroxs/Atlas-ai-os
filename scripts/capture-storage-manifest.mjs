// READ-ONLY. Captures every Supabase Storage object path that the approved
// deletion will orphan, BEFORE the owning DB rows are removed.
// Writes scripts/sql/storage-manifest.json. Never prints secrets.
import { writeFileSync } from "node:fs";

const URL = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !SERVICE) {
  console.error("missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}

const HEADERS = {
  apikey: SERVICE,
  Authorization: `Bearer ${SERVICE}`,
  "Content-Type": "application/json",
};

// The 23 organizations approved for deletion (everything except Test Company).
const DOOMED_TENANTS = [
  "3e7d920e-1a29-4132-9d38-ab54d2e34608",
  "8af74d5d-633d-44f7-a389-5b060dc05f4b",
  "9e23afde-47d7-4a38-bb7f-8c34faa7a71e",
  "e9c822b5-2e67-4ddd-bd92-e95555516c99",
  "9695f882-3d7c-4b71-8500-d3e387b7f4d8",
  "53a45c29-6dbb-47a5-92b4-b23a2d3a5e77",
  "1bf50956-5c80-4c14-9f60-754c05fcfdcf",
  "2f375609-ac36-42bc-a2d9-b3a2481788a0",
  "62d0afa5-51b5-4dd1-9d2e-0fcd80c19a23",
  "20196f69-623e-4604-9909-a18307f71eef",
  "b8b77d96-dad5-4974-b048-f771a56259a1",
  "e86efc11-d2c7-472b-b48f-44dbc736b991",
  "6c916f83-65e9-435d-ad12-2e94dbb881df",
  "4039d468-d5e0-401f-9032-63cee87df813",
  "8a6a9324-d129-47d4-9a2f-c3295f963ed5",
  "e9245e53-1041-4aa0-ac5c-0d72d13c0fcd",
  "51c90a16-0546-43c9-b06a-2cc41a604791",
  "6379923e-4997-4a6a-a75d-6cf20fd1c993",
  "af50e85e-bd93-414b-a5c4-7c4062554cd4",
  "1db79348-b00b-4fe6-94cf-5ef1a5f3a2e1",
  "e1acc8c3-bba3-45ea-ab1f-99bf78fe8c34",
  "7185e3c5-bd99-46eb-8183-058d70be2bdd",
  "de81d0ca-b47d-45c0-b877-677b8f466f75",
];

const TEST_COMPANY = "877bf5ec-fd93-4ea1-8e55-280e320f32aa";

async function rest(path) {
  const res = await fetch(`${URL}/rest/v1/${path}`, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`REST ${res.status} on ${path}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

async function listFolder(bucket, folder) {
  const out = [];
  let offset = 0;
  for (;;) {
    const res = await fetch(`${URL}/storage/v1/object/list/${bucket}`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ prefix: `${folder}/`, limit: 1000, offset }),
    });
    if (!res.ok) {
      throw new Error(`storage list ${res.status} ${bucket}/${folder}: ${(await res.text()).slice(0, 200)}`);
    }
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;
    for (const o of page) {
      if (o && o.name) out.push(`${folder}/${o.name}`);
    }
    if (page.length < 1000) break;
    offset += 1000;
  }
  return out;
}

const manifest = {
  capturedAt: new Date().toISOString(),
  doomedTenants: DOOMED_TENANTS,
  testCompany: TEST_COMPANY,
  doomedObjects: {},   // bucket -> [paths]
  testCompanyClaimObjects: {}, // bucket -> [paths]
  counts: {},
};

// 1. Everything under each doomed tenant folder, in the two data buckets.
for (const bucket of ["documents", "archives"]) {
  const all = [];
  for (const t of DOOMED_TENANTS) {
    const found = await listFolder(bucket, t);
    all.push(...found);
  }
  manifest.doomedObjects[bucket] = all;
}

// 2. Test Company: only the claim-linked documents and archive files.
const tc = "tenantId=eq." + TEST_COMPANY;

// Claim-linked archive ingestion ids.
const candidates = await rest(
  `claimcandidates?select=archiveId&${tc}&archiveId=not.is.null`,
);
const claimIngestionIds = [...new Set(candidates.map((c) => c.archiveId).filter(Boolean))];

// Archive files belonging to those ingestions.
let claimFiles = [];
if (claimIngestionIds.length) {
  claimFiles = await rest(
    `archivefiles?select=_id,storageId,documentId&${tc}&archiveId=in.(${claimIngestionIds.join(",")})`,
  );
}

// Their documents.
const claimDocIds = claimFiles.map((f) => f.documentId).filter(Boolean);
let claimDocs = [];
if (claimDocIds.length) {
  claimDocs = await rest(`documents?select=storageId&_id=in.(${claimDocIds.join(",")})`);
}

const claimArchivePaths = claimFiles.map((f) => f.storageId).filter(Boolean);
const claimDocPaths = claimDocs.map((d) => d.storageId).filter(Boolean);

manifest.testCompanyClaimObjects.archives = claimArchivePaths;
manifest.testCompanyClaimObjects.documents = claimDocPaths;
manifest.counts = {
  claimIngestionIds: claimIngestionIds.length,
  claimArchiveFiles: claimFiles.length,
  claimArchivePaths: claimArchivePaths.length,
  claimDocuments: claimDocs.length,
  claimDocPaths: claimDocPaths.length,
  doomedDocumentsObjects: manifest.doomedObjects.documents.length,
  doomedArchivesObjects: manifest.doomedObjects.archives.length,
};

writeFileSync("scripts/sql/storage-manifest.json", JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest.counts, null, 2));
console.log("claim ingestion ids:", claimIngestionIds.join(", "));
console.log("wrote scripts/sql/storage-manifest.json");
