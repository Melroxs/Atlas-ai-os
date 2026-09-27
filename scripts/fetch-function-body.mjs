// Fetch the deployed body of an edge function to compare with the repo (read-only).
const slug = process.argv[2] || "admin-provision-user";
const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF || "ibxvzxblyhzwokljkslt";

const res = await fetch(
  `https://api.supabase.com/v1/projects/${ref}/functions/${slug}/body`,
  { headers: { Authorization: `Bearer ${token}` } },
);

if (!res.ok) {
  console.error("HTTP", res.status, await res.text());
  process.exit(1);
}

const body = await res.text();
console.log(`bytes=${body.length}`);
console.log("--- actions / switch cases ---");
for (const m of body.matchAll(/case\s+"([a-z_]+)"/g)) console.log("case:", m[1]);
console.log("--- complimentary markers ---");
for (const m of body.matchAll(/.*(complimentary|pilot).*/gi)) {
  const line = m[0].trim();
  if (line) console.log(line.slice(0, 160));
}
