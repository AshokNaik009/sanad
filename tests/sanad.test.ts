// Runs fully offline: embedded Postgres in memory + the deterministic AI engine.
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { sampleCode } from "../server/src/ai/coding.ts";
import { guardSql } from "../server/src/ai/copilot.ts";
import { extractJson } from "../server/src/ai/llm.ts";
import { createApp } from "../server/src/app.ts";
import { bootstrap } from "../server/src/bootstrap.ts";
import { lookupCode } from "../server/src/data/codeset.ts";
import { BASE_NOTES, renderNote } from "../server/src/data/notes.ts";
import { refDrugCount, reloadRefData } from "../server/src/data/ref-data.ts";
import { REF_DIR, SOURCES } from "../server/src/data/ref-import.ts";
import { DENIAL_INDEX, rebuildDenialCodes } from "../server/src/data/reference.ts";
import { createStore } from "../server/src/db.ts";
import type { Claim, Denial } from "../server/src/domain/types.ts";
import { scrubClaim } from "../server/src/rules/scrubber.ts";
import { RegulatorWatch } from "../server/src/services/regulator-watch.ts";
import { validateClaimXml } from "../server/src/xml/claim-xml.ts";
import { validateXml } from "../server/src/xml/xsd-check.ts";

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
const app = createApp({ platform: ctx.platform, agents: ctx.agents, reset: () => ctx.reset({ historical: 300 }), releaseRemittances: ctx.releaseRemittances }, { allowedOrigins: [] });
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

describe("Regulator data (DOH snapshots)", () => {
  test("denial codes are the official list, and every code the demo uses is on it", async () => {
    assert.ok(DENIAL_INDEX.size >= 50, `${DENIAL_INDEX.size} active codes`);
    assert.equal(DENIAL_INDEX.get("AUTH-001")?.text, "Prior approval is required and was not obtained");
    const all = await ctx.store.list<Denial>(ctx.platform.org, "denials");
    const unknown = [...new Set(all.map((d) => d.code))].filter((c) => !DENIAL_INDEX.has(c));
    assert.deepEqual(unknown, []);
  });
  test("drug codes resolve from the DOH drug list with regulated prices", () => {
    const amox = lookupCode("A54-4064-00334-01");
    assert.equal(amox?.type, "DRUG");
    assert.match(amox?.description ?? "", /PENAMOX/);
    assert.ok(refDrugCount() > 15000);
    assert.equal(lookupCode("DRG-0418-0001"), undefined, "no invented drug codes remain");
  });
  test("claims validate against the official ClaimSubmission schema; broken ones do not", async () => {
    const claim = (await ctx.store.list<Claim>(ctx.platform.org, "claims")).find((c) => c.seed?.errors?.length === 0) as Claim;
    const xml = ctx.platform.claimXml(claim, await ctx.platform.patient(claim.patientId));
    assert.deepEqual(validateXml(xml, "ClaimSubmission", { regulator: "DHA" }), []);
    const missing = validateXml(xml.replace(/<EmiratesIDNumber>[^<]*<\/EmiratesIDNumber>\s*/, ""), "ClaimSubmission", { regulator: "DHA" });
    assert.ok(missing.some((e) => /EmiratesIDNumber is required/.test(e.message)));
    const reordered = validateXml(xml.replace(/(<Gross>[^<]*<\/Gross>)(\s*)(<PatientShare>[^<]*<\/PatientShare>)/, "$3$2$1"), "ClaimSubmission", { regulator: "DHA" });
    assert.ok(reordered.some((e) => /out of order/.test(e.message)));
    const badType = validateXml(xml.replace(/(<Encounter>[\s\S]*?<Type>)\d+(<\/Type>)/, "$177$2"), "ClaimSubmission", { regulator: "DHA" });
    assert.ok(badType.some((e) => /not an allowed value/.test(e.message)));
  });
  test("the official DOH remittance layout validates and ingests", async () => {
    const sample = `<?xml version="1.0" encoding="utf-8"?><Remittance.Advice><Header><SenderID>A001</SenderID><ReceiverID>MF1100</ReceiverID><TransactionDate>06/01/2009 15:00</TransactionDate><RecordCount>1</RecordCount><DispositionFlag>PRODUCTION</DispositionFlag></Header><Claim><ID>123</ID><IDPayer>456</IDPayer><PaymentReference>45621</PaymentReference><Activity><Start>01/01/2009 13:00</Start><Type>3</Type><Code>0031T</Code><Quantity>1</Quantity><Net>4500</Net><Clinician>GD6476</Clinician><PriorAuthorizationID>1235</PriorAuthorizationID><Gross>5000</Gross><PatientShare>500</PatientShare><PaymentAmount>4500</PaymentAmount></Activity></Claim></Remittance.Advice>`;
    assert.deepEqual(validateXml(sample, "RemittanceAdvice"), []);
    const res = await app.request("/api/remittances/ingest", { method: "POST", headers: { "X-Sanad-User": "u_omar" }, body: sample });
    assert.equal(res.status, 200);
    const ra = (await res.json()) as any;
    assert.equal(ra.lineCount, 1);
    assert.equal(ra.matched, 0, "an unknown claim is kept as unmatched, not guessed");
  });
  test("drug lines billed above the regulated public price are blocked", async () => {
    const claim = structuredClone((await ctx.store.list<Claim>(ctx.platform.org, "claims")).find((c) => c.seed?.errors?.length === 0) as Claim);
    claim.activities.push({ id: "act_drug", codeType: "DRUG", code: "A54-4064-00334-01", description: "Amoxicillin", quantity: 2, gross: 20, patientShare: 0, net: 20 });
    const patient = await ctx.platform.patient(claim.patientId);
    const issues = scrubClaim(claim, { patient, priorAuths: [], otherClaims: [], today: ctx.platform.today() }).issues;
    const ceiling = issues.find((i) => i.rule === "PRICE-DRUG-CEILING");
    assert.ok(ceiling, "AED 10 per capsule is above the AED 1.18 public price");
    assert.equal(ceiling?.autoFix?.value, 1.18);
  });
});

describe("Agents: proposals, autopilot, copilot tools", () => {
  test("autopilot drafts open denials into proposals; nothing is sent until approved", async () => {
    const start = await call("/autopilot/start", { json: {} });
    assert.equal(start.status, 200);
    await ctx.agents.autopilot.settled();
    const job = (await call("/autopilot")).body.job;
    assert.equal(job.status, "done");
    assert.ok(job.proposed >= 1);
    const pending = (await call("/proposals?status=awaiting_review")).body as any[];
    assert.equal(pending.length, job.proposed);
    for (const p of pending) assert.equal((await ctx.platform.denial(p.entityId)).status, "open", "no appeal is sent by the job");

    const again = await call("/autopilot/start", { json: {} });
    await ctx.agents.autopilot.settled();
    assert.equal(again.body.total, 0, "a second run does not duplicate proposals");

    const p = pending[0];
    assert.equal((await call(`/proposals/${p.id}/decide`, { user: "u_omar", json: { hash: p.contentHash, approve: true } })).status, 403, "finance cannot send appeals");
    assert.equal((await call(`/proposals/${p.id}/decide`, { json: { hash: "0".repeat(64), approve: true } })).status, 409, "stale content is refused");
    const approved = await call(`/proposals/${p.id}/decide`, { json: { hash: p.contentHash, approve: true } });
    assert.equal(approved.body.status, "approved");
    assert.equal((await ctx.platform.denial(p.entityId)).status, "resubmitted");
    const declined = await call(`/proposals/${pending[1].id}/decide`, { json: { hash: pending[1].contentHash, approve: false, reason: "Will call the insurer first" } });
    assert.equal(declined.body.status, "declined");
    assert.equal((await ctx.platform.denial(pending[1].entityId)).status, "open");
    const actions = (await call("/audit", { user: "u_admin" })).body.map((e: any) => e.action);
    for (const a of ["autopilot.start", "proposal.create", "proposal.approve", "proposal.decline"]) assert.ok(actions.includes(a), a);
  });
  test("copilot routes to tools and returns cards; drafting respects roles", async () => {
    const code = (await call("/copilot/agent", { json: { question: "What does MNEC-003 mean?" } })).body;
    assert.equal(code.tool, "explain_denial_code");
    assert.equal(code.cards[0].text, "Service is not clinically indicated based on good clinical practice");
    const work = (await call("/copilot/agent", { json: { question: "Which denials should I work first?" } })).body;
    assert.equal(work.tool, "worklist");
    assert.ok(work.cards.every((c: any) => c.type === "denial"));
    const denied = (await call("/copilot/agent", { user: "u_omar", json: { question: "Draft appeals for Nahr denials" } })).body;
    assert.equal(denied.tool, "draft_appeals");
    assert.equal(denied.cards.length, 0);
    const data = (await call("/copilot/agent", { user: "u_omar", json: { question: "Which payer underpays us most?" } })).body;
    assert.equal(data.tool, "ask_data");
    assert.ok(data.sql);
  });
  test("payer memory flags services an insurer keeps denying, unless the claim already addresses it", async () => {
    const base = (await ctx.store.list<Claim>(ctx.platform.org, "claims")).find((c) => c.payerId === "payer_gulf" && !c.historical) as Claim;
    const history = Array.from({ length: 16 }, (_, i): Claim => ({
      ...structuredClone(base),
      id: `hist_risk_${i}`,
      historical: true,
      serviceDate: ctx.platform.today(),
      activities: [{ id: `a${i}`, codeType: "CPT", code: "96372", description: "", quantity: 1, gross: 60, patientShare: 0, net: 60, paid: i < 8 ? 0 : 60, denialCode: i < 8 ? "AUTH-001" : undefined }],
    }));
    await ctx.store.putMany(ctx.platform.org, "claims", history);
    ctx.platform.payerIntel.invalidate();
    const probe: Claim = { ...structuredClone(base), activities: [{ id: "p1", codeType: "CPT", code: "96372", description: "", quantity: 1, gross: 60, patientShare: 0, net: 60 }] };
    const [risk] = await ctx.platform.payerIntel.risksFor(probe);
    assert.equal(risk.category, "auth");
    assert.ok(risk.denialRate >= 0.25, `rate ${risk.denialRate}`);
    assert.equal(risk.mitigated, false);
    probe.activities[0].priorAuthNumber = "PA-1";
    assert.equal((await ctx.platform.payerIntel.risksFor(probe))[0].mitigated, true);
    for (const h of history) await ctx.store.remove(ctx.platform.org, "claims", h.id);
    ctx.platform.payerIntel.invalidate();
  });
  test("the public bill explainer is rate limited per visitor", async () => {
    const hit = () => app.request("/api/public/explain-bill", { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.9" }, body: "{}" });
    for (let i = 0; i < 6; i++) assert.equal((await hit()).status, 422);
    assert.equal((await hit()).status, 429);
  });
});

describe("Regulator Watch", () => {
  test("detects a changed list, saves it, reloads the rules and reports what changed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sanad-ref-"));
    await cp(REF_DIR, dir, { recursive: true });
    const current = JSON.parse(await readFile(join(dir, "denial-codes.json"), "utf8")) as { code: string; text: string }[];
    const next = [...current.filter((d) => d.code !== "COPY-001").map((d) => (d.code === "AUTH-001" ? { ...d, text: `${d.text} (revised)` } : d)), { code: "AUTH-099", text: "New test code", type: "Authorization", effective: "2026-09-01" }];
    const source = { ...SOURCES[0], parse: async () => ({ content: `${JSON.stringify(next, null, 1)}\n`, records: next.length }) };
    const watch = new RegulatorWatch(ctx.platform, { dir, sources: [source], fetcher: async () => new Uint8Array() });
    try {
      const check = await watch.check({ id: "u_admin", role: "admin" });
      const change = check.changes[0];
      assert.equal(change.status, "updated");
      assert.deepEqual([change.added, change.removed, change.changed], [["AUTH-099"], ["COPY-001"], ["AUTH-001"]]);
      assert.equal(DENIAL_INDEX.get("AUTH-099")?.category, "auth", "rules reload in place");
      assert.equal((await watch.check({ id: "u_admin", role: "admin" })).changes[0].status, "unchanged");
    } finally {
      reloadRefData();
      rebuildDenialCodes();
      await rm(dir, { recursive: true, force: true });
    }
    assert.equal(DENIAL_INDEX.get("AUTH-099"), undefined);
  });
});
