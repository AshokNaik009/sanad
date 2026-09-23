// Hackathon evaluation (PRD section 7): coding gold set, seeded scrubber errors, denial triage,
// resubmission drafts and reconciliation. Uses an in-memory database so it never touches the
// demo data. AI_MODE=model evaluates the configured provider chain instead of the offline engine.
import { suggestCodes } from "../server/src/ai/coding.ts";
import { Llm } from "../server/src/ai/llm.ts";
import { bootstrap } from "../server/src/bootstrap.ts";
import { readConfig } from "../server/src/config.ts";
import { BASE_NOTES, renderNote } from "../server/src/data/notes.ts";
import { createStore } from "../server/src/db.ts";
import type { Claim, Denial, RemittanceLine } from "../server/src/domain/types.ts";

const store = await createStore({});
const mode = (process.env.AI_MODE ?? "sample") as "sample" | "model";
const { platform, reset, releaseRemittances } = await bootstrap({ aiMode: mode, adjudicationDelaySeconds: 0, databaseUrl: undefined }, store);
const llm = new Llm({ ...readConfig(), aiMode: mode }, store);
console.log(`Engine: ${llm.label}\n`);
await reset({ historical: 300 });

// 1. Coding gold set (20 notes)
let principal = 0;
let tp = 0;
let fp = 0;
let fn = 0;
let evidenceOk = true;
for (const base of BASE_NOTES) {
  const note = renderNote(base, "right", 45);
  const gold = base.gold("right");
  const r = await suggestCodes(llm, { note, age: 45, gender: "F", encounterType: "outpatient", specialty: base.specialty });
  if (r.suggestions.find((s) => s.role === "principal")?.code === gold.principal) principal++;
  const procs = new Set(r.suggestions.filter((s) => s.codeType !== "ICD10").map((s) => s.code));
  for (const p of gold.procedures) procs.has(p) ? tp++ : fn++;
  for (const p of procs) if (!gold.procedures.includes(p)) fp++;
  for (const s of r.suggestions) if (!s.evidence.length || s.evidence.some((e) => note.slice(e.start, e.end) !== e.text)) evidenceOk = false;
}

// 2. Scrubber on 30 seeded errors + 10 clean controls
const claims = await store.list<Claim>(platform.org, "claims");
const seeded = claims.filter((c) => c.seed?.errors?.length);
const controls = claims.filter((c) => c.seed?.errors && c.seed.errors.length === 0);
const caught = seeded.filter((c) => c.issues?.some((i) => i.family === c.seed?.errors?.[0])).length;
const falseFlags = controls.filter((c) => c.issues?.length).length;

// 3. Denials from the seeded remittance run
await releaseRemittances();
await platform.pollRemittances();
const denials = await platform.listDenials({ status: "open" });
const classified = denials.filter((d) => d.category).length;
const drafts: { code: string; ms: number; cited: number; blocked: number }[] = [];
for (const d of denials) {
  const out = (await platform.draftDenial(d.id, { id: "eval", role: "system" })).draft;
  if (out) drafts.push({ code: d.code, ms: out.ms, cited: out.justification.length, blocked: out.blockedSentences.length });
}

// 4. Reconciliation
const lines = (await store.list<RemittanceLine>(platform.org, "remittance_lines")).filter((l) => !l.id.startsWith("ra_h"));
const underpaidSeeded = claims.filter((c) => c.seed?.underpay).map((c) => c.id);
const flagged = new Set(lines.filter((l) => l.status === "underpaid").map((l) => l.claimId));

const pct = (n: number, d: number) => `${((n / Math.max(1, d)) * 100).toFixed(0)}%`;
const rows: [string, string, string, boolean][] = [
  ["Coding: correct principal ICD-10 (20 gold notes)", `${principal}/20 (${pct(principal, 20)})`, "≥ 80%", principal >= 16],
  ["Coding: procedure precision / recall", `${pct(tp, tp + fp)} / ${pct(tp, tp + fn)}`, "report", true],
  ["Coding: every code shows verbatim evidence", evidenceOk ? "yes" : "no", "yes", evidenceOk],
  ["Scrubber: seeded errors caught", `${caught}/30 (${pct(caught, 30)})`, "≥ 90%", caught >= 27],
  ["Scrubber: false flags on clean controls", `${falseFlags}/${controls.length}`, "≤ 10%", falseFlags <= controls.length * 0.1],
  ["Denials: seeded denials classified", `${classified}/${denials.length}`, "100% of 15", classified === 15 && denials.length === 15],
  ["Drafts: slowest resubmission draft", `${(Math.max(...drafts.map((d) => d.ms)) / 1000).toFixed(1)} s`, "< 20 s", drafts.every((d) => d.ms < 20_000)],
  ["Drafts: sentences blocked for missing citations", `${drafts.reduce((s, d) => s + d.blocked, 0)}`, "report", true],
  ["Reconciliation: remittance lines auto-matched", `${lines.filter((l) => l.matched).length}/${lines.length}`, "100%", lines.every((l) => l.matched)],
  ["Reconciliation: seeded underpayments flagged", `${underpaidSeeded.filter((id) => flagged.has(id)).length}/5`, "5/5", underpaidSeeded.every((id) => flagged.has(id))],
];
const width = Math.max(...rows.map((r) => r[0].length));
for (const [name, value, target, ok] of rows) console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(width)}  ${value.padEnd(16)} target ${target}`);
await store.close();
if (rows.some((r) => !r[3])) process.exitCode = 1;
