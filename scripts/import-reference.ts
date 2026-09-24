// Downloads the public DOH Abu Dhabi reference lists and schemas, parses them and writes the
// snapshots in server/src/data/ref (committed, so the app works offline).
// Run: npm run import-ref
import { REF_DIR, SOURCES, fetchSource, readManifest, saveSources, type FetchedSource } from "../server/src/data/ref-import.ts";

const before = new Map((readManifest()?.sources ?? []).map((s) => [s.name, s.contentSha256]));
const fetched: FetchedSource[] = [];
let failed = 0;
for (const source of SOURCES) {
  try {
    const f = await fetchSource(source);
    fetched.push(f);
    const status = !before.has(source.name) ? "new" : before.get(source.name) === f.entry.contentSha256 ? "unchanged" : "updated";
    console.log(`${status.padEnd(9)} ${source.label.padEnd(30)} ${String(f.entry.records).padStart(6)} records  ${(f.entry.downloadedBytes / 1024).toFixed(0)} KB`);
  } catch (error) {
    failed++;
    console.error(`failed    ${source.label.padEnd(30)} ${(error as Error).message}`);
  }
}
if (fetched.length) await saveSources(fetched);
console.log(`\nSnapshots in ${REF_DIR}${failed ? ` (${failed} source(s) kept from the previous import)` : ""}`);
if (failed) process.exitCode = 1;
