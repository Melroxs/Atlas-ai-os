// Summarize a raw run-db-sql.mjs JSON dump of the webhook event ledger.
// Read-only reporting helper; touches no database directly.
import { readFileSync } from "node:fs";

const raw = readFileSync(process.argv[2], "utf8");
const rows = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1));

console.log("total ledger rows:", rows.length);

const byResult = {};
for (const r of rows) byResult[r.result] = (byResult[r.result] || 0) + 1;
console.log("by result:", byResult);

const byType = {};
for (const r of rows) byType[r.event_type] = (byType[r.event_type] || 0) + 1;
console.log("by event type:");
for (const [k, v] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
  console.log("  " + k.padEnd(38) + v);
}

const seen = new Map();
for (const r of rows) seen.set(r.provider_event_id, (seen.get(r.provider_event_id) || 0) + 1);
const dups = [...seen.entries()].filter(([, n]) => n > 1);
console.log("repeated provider_event_id:", dups.length ? dups : "none");

const processed = rows.filter((r) => r.result === "processed");
console.log("entitlement-changing events:", processed.length);
for (const r of processed.slice(0, 8)) {
  console.log("  " + r.event_type.padEnd(34) + String(r.note).slice(0, 90));
}
