// Runs fully offline: embedded Postgres in memory + the deterministic AI engine.
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { sampleCode } from "../server/src/ai/coding.ts";
import { guardSql } from "../server/src/ai/copilot.ts";
import { extractJson } from "../server/src/ai/llm.ts";
import { createApp } from "../server/src/app.ts";
import { bootstrap } from "../server/src/bootstrap.ts";
import { BASE_NOTES, renderNote } from "../server/src/data/notes.ts";
import { createStore } from "../server/src/db.ts";
import type { Claim, Denial } from "../server/src/domain/types.ts";
import { validateClaimXml } from "../server/src/xml/claim-xml.ts";

const call = async (path: string, init: { user?: string; json?: unknown; method?: string } = {}) => {
  const res = await app.request(`/api${path}`, {
    method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
    headers: { "X-Sanad-User": init.user ?? "u_aisha", "Content-Type": "application/json" },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

// Top-level setup: seeded once, shared by all suites.
const ctx = await bootstrap({ aiMode: "sample", adjudicationDelaySeconds: 0, databaseUrl: undefined }, await createStore({}));
await ctx.reset({ historical: 300 });
const app = createApp({ platform: ctx.platform, reset: () => ctx.reset({ historical: 300 }), releaseRemittances: ctx.releaseRemittances }, { allowedOrigins: [] });
after(async () => {
  await ctx.store.close();
});

describe("AI coding (offline engine)", () => {
  test("gold set: correct principal diagnosis on at least 80% of notes, all evidence verbatim", () => {
    let correct = 0;
    for (const base of BASE_NOTES) {
      const note = renderNote(base, "right", 45);
      const result = sampleCode({ note, age: 45, gender: "F", encounterType: "outpatient", specialty: base.specialty });
      if (result.suggestions.find((s) => s.role === "principal")?.code === base.gold("right").principal) correct++;
      for (const s of result.suggestions) for (const e of s.evidence) assert.equal(note.slice(e.start, e.end), e.text);
    }
    assert.ok(correct / BASE_NOTES.length >= 0.8, `principal accuracy ${correct}/${BASE_NOTES.length}`);
  });
  test("uncertain diagnoses are not coded; negated findings are skipped", () => {
    const r = sampleCode({ note: "Assessment: Pain in the right knee with suspected medial meniscus tear. No history of hypertension.", age: 40, gender: "M", encounterType: "outpatient", specialty: "Orthopaedics" });
    const codes = r.suggestions.map((s) => s.code);
    assert.ok(codes.includes("M25.561"));
    assert.ok(!codes.includes("S83.241A"));
    assert.ok(!codes.includes("I10"));
  });
  test("missing specificity raises a doctor query", () => {
    const r = sampleCode({ note: "Follow-up consultation for diabetes. Assessment: Diabetes mellitus, stable.", age: 60, gender: "F", encounterType: "outpatient", specialty: "GP" });
    assert.ok(r.gaps.some((g) => /diabetes type/i.test(g.question)));
  });
});

describe("Scrubber", () => {
  test("catches every seeded error family with no false flags on clean controls", async () => {
    const claims = await ctx.store.list<Claim>(ctx.platform.org, "claims");
    const seeded = claims.filter((c) => c.seed?.errors?.length);
    const controls = claims.filter((c) => c.seed?.errors && c.seed.errors.length === 0);
    assert.equal(seeded.length, 30);
    for (const c of seeded) assert.ok(c.issues?.some((i) => i.family === c.seed?.errors?.[0]), `${c.id} missed ${c.seed?.errors?.[0]}`);
    for (const c of controls) assert.equal(c.issues?.length ?? 0, 0, `${c.id} false flag ${c.issues?.map((i) => i.rule)}`);
  });
});

describe("XML", () => {
  test("generated claim XML validates against the pinned schema; broken XML does not", async () => {
    const claim = (await ctx.store.list<Claim>(ctx.platform.org, "claims")).find((c) => c.seed?.errors?.length === 0) as Claim;
    const xml = ctx.platform.claimXml(claim, await ctx.platform.patient(claim.patientId));
    assert.deepEqual(validateClaimXml(xml), []);
    assert.ok(validateClaimXml(xml.replace(/<Net>[^<]+<\/Net>/, "<Net>abc</Net>")).length > 0);
    assert.ok(validateClaimXml(xml.replace(/<Clinician>[^<]+<\/Clinician>/g, "")).some((e) => /Clinician is required/.test(e.message)));
  });
});

describe("End-to-end loop through the mock gateway", () => {
  test("note → coded claim → fixes → approved submission → remittance → denial → resubmission", async () => {
    const coded = await call("/encounters/enc_0001/code", { json: {} });
    assert.equal(coded.status, 200);
    assert.equal(coded.body.suggestions.find((s: any) => s.role === "principal").code, "M17.11");
    for (const s of coded.body.suggestions) await call(`/encounters/enc_0001/suggestions/${s.id}`, { json: { decision: "accepted" } });
    let claim = (await call("/encounters/enc_0001/claim", { json: {} })).body as Claim;
    assert.deepEqual(claim.issues?.map((i) => i.rule).sort(), ["AUTH-REQUIRED", "PRICE-CONTRACT"]);
    for (const issue of [...(claim.issues ?? [])]) claim = (await call(`/claims/${claim.id}/fix/${issue.id}`, { json: {} })).body;
    assert.equal(claim.cleanClaimScore, 100);

    assert.equal((await call("/claims/submit", { json: { claimIds: [claim.id] } })).status, 422, "approval flag required");
    assert.equal((await call("/claims/submit", { user: "u_rahul", json: { claimIds: [claim.id], confirm: true } })).status, 403, "coders cannot submit");
    const submitted = await call("/claims/submit", { json: { claimIds: [claim.id], confirm: true } });
    assert.deepEqual(submitted.body.submitted, [claim.id]);

    const released = await call("/demo/release-remittances", { json: {} });
    assert.ok(released.body.ingested >= 1);
    const paid = (await call(`/claims/${claim.id}`)).body.claim;
    assert.equal(paid.status, "paid");
    assert.equal(paid.approvedBy, "u_aisha");

    const denials = (await call("/denials?status=open")).body as Denial[];
    assert.equal(denials.length, 15);
    assert.ok(new Set(denials.map((d) => d.category)).size >= 7, "seeded denials span the PRD categories");
    assert.ok(denials.every((d) => d.category), "every seeded denial is classified");
    assert.ok(denials[0].priorityScore >= denials[1].priorityScore);

    const top = denials[0];
    const drafted = (await call(`/denials/${top.id}/draft`, { json: {} })).body as Denial;
    assert.ok(drafted.draft && drafted.draft.ms < 20_000);
    const encounterNote = (await call(`/denials/${top.id}`)).body.note as string;
    for (const j of drafted.draft?.justification ?? []) for (const c of j.citations) assert.ok(encounterNote.includes(c.quote), "every citation is verbatim from the note");

    const resub = await call(`/denials/${top.id}/resubmit`, { json: { type: "internal complaint", comment: `${drafted.draft?.summary} ${drafted.draft?.justification.map((j) => j.sentence).join(" ")}`, applyFixes: true, confirm: true } });
    assert.equal(resub.body.denial.status, "resubmitted");
    assert.equal((await call(`/denials/${denials[1].id}/write-off`, { json: { reason: "" } })).status, 422, "write-off reason is mandatory");
  });

  test("underpayments are detected in reconciliation and exported to Excel", async () => {
    const rec = (await call("/reconciliation", { user: "u_omar" })).body;
    assert.ok(rec.underpayments.filter((l: any) => !l.id.startsWith("ra_h")).length >= 5);
    assert.equal(rec.matchRate, 1);
    const res = await app.request("/api/reconciliation/export.xlsx", { headers: { "X-Sanad-User": "u_omar" } });
    assert.equal(res.status, 200);
    assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 2).toString(), "PK");
  });
});

describe("Security and guardrails", () => {
  test("copilot SQL guard only allows single SELECTs over analytics views", () => {
    assert.ok(guardSql("SELECT payer_name FROM v_claims").endsWith("LIMIT 200"));
    for (const bad of ["DELETE FROM v_claims", "SELECT * FROM records", "SELECT 1; DROP TABLE records", "SELECT current_setting('sanad.org')", "SELECT 1"])
      assert.throws(() => guardSql(bad));
  });
  test("copilot answers are tenant scoped and cite their query", async () => {
    const a = (await call("/copilot/query", { user: "u_omar", json: { question: "Which payer underpays us most?" } })).body;
    assert.match(a.sql, /v_remittance_lines/);
    assert.ok(a.rows.length > 0);
    const other = await ctx.store.readOnly("another_org", "SELECT count(*)::int AS n FROM v_claims");
    assert.equal(other.rows[0].n, 0);
  });
  test("Emirates ID is encrypted at rest and never returned by the API", async () => {
    const raw = await ctx.store.get<any>(ctx.platform.org, "patients", "pat_001");
    assert.ok(!/784-0000/.test(raw.emiratesIdEnc));
    const listed = (await call("/patients?q=pat_001")).body[0];
    assert.equal(listed.emiratesIdEnc, undefined);
  });
  test("audit log is hash-chained and verifies", async () => {
    const v = (await call("/audit/verify", { user: "u_admin" })).body;
    assert.equal(v.ok, true);
    assert.ok(v.count > 5);
  });
  test("share links expose minimal data without login", async () => {
    const claim = (await ctx.store.list<Claim>(ctx.platform.org, "claims")).find((c) => c.status === "paid" && !c.historical) as Claim;
    const link = (await call("/share", { user: "u_noor", json: { claimId: claim.id } })).body;
    const res = await app.request(`/api/share/${link.id}`);
    const view = (await res.json()) as any;
    assert.equal(res.status, 200);
    assert.equal(view.firstName.includes(" "), false);
    assert.equal(JSON.stringify(view).includes("784-"), false);
  });
  test("EMR push is idempotent on the FHIR resource id", async () => {
    const body = { resourceType: "Encounter", id: "emr-42", subject: { reference: "Patient/pat_002" }, participant: [{ individual: { reference: "Practitioner/cl_1" } }], period: { start: "2026-09-20" }, class: { code: "AMB" }, text: { div: "<div>Follow-up consultation for hypertension. Assessment: Essential hypertension.</div>" } };
    const first = await call("/fhir/Encounter", { user: "u_noor", json: body });
    const second = await call("/fhir/Encounter", { user: "u_noor", json: body });
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(first.body.id, second.body.id);
  });
  test("model replies are parsed even with think blocks and fences", () => {
    assert.deepEqual(extractJson('<think>hmm</think>```json\n{"a":1}\n```'), { a: 1 });
  });
});
