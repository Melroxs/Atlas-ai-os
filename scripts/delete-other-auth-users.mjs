// Delete every Supabase Auth account except Melissa's.
// Hard guards: Melissa must be present, and exactly 26 accounts must be slated
// for deletion. Anything else aborts before a single delete is issued.
const URL = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !SERVICE) { console.error("missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(2); }

const KEEP_EMAIL = "melissa.o.rox@gmail.com";
const EXPECTED_DELETE = 26;

const HEADERS = {
  apikey: SERVICE,
  Authorization: `Bearer ${SERVICE}`,
  "Content-Type": "application/json",
};

async function listUsers() {
  const all = [];
  let page = 1;
  for (;;) {
    const res = await fetch(`${URL}/auth/v1/admin/users?page=${page}&per_page=1000`, { headers: HEADERS });
    if (!res.ok) throw new Error(`list users HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json();
    const users = body.users ?? [];
    all.push(...users);
    if (users.length < 1000) break;
    page += 1;
  }
  return all;
}

const users = await listUsers();
const melissa = users.filter((u) => (u.email ?? "").toLowerCase() === KEEP_EMAIL);
const doomed = users.filter((u) => (u.email ?? "").toLowerCase() !== KEEP_EMAIL);

if (melissa.length !== 1) {
  console.error(`ABORT: expected exactly 1 ${KEEP_EMAIL} auth account, found ${melissa.length}`);
  process.exit(1);
}
if (doomed.length !== EXPECTED_DELETE) {
  console.error(`ABORT: expected to delete ${EXPECTED_DELETE} auth accounts, found ${doomed.length}`);
  process.exit(1);
}

console.log(`deleting ${doomed.length} auth accounts, retaining ${melissa[0].email}`);

let deleted = 0;
const failures = [];
for (const u of doomed) {
  const res = await fetch(`${URL}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: HEADERS });
  if (res.ok || res.status === 404) {
    deleted += 1;
  } else {
    failures.push({ email: u.email, status: res.status, body: (await res.text().catch(() => "")).slice(0, 200) });
  }
}

console.log(`deleted: ${deleted}`);
if (failures.length) {
  console.error(`FAILED: ${failures.length}`);
  for (const f of failures) console.error(`  ${f.email} -> ${f.status} ${f.body}`);
  process.exit(1);
}
