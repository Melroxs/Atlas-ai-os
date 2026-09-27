// READ-ONLY: list Supabase Storage buckets and per-bucket object counts.
const URL = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HEADERS = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };

const res = await fetch(`${URL}/storage/v1/bucket`, { headers: HEADERS });
if (!res.ok) { console.error("HTTP", res.status, (await res.text()).slice(0, 300)); process.exit(1); }
const buckets = await res.json();
for (const b of buckets) {
  const list = await fetch(
    `${URL}/storage/v1/object/list/${b.id}?limit=1000`,
    { headers: HEADERS },
  );
  const body = list.ok ? await list.json() : null;
  console.log(
    b.id,
    "| public=" + b.public,
    "| objects(first page)=" + (Array.isArray(body) ? body.length : "n/a"),
  );
}
