import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import { EXAMPLE_QUESTIONS, askCopilot } from "./ai/copilot.ts";
import { CODES } from "./data/codeset.ts";
import { CATEGORY_LABEL, CLINICIANS, DENIAL_INDEX, ORGANIZATION, PAYERS, USERS, clinicianById } from "./data/reference.ts";
import type { AuditEvent, Claim, Denial, DocumentationQuery, Encounter, Notification, Patient, PriorAuth, Remittance, Role, User } from "./domain/types.ts";
import { dashboard, forecast, reconciliation, reconciliationWorkbook } from "./services/analytics.ts";
import type { Actor } from "./services/audit.ts";
import type { Platform } from "./services/platform.ts";
import { AppError } from "./util.ts";

type Env = { Variables: { user: User; actor: Actor } };

/** Least-privilege permission map (PRD section 9). */
const CAN: Record<string, Role[]> = {
  read: ["biller", "coder", "doctor", "finance", "frontdesk", "admin"],
  code: ["coder", "biller", "admin"],
  intake: ["coder", "biller", "frontdesk", "admin"],
  answerQuery: ["doctor", "admin"],
  editClaim: ["coder", "biller", "admin"],
  submit: ["biller", "admin"],
  denials: ["biller", "admin"],
  remittance: ["biller", "finance", "admin"],
  finance: ["finance", "biller", "admin"],
  frontdesk: ["frontdesk", "biller", "admin"],
  audit: ["admin", "finance"],
  demo: ["admin", "biller", "finance"],
  reset: ["admin"],
};

export interface AppDeps {
  platform: Platform;
  reset: () => Promise<unknown>;
  releaseRemittances: () => Promise<{ released: number }>;
  accessKey?: string;
}

const maskPatient = (p: Patient) => {
  const { emiratesIdEnc, ...rest } = p;
  return rest;
};

export function createApi(deps: AppDeps) {
  const { platform } = deps;
  const { store, org } = platform;
  const api = new Hono<Env>();

  api.use("*", bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => c.json({ error: "Request too large" }, 413) }));

  // Public, no-login patient share page (minimal data, expiring token).
  api.get("/share/:token", async (c) => c.json(await platform.sharedView(c.req.param("token"))));
  api.get("/health", async (c) => c.json({ ok: true, ai: platform.llm.label, gateway: platform.gateway.name, org: ORGANIZATION.name }));

  // MVP identity: a seeded user id plus an optional shared access key. Replace with SSO before a pilot.
  api.use("*", async (c, next) => {
    if (deps.accessKey) {
      const given = Buffer.from(c.req.header("Authorization")?.replace(/^Bearer /, "") ?? "");
      const want = Buffer.from(deps.accessKey);
      if (given.length !== want.length || !timingSafeEqual(given, want)) throw new AppError("Unauthorized", 401);
    }
    const user = USERS.find((u) => u.id === (c.req.header("X-Sanad-User") ?? c.req.query("as")));
    if (!user) throw new AppError("Unknown user; send X-Sanad-User", 401);
    c.set("user", user);
    c.set("actor", { id: user.id, role: user.role });
    await next();
  });
  const allow = (perm: keyof typeof CAN) => async (c: { get: (k: "user") => User }, next: () => Promise<void>) => {
    if (!CAN[perm].includes(c.get("user").role)) throw new AppError(`Your role cannot ${perm}`, 403);
    await next();
  };

  const body = async <S extends z.ZodType>(c: { req: { json: () => Promise<unknown> } }, schema: S): Promise<z.output<S>> =>
    schema.parse(await c.req.json().catch(() => ({})));

  api.get("/me", (c) => c.json({ user: c.get("user"), users: USERS, ai: platform.llm.engine, aiLabel: platform.llm.label, organization: ORGANIZATION }));
  api.get("/reference", allow("read"), (c) =>
    c.json({
      payers: PAYERS.map(({ id, name, authRequired, submissionWindowDays, resubmissionWindowDays, plans }) => ({ id, name, authRequired, submissionWindowDays, resubmissionWindowDays, plans })),
      clinicians: CLINICIANS,
      codes: CODES.filter((x) => x.active).map(({ code, type, description, plain }) => ({ code, type, description, plain })),
      denialCodes: [...DENIAL_INDEX.values()],
      categories: CATEGORY_LABEL,
      examples: EXAMPLE_QUESTIONS,
    }),
  );

  // ------------------------------------------------------------------ Encounters and coding
  api.get("/encounters", allow("read"), async (c) => {
    const status = c.req.query("status");
    const list = status ? await store.find<Encounter>(org, "encounters", { status }) : await store.list<Encounter>(org, "encounters");
    const patients = new Map((await store.list<Patient>(org, "patients")).map((p) => [p.id, p]));
    const rows = list
      .map((e) => ({
        id: e.id,
        date: e.date,
        status: e.status,
        specialty: e.specialty,
        patient: patients.get(e.patientId)?.name,
        payer: PAYERS.find((p) => p.id === e.payerId)?.name,
        clinician: clinicianById(e.clinicianId).name,
        preview: e.note.slice(0, 140),
        suggestions: e.suggestions?.length ?? 0,
        gaps: e.gaps?.length ?? 0,
        gold: !!e.gold,
        claimId: e.claimId,
      }))
      .sort((a, b) => Number(b.gold) - Number(a.gold) || b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
    return c.json(rows);
  });
  api.get("/encounters/:id", allow("read"), async (c) => {
    const e = await platform.encounter(c.req.param("id"));
    const patient = await platform.patient(e.patientId);
    const queries = await store.find<DocumentationQuery>(org, "doc_queries", { encounterId: e.id });
    const priorAuths = await store.find<PriorAuth>(org, "prior_auths", { patientId: e.patientId });
    return c.json({ ...e, patient: maskPatient(patient), clinician: clinicianById(e.clinicianId), payer: PAYERS.find((p) => p.id === e.payerId)?.name, queries, priorAuths });
  });
  const EncounterInput = z.object({
    patientId: z.string(),
    clinicianId: z.string(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    type: z.enum(["outpatient", "daycase", "emergency"]).default("outpatient"),
    note: z.string().min(20, "Clinical note must be at least 20 characters").max(20000),
    externalId: z.string().max(64).optional(),
  });
  api.post("/encounters", allow("intake"), async (c) => {
    const input = await body(c, EncounterInput);
    const result = await platform.createEncounter({ ...input, source: input.externalId ? "api" : "upload" }, c.get("actor"));
    return c.json(result.encounter, result.created ? 201 : 200);
  });
  // EMR push (M1.2): minimal FHIR R4 Encounter, idempotent on the resource id.
  api.post("/fhir/Encounter", allow("intake"), async (c) => {
    const fhir = (await c.req.json()) as Record<string, any>;
    if (fhir.resourceType !== "Encounter" || !fhir.id) throw new AppError("Expected a FHIR Encounter with an id", 422);
    const ref = (r?: string) => r?.split("/").pop() ?? "";
    const note = fhir.text?.div ? String(fhir.text.div).replace(/<[^>]+>/g, "") : fhir.extension?.find((x: any) => /note/i.test(x.url))?.valueString;
    const result = await platform.createEncounter(
      {
        externalId: String(fhir.id),
        patientId: ref(fhir.subject?.reference),
        clinicianId: ref(fhir.participant?.[0]?.individual?.reference),
        date: String(fhir.period?.start ?? "").slice(0, 10),
        type: fhir.class?.code === "EMER" ? "emergency" : fhir.class?.code === "SS" ? "daycase" : "outpatient",
        note: String(note ?? ""),
        source: "fhir",
      },
      c.get("actor"),
    );
    return c.json({ id: result.encounter.id, created: result.created }, result.created ? 201 : 200);
  });
  api.post("/encounters/:id/code", allow("code"), async (c) => c.json(await platform.codeEncounter(c.req.param("id"), c.get("actor"))));
  api.post("/encounters/:id/suggestions/:sid", allow("code"), async (c) => {
    const input = await body(c, z.object({ decision: z.enum(["accepted", "rejected", "edited"]), editedCode: z.string().optional() }));
    return c.json(await platform.decideSuggestion(c.req.param("id"), c.req.param("sid"), input.decision, c.get("actor"), input.editedCode));
  });
  api.post("/encounters/:id/codes", allow("code"), async (c) => {
    const input = await body(c, z.object({ code: z.string().min(2) }));
    return c.json(await platform.addManualCode(c.req.param("id"), input.code, c.get("actor")));
  });
  api.post("/encounters/:id/gaps/:gid/query", allow("code"), async (c) => c.json(await platform.raiseQuery(c.req.param("id"), c.req.param("gid"), c.get("actor"))));
  api.post("/encounters/:id/claim", allow("code"), async (c) => c.json(await platform.createClaimFromEncounter(c.req.param("id"), c.get("actor")), 201));

  api.get("/queries", allow("read"), async (c) => {
    const user = c.get("user");
    let queries = await store.list<DocumentationQuery>(org, "doc_queries");
    if (user.role === "doctor") queries = queries.filter((q) => q.clinicianId === user.clinicianId);
    const encounters = await Promise.all(queries.map((q) => store.get<Encounter>(org, "encounters", q.encounterId)));
    return c.json(queries.map((q, i) => ({ ...q, clinician: clinicianById(q.clinicianId).name, note: encounters[i]?.note, date: encounters[i]?.date })));
  });
  api.post("/queries/:id/answer", allow("answerQuery"), async (c) => {
    const input = await body(c, z.object({ answer: z.string().min(2).max(2000) }));
    const query = await platform.need<DocumentationQuery>("doc_queries", c.req.param("id"), "Query");
    const user = c.get("user");
    if (user.role === "doctor" && user.clinicianId !== query.clinicianId) throw new AppError("This query is addressed to another clinician", 403);
    return c.json(await platform.answerQuery(query.id, input.answer, c.get("actor")));
  });

  // ------------------------------------------------------------------ Claims
  api.get("/claims", allow("read"), async (c) => {
    const { status, payerId, include } = c.req.query();
    let claims = status ? await store.find<Claim>(org, "claims", { status }) : await store.list<Claim>(org, "claims");
    if (include !== "historical") claims = claims.filter((x) => !x.historical);
    if (payerId) claims = claims.filter((x) => x.payerId === payerId);
    const patients = new Map((await store.list<Patient>(org, "patients")).map((p) => [p.id, p.name]));
    return c.json(
      claims
        .map(({ activities, diagnoses, timeline, issues, ...x }) => ({
          ...x,
          patientName: patients.get(x.patientId),
          blocking: issues?.filter((i) => i.severity === "blocking").length ?? 0,
          warnings: issues?.filter((i) => i.severity === "warning").length ?? 0,
          codes: activities.map((a) => a.code).join(", "),
          principal: diagnoses.find((d) => d.type === "principal")?.code,
        }))
        .sort((a, b) => (b.submittedAt ?? b.serviceDate).localeCompare(a.submittedAt ?? a.serviceDate)),
    );
  });
  api.get("/claims/:id", allow("read"), async (c) => {
    const claim = await platform.claim(c.req.param("id"));
    const patient = await platform.patient(claim.patientId);
    const encounter = claim.encounterId ? await store.get<Encounter>(org, "encounters", claim.encounterId) : null;
    const denials = await store.find<Denial>(org, "denials", { claimId: claim.id });
    const priorAuths = await store.find<PriorAuth>(org, "prior_auths", { patientId: claim.patientId });
    const audit = await platform.audit.forEntity(org, claim.id);
    return c.json({ claim, patient: maskPatient(patient), note: encounter?.note, denials, priorAuths, audit, xml: platform.claimXml(claim, patient).replace(/784-\d{4}-\d{7}-\d/g, patient.emiratesIdMasked) });
  });
  const ClaimPatch = z.object({
    diagnoses: z.array(z.object({ code: z.string(), type: z.enum(["principal", "secondary"]), description: z.string().default("") })).optional(),
    activities: z.array(z.object({ id: z.string(), code: z.string(), quantity: z.number(), gross: z.number().nonnegative(), priorAuthNumber: z.string().optional() })).optional(),
  });
  api.patch("/claims/:id", allow("editClaim"), async (c) => c.json(await platform.updateClaim(c.req.param("id"), await body(c, ClaimPatch), c.get("actor"))));
  api.post("/claims/:id/scrub", allow("editClaim"), async (c) => c.json(await platform.scrub(c.req.param("id"), c.get("actor"))));
  api.post("/claims/:id/fix/:issueId", allow("editClaim"), async (c) => c.json(await platform.applyFix(c.req.param("id"), c.req.param("issueId"), c.get("actor"))));
  api.post("/claims/submit", allow("submit"), async (c) => {
    const input = await body(c, z.object({ claimIds: z.array(z.string()).min(1).max(200), confirm: z.literal(true, { error: "Explicit approval (confirm: true) is required" }) }));
    return c.json(await platform.submitClaims(input.claimIds, c.get("actor")));
  });

  // ------------------------------------------------------------------ Denials
  api.get("/denials", allow("read"), async (c) => c.json(await platform.listDenials({ status: c.req.query("status") })));
  api.get("/denials/:id", allow("read"), async (c) => {
    const denial = await platform.denial(c.req.param("id"));
    const claim = await platform.claim(denial.claimId);
    const encounter = claim.encounterId ? await store.get<Encounter>(org, "encounters", claim.encounterId) : null;
    return c.json({ denial, claim, note: encounter?.note ?? "", denialInfo: DENIAL_INDEX.get(denial.code), audit: await platform.audit.forEntity(org, denial.id) });
  });
  api.post("/denials/:id/draft", allow("denials"), async (c) => c.json(await platform.draftDenial(c.req.param("id"), c.get("actor"))));
  api.post("/denials/:id/resubmit", allow("denials"), async (c) => {
    const input = await body(c, z.object({ type: z.enum(["correction", "internal complaint"]), comment: z.string().min(10).max(2000), applyFixes: z.boolean().default(true), confirm: z.literal(true, { error: "Explicit approval (confirm: true) is required" }) }));
    return c.json(await platform.resubmit(c.req.param("id"), input, c.get("actor")));
  });
  api.post("/denials/:id/write-off", allow("denials"), async (c) => {
    const input = await body(c, z.object({ reason: z.string().min(5, "A write-off reason is mandatory").max(500) }));
    return c.json(await platform.writeOff(c.req.param("id"), input.reason, c.get("actor")));
  });

  // ------------------------------------------------------------------ Remittance and finance
  api.get("/remittances", allow("read"), async (c) => c.json((await store.list<Remittance>(org, "remittances")).map(({ xml, ...r }) => r)));
  api.post("/remittances/ingest", allow("remittance"), async (c) => c.json(await platform.ingestRemittanceXml(await c.req.text(), c.get("actor"))));
  api.post("/remittances/poll", allow("remittance"), async (c) => c.json({ ingested: await platform.pollRemittances() }));
  api.get("/reconciliation", allow("finance"), async (c) => c.json(await reconciliation(platform)));
  api.get("/reconciliation/export.xlsx", allow("finance"), async (c) => {
    const buf = await reconciliationWorkbook(platform);
    await platform.audit.record(org, c.get("actor"), "reconciliation.export", "report", "reconciliation");
    return c.body(new Uint8Array(buf), 200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="sanad-reconciliation-${platform.today()}.xlsx"`,
    });
  });
  api.get("/analytics/summary", allow("read"), async (c) => c.json(await dashboard(platform, c.req.query())));
  api.get("/analytics/forecast", allow("finance"), async (c) => c.json(await forecast(platform)));
  api.post("/copilot/query", allow("read"), async (c) => {
    const input = await body(c, z.object({ question: z.string().min(3).max(500) }));
    const answer = await askCopilot(platform.llm, store, org, input.question);
    await platform.audit.record(org, c.get("actor"), "copilot.query", "copilot", "query", undefined, { question: input.question, sql: answer.sql });
    return c.json(answer);
  });

  // ------------------------------------------------------------------ Front desk
  api.get("/patients", allow("read"), async (c) => {
    const q = (c.req.query("q") ?? "").toLowerCase();
    const patients = (await store.list<Patient>(org, "patients")).filter((p) => !q || p.name.toLowerCase().includes(q) || p.memberId.toLowerCase().includes(q) || p.id === q);
    return c.json(patients.slice(0, 50).map(maskPatient).sort((a, b) => a.id.localeCompare(b.id)));
  });
  api.post("/eligibility", allow("frontdesk"), async (c) => {
    const input = await body(c, z.object({ emiratesId: z.string().optional(), memberId: z.string().optional(), date: z.string().optional() }));
    return c.json(await platform.checkEligibility(input, c.get("actor")));
  });
  api.get("/prior-auths", allow("read"), async (c) => {
    const list = await store.list<PriorAuth>(org, "prior_auths");
    const patients = new Map((await store.list<Patient>(org, "patients")).map((p) => [p.id, p.name]));
    return c.json(list.map((p) => ({ ...p, patientName: patients.get(p.patientId), payerName: PAYERS.find((x) => x.id === p.payerId)?.name })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  });
  api.post("/prior-auths/draft", allow("frontdesk"), async (c) => {
    const input = await body(c, z.object({ patientId: z.string(), encounterId: z.string().optional(), diagnosis: z.string(), codes: z.array(z.string()).min(1), note: z.string().min(20) }));
    return c.json(await platform.draftPriorAuth(input, c.get("actor")), 201);
  });
  api.post("/prior-auths/:id/submit", allow("submit"), async (c) => {
    const input = await body(c, z.object({ justification: z.string().min(10).optional(), confirm: z.literal(true, { error: "Explicit approval (confirm: true) is required" }) }));
    return c.json(await platform.submitPriorAuth(c.req.param("id"), input.justification, c.get("actor")));
  });
  api.post("/patients/:id/estimate", allow("frontdesk"), async (c) => {
    const input = await body(c, z.object({ codes: z.array(z.string()).min(1).max(20) }));
    return c.json(await platform.estimate(c.req.param("id"), input.codes));
  });
  api.post("/share", allow("frontdesk"), async (c) => {
    const input = await body(c, z.object({ claimId: z.string().optional(), estimate: z.unknown().optional() }));
    return c.json(await platform.createShareLink(input, c.get("actor")), 201);
  });

  // ------------------------------------------------------------------ Notifications, audit, demo
  api.get("/notifications", allow("read"), async (c) => c.json((await store.list<Notification>(org, "notifications")).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30)));
  api.get("/audit", allow("audit"), async (c) => {
    const entityId = c.req.query("entityId");
    const events = entityId ? await platform.audit.forEntity(org, entityId) : (await store.list<AuditEvent>(org, "audit")).sort((a, b) => b.seq - a.seq).slice(0, 200);
    return c.json(events);
  });
  api.get("/audit/verify", allow("audit"), async (c) => c.json(await platform.audit.verify(org)));
  api.post("/demo/release-remittances", allow("demo"), async (c) => {
    const released = await deps.releaseRemittances();
    const ingested = await platform.pollRemittances();
    return c.json({ ...released, ingested });
  });
  api.post("/demo/reset", allow("reset"), async (c) => c.json(await deps.reset()));

  return api;
}

export function createApp(deps: AppDeps, options: { allowedOrigins: string[]; mockGateway?: Hono }) {
  const app = new Hono();
  const origins = new Set(options.allowedOrigins);
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    if (c.req.path.startsWith("/api")) c.header("Cache-Control", "no-store");
    // Hashed assets can be cached forever; the HTML shell must always revalidate.
    else if (c.req.path.startsWith("/assets/")) c.header("Cache-Control", "public, max-age=31536000, immutable");
    else c.header("Cache-Control", "no-cache");
  });
  app.use("/api/*", cors({ origin: (o) => (origins.has(o) ? o : undefined), allowHeaders: ["Content-Type", "Authorization", "X-Sanad-User"], allowMethods: ["GET", "POST", "PATCH", "OPTIONS"] }));
  app.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ error: error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") }, 422);
    if (error instanceof AppError) return c.json({ error: error.message }, error.status);
    if (error instanceof SyntaxError) return c.json({ error: "Invalid request data" }, 400);
    console.error(error);
    return c.json({ error: "Internal error" }, 500);
  });
  app.route("/api", createApi(deps));
  if (options.mockGateway) app.route("/mock-gateway", options.mockGateway);
  return app;
}
