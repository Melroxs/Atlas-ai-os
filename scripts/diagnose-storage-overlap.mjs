// Diagnose the storage collateral damage: did the deleted claim paths overlap
// the paths that surviving Test Company rows still reference?
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("scripts/sql/storage-manifest.json", "utf8"));
const survivors = JSON.parse(readFileSync("scripts/sql/storage-survivors.json", "utf8"));

for (const bucket of ["documents", "archives"]) {
  const deleted = new Set(manifest.testCompanyClaimObjects[bucket] ?? []);
  const kept = survivors[bucket] ?? [];
  const overlap = kept.filter((p) => deleted.has(p));
  console.log(`\n[${bucket}]`);
  console.log(`  deleted claim paths: ${deleted.size}`);
  console.log(`  surviving referenced paths: ${kept.length}`);
  console.log(`  OVERLAP (deleted but still referenced): ${overlap.length}`);
  if (overlap.length) console.log(`    ${overlap.slice(0, 4).join("\n    ")}`);
}

// Do documents and archivefiles share storage paths at all?
const docSet = new Set(survivors.documents ?? []);
const shared = (survivors.archives ?? []).filter((p) => docSet.has(p));
console.log(`\nsurviving paths shared between documents and archivefiles: ${shared.length}`);
