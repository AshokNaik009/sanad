import { randomBytes } from "node:crypto";
import { suggestCodes } from "../ai/coding.ts";
import {
  classifyDenial,
  draftResubmission,
  priorityScore,
  recoveryProbability,
  resubmissionComment,
} from "../ai/denials.ts";
import type { Llm } from "../ai/llm.ts";
import { draftPriorAuthJustification } from "../ai/priorauth.ts";
import type { Config } from "../config.ts";
import { lookupCode } from "../data/codeset.ts";
import {
  CLINICIANS,
  DENIAL_INDEX,
  ORGANIZATION,
  ORG_ID,
  authRequired,
  clinicianById,
  payerById,
} from "../data/reference.ts";
import type { Store } from "../db.ts";
import type {
  Activity,
  AiSuggestionLog,
  Claim,
  CodeSuggestion,
  Denial,
  DocumentationQuery,
  Encounter,
  Notification,
  Patient,
  PriorAuth,
  Remittance,
  RemittanceLine,
  ShareLink,
  Submission,
} from "../domain/types.ts";
import type { GatewayAdapter } from "../gateway/adapter.ts";
import { chargemasterPrice, contractPrice, planFor, recalcTotals } from "../rules/pricing.ts";
import { scrubClaim } from "../rules/scrubber.ts";
import {
  AppError,
  addDays,
  ageOn,
  daysBetween,
  decrypt,
  isoDate,
  newId,
  parseDhaDate,
  round2,
} from "../util.ts";
import {
  buildClaimSubmission,
  buildPriorRequest,
  parseRemittanceAdvice,
} from "../xml/claim-xml.ts";
import type { Actor, AuditLog } from "./audit.ts";
import { PayerIntel } from "./payer-intel.ts";
import { z } from "zod";

const SYSTEM: Actor = { id: "system", role: "system" };

export class Platform {
  readonly org = ORG_ID;
  readonly senderId = ORGANIZATION.facilityLicence;
  /** Serializes claim/remittance mutations so the worker and API never interleave on a claim. */
  private lock: Promise<unknown> = Promise.resolve();
  /** Denial patterns learned from this clinic's adjudicated claims. */
  readonly payerIntel = new PayerIntel(this);

  constructor(
    readonly store: Store,
    readonly config: Config,
    readonly llm: Llm,
    readonly gateway: GatewayAdapter,
    readonly audit: AuditLog,
  ) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  today(): string {
    return isoDate(new Date());
  }

  async need<T>(kind: string, id: string, label = kind): Promise<T> {
    const value = await this.store.get<T>(this.org, kind, id);
    if (!value) throw new AppError(`${label} ${id} not found`, 404);
    return value;
  }

  patient = (id: string) => this.need<Patient>("patients", id, "Patient");
  encounter = (id: string) => this.need<Encounter>("encounters", id, "Encounter");
  claim = (id: string) => this.need<Claim>("claims", id, "Claim");
  denial = (id: string) => this.need<Denial>("denials", id, "Denial");

  emiratesId(patient: Patient): string {
    return decrypt(this.config.encryptionKey, patient.emiratesIdEnc);
  }

  private async logAi(entry: Omit<AiSuggestionLog, "id" | "createdAt" | "engine">): Promise<AiSuggestionLog> {
    const log: AiSuggestionLog = { id: newId("ai"), createdAt: new Date().toISOString(), engine: this.llm.engine, ...entry };
    await this.store.put(this.org, "ai_suggestions", log);
    return log;
  }

  private async decideAi(id: string | undefined, outcome: AiSuggestionLog["outcome"], userId: string) {
    if (!id) return;
    const log = await this.store.get<AiSuggestionLog>(this.org, "ai_suggestions", id);
    if (log) await this.store.put(this.org, "ai_suggestions", { ...log, outcome, userId, decidedAt: new Date().toISOString() });
  }

  async notify(kind: Notification["kind"], message: string, entityId: string) {
    await this.store.put<Notification>(this.org, "notifications", {
      id: `${kind}_${entityId}`,
      kind,
      message,
      entityId,
      createdAt: new Date().toISOString(),
      read: false,
    });
  }

  // ---------------------------------------------------------------- Encounters (M1, M2)

  async createEncounter(
    input: Pick<Encounter, "patientId" | "clinicianId" | "date" | "type" | "note"> & {
      externalId?: string;
      source?: Encounter["source"];
    },
    actor: Actor,
  ): Promise<{ encounter: Encounter; created: boolean }> {
    const patient = await this.patient(input.patientId);
    const clinician = clinicianById(input.clinicianId);
    if (input.externalId) {
      const existing = await this.store.find<Encounter>(this.org, "encounters", { externalId: input.externalId });
      if (existing[0]) return { encounter: existing[0], created: false };
    }
    const encounter: Encounter = {
      id: input.externalId ? `enc_ext_${input.externalId.replace(/[^A-Za-z0-9_-]/g, "")}` : newId("enc"),
      externalId: input.externalId,
      patientId: patient.id,
      clinicianId: clinician.id,
      payerId: patient.payerId,
      date: input.date,
      type: input.type,
      specialty: clinician.specialty,
      note: input.note,
      source: input.source ?? "upload",
      status: "to_code",
    };
    // Insert-only keeps POST /encounters idempotent under concurrent retries.
    const created = await this.store.insert(this.org, "encounters", encounter);
    if (!created) return { encounter: await this.encounter(encounter.id), created: false };
    await this.audit.record(this.org, actor, "encounter.create", "encounter", encounter.id, undefined, { source: encounter.source });
    return { encounter, created: true };
  }

  async codeEncounter(id: string, actor: Actor): Promise<Encounter> {
    const encounter = await this.encounter(id);
    const patient = await this.patient(encounter.patientId);
    const result = await suggestCodes(this.llm, {
      note: encounter.note,
      age: ageOn(patient.dob, encounter.date),
      gender: patient.gender,
      encounterType: encounter.type,
      specialty: encounter.specialty,
    });
    for (const s of result.suggestions) {
      const log = await this.logAi({ target: "encounter", targetId: id, task: "coding", payload: { code: s.code, role: s.role, evidence: s.evidence.map((e) => e.text) }, confidence: s.confidence, outcome: "pending" });
      s.id = log.id;
    }
    for (const g of result.gaps) await this.logAi({ target: "encounter", targetId: id, task: "gap", payload: g, outcome: "pending" });
    const updated: Encounter = { ...encounter, suggestions: result.suggestions, gaps: result.gaps, codedAt: new Date().toISOString(), status: encounter.status === "claimed" ? "claimed" : "coded" };
    await this.store.put(this.org, "encounters", updated);
    await this.audit.record(this.org, actor, "encounter.ai_code", "encounter", id, undefined, { engine: result.engine, codes: result.suggestions.map((s) => s.code), gaps: result.gaps.length });
    return updated;
  }

  async decideSuggestion(encId: string, sugId: string, decision: "accepted" | "rejected" | "edited", actor: Actor, editedCode?: string) {
    const encounter = await this.encounter(encId);
    const s = encounter.suggestions?.find((x) => x.id === sugId);
    if (!s) throw new AppError("Suggestion not found", 404);
    if (decision === "edited") {
      const entry = editedCode ? lookupCode(editedCode) : undefined;
      if (!entry?.active) throw new AppError(`${editedCode} is not an active code in the loaded code set`, 422);
      if ((entry.type === "ICD10") !== (s.codeType === "ICD10")) throw new AppError("Edited code must be the same kind (diagnosis vs procedure)", 422);
      s.editedCode = entry.code;
    }
    s.decision = decision;
    await this.store.put(this.org, "encounters", encounter);
    await this.decideAi(sugId, decision, actor.id);
    await this.audit.record(this.org, actor, `suggestion.${decision}`, "encounter", encId, { code: s.code }, { code: s.editedCode ?? s.code });
    return encounter;
  }

  async addManualCode(encId: string, code: string, actor: Actor) {
    const encounter = await this.encounter(encId);
    const entry = lookupCode(code);
    if (!entry?.active) throw new AppError(`${code} is not an active code in the loaded code set`, 422);
    const hasPrincipal = encounter.suggestions?.some((s) => s.role === "principal" && s.decision !== "rejected");
    const suggestion: CodeSuggestion = {
      id: newId("man"),
      code: entry.code,
      codeType: entry.type,
      description: entry.description,
      confidence: 1,
      evidence: [],
      role: entry.type === "ICD10" ? (hasPrincipal ? "secondary" : "principal") : "procedure",
      decision: "accepted",
    };
    encounter.suggestions = [...(encounter.suggestions ?? []), suggestion];
    await this.store.put(this.org, "encounters", encounter);
    await this.audit.record(this.org, actor, "code.manual_add", "encounter", encId, undefined, { code: entry.code });
    return encounter;
  }

  async raiseQuery(encId: string, gapId: string, actor: Actor): Promise<DocumentationQuery> {
    const encounter = await this.encounter(encId);
    const gap = encounter.gaps?.find((g) => g.id === gapId);
    if (!gap) throw new AppError("Documentation gap not found", 404);
    const query: DocumentationQuery = { id: newId("dq"), encounterId: encId, clinicianId: encounter.clinicianId, question: gap.question, reason: gap.reason, status: "open", createdAt: new Date().toISOString() };
    await this.store.put(this.org, "doc_queries", query);
    await this.notify("query", `Documentation query for ${clinicianById(encounter.clinicianId).name}: ${gap.question}`, query.id);
    await this.audit.record(this.org, actor, "query.raise", "encounter", encId, undefined, { queryId: query.id, question: gap.question });
    return query;
  }

  async answerQuery(queryId: string, answer: string, actor: Actor) {
    const query = await this.need<DocumentationQuery>("doc_queries", queryId, "Query");
    if (query.status !== "open") throw new AppError("Query already answered", 409);
    if (answer.trim().length < 2) throw new AppError("Answer is required", 422);
    const encounter = await this.encounter(query.encounterId);
    const addendum = `\nAddendum (${new Date().toISOString().slice(0, 10)}, ${clinicianById(query.clinicianId).name}): ${answer.trim()}`;
    await this.store.put(this.org, "encounters", { ...encounter, note: encounter.note + addendum });
    await this.store.put(this.org, "doc_queries", { ...query, status: "answered", answer: answer.trim(), answeredAt: new Date().toISOString() });
    await this.audit.record(this.org, actor, "query.answer", "encounter", encounter.id, undefined, { queryId, answer: answer.trim() });
    // The answer updates the note and re-runs coding (PRD M2.3).
    return this.codeEncounter(encounter.id, actor);
  }

  async createClaimFromEncounter(encId: string, actor: Actor): Promise<Claim> {
    const encounter = await this.encounter(encId);
    if (encounter.claimId) return this.claim(encounter.claimId);
    const patient = await this.patient(encounter.patientId);
    const chosen = (encounter.suggestions ?? []).filter((s) => s.decision === "accepted" || s.decision === "edited");
    const pending = (encounter.suggestions ?? []).filter((s) => s.decision === "pending");
    if (pending.length) throw new AppError(`Accept, edit or reject all ${pending.length} pending AI suggestions first`, 409);
    const dx = chosen.filter((s) => s.codeType === "ICD10");
    const procs = chosen.filter((s) => s.codeType !== "ICD10");
    if (!dx.length || !procs.length) throw new AppError("A claim needs at least one accepted diagnosis and one accepted service", 422);
    const clinician = clinicianById(encounter.clinicianId);
    const payer = payerById(encounter.payerId);
    const claim: Claim = {
      id: newId("clm"),
      encounterId: encounter.id,
      patientId: patient.id,
      payerId: payer.id,
      payerName: payer.name,
      clinicianId: clinician.id,
      clinicianName: clinician.name,
      clinicianLicence: clinician.licence,
      specialty: encounter.specialty,
      encounterType: encounter.type,
      serviceDate: encounter.date,
      status: "draft",
      diagnoses: dx.map((s, i) => {
        const code = s.editedCode ?? s.code;
        return { code, type: s.role === "principal" || (i === 0 && !dx.some((d) => d.role === "principal")) ? "principal" : "secondary", description: lookupCode(code)?.description ?? s.description };
      }),
      activities: procs.map((s) => {
        const code = s.editedCode ?? s.code;
        const entry = lookupCode(code);
        return {
          id: newId("act"),
          codeType: entry?.type ?? s.codeType,
          code,
          description: entry?.description ?? s.description,
          quantity: 1,
          gross: chargemasterPrice(code),
          patientShare: 0,
          net: 0,
          clinicianLicence: clinician.licence,
          priorAuthNumber: authRequired(payer, code) ? encounter.priorAuthNumber : undefined,
        } satisfies Activity;
      }),
      gross: 0,
      patientShare: 0,
      net: 0,
      timeline: [{ status: "draft", at: new Date().toISOString(), by: actor.id, note: "Created from the doctor's note" }],
    };
    recalcTotals(claim, patient);
    await this.rescrub(claim);
    await this.store.put(this.org, "claims", claim);
    await this.store.put(this.org, "encounters", { ...encounter, status: "claimed", claimId: claim.id });
    await this.audit.record(this.org, actor, "claim.create", "claim", claim.id, undefined, { encounterId: encId, net: claim.net });
    return claim;
  }

  // ---------------------------------------------------------------- Claims and scrubber (M3, M4)

  private async rescrub(claim: Claim): Promise<Claim> {
    const patient = await this.patient(claim.patientId);
    const priorAuths = await this.store.find<PriorAuth>(this.org, "prior_auths", { patientId: claim.patientId });
    const otherClaims = (await this.store.find<Claim>(this.org, "claims", { patientId: claim.patientId })).filter((c) => c.id !== claim.id);
    const xml = this.claimXml(claim, patient);
    const result = scrubClaim(claim, { patient, priorAuths, otherClaims, today: this.today(), xml });
    claim.issues = result.issues;
    claim.cleanClaimScore = result.score;
    claim.payerRisk = await this.payerIntel.risksFor(claim);
    // A clean claim still carries the payer's track record for these services.
    const learned = Math.max(0, ...claim.payerRisk.filter((r) => !r.mitigated).map((r) => r.denialRate * 0.8));
    claim.denialRisk = Number(Math.max(result.denialRisk, learned).toFixed(2));
    if (claim.status === "draft" || claim.status === "scrubbed")
      claim.status = result.issues.some((i) => i.severity === "blocking") ? "draft" : "scrubbed";
    return claim;
  }

  async scrub(id: string, actor: Actor): Promise<Claim> {
    return this.exclusive(async () => {
      const claim = await this.claim(id);
      const before = claim.cleanClaimScore;
      await this.rescrub(claim);
      await this.store.put(this.org, "claims", claim);
      await this.audit.record(this.org, actor, "claim.scrub", "claim", id, { score: before }, { score: claim.cleanClaimScore, issues: claim.issues?.map((i) => i.rule) });
      return claim;
    });
  }

  private editable(claim: Claim) {
    if (!["draft", "scrubbed"].includes(claim.status)) throw new AppError(`Claim is ${claim.status}; only draft claims can be edited`, 409);
  }

  async applyFix(id: string, issueId: string, actor: Actor): Promise<Claim> {
    return this.exclusive(async () => {
      const claim = await this.claim(id);
      this.editable(claim);
      const issue = claim.issues?.find((i) => i.id === issueId);
      if (!issue?.autoFix) throw new AppError("This issue has no one-click fix", 422);
      const patient = await this.patient(claim.patientId);
      const before = structuredClone({ activities: claim.activities, diagnoses: claim.diagnoses });
      const fix = issue.autoFix;
      const act = (aid?: string) => claim.activities.find((a) => a.id === aid);
      switch (fix.kind) {
        case "attach_auth":
          for (const [aid, num] of Object.entries(fix.value as Record<string, string>)) {
            const a = act(aid);
            if (a) a.priorAuthNumber = num;
          }
          break;
        case "set_price": {
          const a = act(fix.activityId);
          if (a) a.gross = round2(Number(fix.value) * a.quantity);
          break;
        }
        case "remove_activity":
          claim.activities = claim.activities.filter((a) => a.id !== fix.activityId);
          break;
        case "replace_dx": {
          const { from, to } = fix.value as { from: string; to: string };
          claim.diagnoses = claim.diagnoses.map((d) => (d.code === from ? { ...d, code: to, description: lookupCode(to)?.description ?? d.description } : d));
          break;
        }
        case "set_code_type": {
          const a = act(fix.activityId);
          if (a) a.codeType = fix.value as Activity["codeType"];
          break;
        }
        case "fill_clinician":
          claim.clinicianLicence = clinicianById(claim.clinicianId).licence;
          for (const a of claim.activities) a.clinicianLicence ??= claim.clinicianLicence;
          break;
        case "set_encounter_type":
          claim.encounterType = String(fix.value);
          break;
        case "set_payer":
          claim.payerId = String(fix.value);
          claim.payerName = payerById(claim.payerId).name;
          break;
        default:
          throw new AppError(`Unknown fix ${fix.kind}`, 422);
      }
      recalcTotals(claim, patient);
      const scoreBefore = claim.cleanClaimScore;
      await this.rescrub(claim);
      claim.timeline.push({ status: "fix", at: new Date().toISOString(), by: actor.id, note: `${issue.rule}: ${issue.fix}` });
      await this.store.put(this.org, "claims", claim);
      await this.audit.record(this.org, actor, "claim.autofix", "claim", id, { rule: issue.rule, score: scoreBefore, ...before }, { score: claim.cleanClaimScore, activities: claim.activities, diagnoses: claim.diagnoses });
      return claim;
    });
  }

  async updateClaim(id: string, patch: { diagnoses?: Claim["diagnoses"]; activities?: Pick<Activity, "id" | "code" | "quantity" | "gross" | "priorAuthNumber">[] }, actor: Actor) {
    return this.exclusive(async () => {
      const claim = await this.claim(id);
      this.editable(claim);
      const before = structuredClone({ diagnoses: claim.diagnoses, activities: claim.activities });
      if (patch.diagnoses) {
        for (const d of patch.diagnoses) if (!lookupCode(d.code)) throw new AppError(`${d.code} is not in the loaded code set`, 422);
        claim.diagnoses = patch.diagnoses.map((d) => ({ ...d, description: lookupCode(d.code)?.description ?? d.code }));
      }
      if (patch.activities) {
        claim.activities = patch.activities.map((p) => {
          const existing = claim.activities.find((a) => a.id === p.id);
          const entry = lookupCode(p.code);
          if (!entry || entry.type === "ICD10") throw new AppError(`${p.code} is not a procedure/drug code in the loaded code set`, 422);
          return {
            ...(existing ?? { id: newId("act"), patientShare: 0, net: 0, clinicianLicence: claim.clinicianLicence }),
            code: entry.code,
            codeType: entry.type,
            description: entry.description,
            quantity: Math.max(1, Number(p.quantity) || 1),
            gross: round2(Number(p.gross ?? chargemasterPrice(entry.code))),
            priorAuthNumber: p.priorAuthNumber || undefined,
          } as Activity;
        });
      }
      recalcTotals(claim, await this.patient(claim.patientId));
      await this.rescrub(claim);
      await this.store.put(this.org, "claims", claim);
      await this.audit.record(this.org, actor, "claim.edit", "claim", id, before, { diagnoses: claim.diagnoses, activities: claim.activities });
      return claim;
    });
  }

  claimXml(claim: Claim, patient: Patient, resubmission?: { type: string; comment: string; attachment?: string }): string {
    const payer = payerById(claim.payerId);
    return buildClaimSubmission(this.senderId, payer.regulatorPayerId, [
      { claim, memberId: patient.memberId, emiratesId: this.emiratesId(patient), payerRegulatorId: payer.regulatorPayerId, facilityLicence: ORGANIZATION.facilityLicence, resubmission },
    ]);
  }

  /** Human approval gate (M4.2): nothing leaves without an approver ID and timestamp. */
  async submitClaims(ids: string[], actor: Actor): Promise<{ submitted: string[]; rejected: { id: string; errors: string[] }[] }> {
    if (!ids.length) throw new AppError("Select at least one claim", 422);
    return this.exclusive(async () => {
      const claims: Claim[] = [];
      for (const id of ids) {
        const claim = await this.claim(id);
        this.editable(claim);
        await this.rescrub(claim);
        const blocking = claim.issues?.filter((i) => i.severity === "blocking") ?? [];
        if (blocking.length) throw new AppError(`Claim ${id} has ${blocking.length} blocking issue(s): ${blocking.map((b) => b.rule).join(", ")}`, 409);
        claims.push(claim);
      }
      const approvedAt = new Date().toISOString();
      const result = { submitted: [] as string[], rejected: [] as { id: string; errors: string[] }[] };
      const byPayer = Map.groupBy(claims, (c) => c.payerId);
      for (const [payerId, batch] of byPayer) {
        const payer = payerById(payerId);
        const items = [];
        for (const claim of batch) {
          const patient = await this.patient(claim.patientId);
          items.push({ claim, memberId: patient.memberId, emiratesId: this.emiratesId(patient), payerRegulatorId: payer.regulatorPayerId, facilityLicence: ORGANIZATION.facilityLicence });
        }
        const xml = buildClaimSubmission(this.senderId, payer.regulatorPayerId, items);
        const submission: Submission = { id: newId("sub"), kind: "claim", claimIds: batch.map((c) => c.id), xml, approverId: actor.id, approvedAt, status: "sent" };
        await this.store.put(this.org, "submissions", submission);
        await this.audit.record(this.org, actor, "claims.approve_submit", "submission", submission.id, undefined, { claimIds: submission.claimIds, payer: payer.name });
        const response = await this.gateway.submitClaims(this.senderId, xml);
        submission.gatewayResponse = response;
        submission.status = response.status;
        await this.store.put(this.org, "submissions", submission);
        for (const claim of batch) {
          const now = new Date().toISOString();
          claim.submissionId = submission.id;
          claim.approvedBy = actor.id;
          claim.approvedAt = approvedAt;
          claim.submittedAt = now;
          claim.timeline.push({ status: "submitted", at: now, by: actor.id, note: `Batch ${submission.id} to ${payer.name} via ${this.gateway.name} gateway` });
          if (response.status === "acknowledged") {
            claim.status = "acknowledged";
            claim.timeline.push({ status: "acknowledged", at: now, note: `Payer claim ID ${response.claims?.find((c) => c.id === claim.id)?.idPayer ?? "-"}` });
            result.submitted.push(claim.id);
          } else {
            claim.status = "rejected";
            const errors = (response.errors ?? []).map((e) => `${e.path}: ${e.message}`);
            claim.timeline.push({ status: "rejected", at: now, note: errors.slice(0, 3).join("; ") });
            result.rejected.push({ id: claim.id, errors });
          }
          await this.store.put(this.org, "claims", claim);
        }
      }
      return result;
    });
  }

  // ---------------------------------------------------------------- Remittance (M5.1, M6)

  async pollRemittances(): Promise<number> {
    const remittances = await this.gateway.fetchRemittances(this.senderId);
    for (const r of remittances) await this.ingestRemittanceXml(r.xml, SYSTEM, r.id);
    return remittances.length;
  }

  async ingestRemittanceXml(xml: string, actor: Actor, gatewayId?: string): Promise<Remittance> {
    return this.exclusive(async () => {
      const parsed = parseRemittanceAdvice(xml);
      const remittance: Remittance = { id: gatewayId ?? newId("ra"), payerId: "", receivedAt: new Date().toISOString(), xml, lineCount: 0, matched: 0 };
      if (await this.store.get(this.org, "remittances", remittance.id)) return this.need<Remittance>("remittances", remittance.id);
      this.payerIntel.invalidate();
      const historicalRecovery = await this.payerRecoveryRates();
      // Bulk-load everything the remittance touches: a few round trips instead of several per line.
      const claimIds = parsed.claims.map((c) => c.id);
      const claimMap = new Map((await this.store.getMany<Claim>(this.org, "claims", claimIds)).map((c) => [c.id, c]));
      const existingDenials = (await this.store.list<Denial>(this.org, "denials")).filter((d) => claimMap.has(d.claimId));
      const approvedAuths = await this.store.find<PriorAuth>(this.org, "prior_auths", { status: "approved" });
      const encounterIds = [...claimMap.values()].map((c) => c.encounterId).filter((id): id is string => !!id);
      const encounterMap = new Map((await this.store.getMany<Encounter>(this.org, "encounters", encounterIds)).map((e) => [e.id, e]));
      const lines: RemittanceLine[] = [];
      const denialWrites: Denial[] = [];
      const touched: Claim[] = [];
      for (const rc of parsed.claims) {
        const claim = claimMap.get(rc.id);
        const settledAt = rc.dateSettlement ? parseDhaDate(rc.dateSettlement) : new Date().toISOString();
        for (const ra of rc.activities) {
          remittance.lineCount++;
          const activity = claim?.activities.find((a) => a.id === ra.id);
          const line: RemittanceLine = {
            id: `${remittance.id}_${ra.id}`,
            remittanceId: remittance.id,
            claimId: rc.id,
            activityId: ra.id,
            activityCode: ra.code,
            payerId: claim?.payerId ?? "",
            payerName: claim?.payerName ?? parsed.senderId,
            expected: activity?.net ?? ra.net,
            paid: ra.paymentAmount,
            variance: round2((activity?.net ?? ra.net) - ra.paymentAmount),
            denialCode: ra.denialCode,
            paymentReference: rc.paymentReference,
            settledAt,
            status: "unmatched",
            matched: !!activity,
          };
          lines.push(line);
          if (!claim || !activity) continue;
          remittance.matched++;
          remittance.payerId = claim.payerId;
          line.status = ra.denialCode ? "denied" : line.variance > this.config.underpaymentThreshold ? "underpaid" : "paid";
          activity.paid = round2((activity.paid ?? 0) + ra.paymentAmount);
          activity.denialCode = ra.denialCode;

          const resubmitted = existingDenials.find((d) => d.claimId === claim.id && d.activityId === activity.id && d.status === "resubmitted");
          if (resubmitted) {
            const recovered = !ra.denialCode && ra.paymentAmount > 0;
            denialWrites.push({ ...resubmitted, status: recovered ? "recovered" : "lost", recoveredAmount: recovered ? ra.paymentAmount : 0 });
            await this.decideAi(resubmitted.draft?.suggestionId, recovered ? "accepted" : "rejected", "payer");
          }
          if (ra.denialCode && !resubmitted) {
            const payer = payerById(claim.payerId);
            const encounter = claim.encounterId ? encounterMap.get(claim.encounterId) : undefined;
            const cls = await classifyDenial(this.llm, ra.denialCode, rc.comments);
            const approved = approvedAuths.some((p) => p.patientId === claim.patientId && p.services.some((s) => s.code === activity.code));
            const { p, band } = recoveryProbability({ code: ra.denialCode, category: cls.category, note: encounter?.note, hasApprovedAuth: approved, payerHistoricalRecovery: historicalRecovery[`${claim.payerId}|${cls.category}`] });
            const deniedAt = isoDate(new Date(settledAt));
            const deadline = isoDate(addDays(deniedAt, payer.resubmissionWindowDays));
            const amount = round2(activity.net - ra.paymentAmount);
            const denial: Denial = {
              id: `den_${claim.id}_${activity.id}`,
              claimId: claim.id,
              activityId: activity.id,
              activityCode: activity.code,
              payerId: claim.payerId,
              payerName: claim.payerName,
              clinicianName: claim.clinicianName,
              specialty: claim.specialty,
              code: ra.denialCode,
              payerComment: rc.comments,
              plainReason: cls.plain,
              category: cls.category,
              classifiedBy: cls.by,
              amount,
              recoveryProbability: p,
              recoveryBand: band,
              priorityScore: priorityScore(amount, p, deadline, this.today()),
              deniedAt,
              deadline,
              status: "open",
            };
            denialWrites.push(denial);
            if (cls.by === "ai") await this.logAi({ target: "denial", targetId: denial.id, task: "classification", payload: { code: ra.denialCode, category: cls.category }, outcome: "pending" });
          }
        }
        if (!claim) continue;
        const wasResubmission = claim.status === "resubmitted";
        const fullyPaid = claim.activities.every((a) => !a.denialCode && (a.paid ?? 0) >= a.net - this.config.underpaymentThreshold);
        const anyPaid = claim.activities.some((a) => (a.paid ?? 0) > 0);
        claim.paidAmount = round2(claim.activities.reduce((s, a) => s + (a.paid ?? 0), 0));
        claim.status = fullyPaid ? "paid" : anyPaid ? "partially_paid" : "denied";
        if (claim.firstPass === undefined && !wasResubmission) claim.firstPass = fullyPaid;
        if (anyPaid) claim.paidAt = settledAt;
        claim.timeline.push({ status: claim.status, at: new Date().toISOString(), note: `Remittance ${remittance.id}: AED ${claim.paidAmount.toFixed(2)} paid of ${claim.net.toFixed(2)}${rc.comments ? ` - ${rc.comments}` : ""}` });
        touched.push(claim);
      }
      await this.store.putMany(this.org, "remittance_lines", lines);
      await this.store.putMany(this.org, "denials", denialWrites);
      await this.store.putMany(this.org, "claims", touched);
      await this.store.put(this.org, "remittances", remittance);
      await this.notify("remittance", `Remittance ${remittance.id}: ${remittance.lineCount} lines, ${remittance.matched} matched`, remittance.id);
      await this.audit.record(this.org, actor, "remittance.ingest", "remittance", remittance.id, undefined, { lines: remittance.lineCount, matched: remittance.matched });
      return remittance;
    });
  }

  /** Historical AED recovered / AED denied per payer and category. */
  async payerRecoveryRates(): Promise<Record<string, number>> {
    const rows = await this.store.readOnly(
      this.org,
      `SELECT payer_id, category, sum(coalesce(recovered_amount, 0)) / nullif(sum(amount), 0) AS rate
       FROM v_denials WHERE status IN ('recovered', 'lost', 'written_off') GROUP BY payer_id, category`,
    );
    return Object.fromEntries(rows.rows.map((r) => [`${r.payer_id}|${r.category}`, Number(r.rate ?? 0)]));
  }

  // ---------------------------------------------------------------- Denials (M5.2-M5.4)

  async listDenials(filter: { status?: string } = {}): Promise<Denial[]> {
    const denials = filter.status
      ? await this.store.find<Denial>(this.org, "denials", { status: filter.status })
      : (await this.store.list<Denial>(this.org, "denials")).filter((d) => !d.historical);
    const today = this.today();
    for (const d of denials) d.priorityScore = d.status === "open" ? priorityScore(d.amount, d.recoveryProbability, d.deadline, today) : 0;
    return denials.sort((a, b) => b.priorityScore - a.priorityScore || a.deadline.localeCompare(b.deadline));
  }

  async draftDenial(id: string, actor: Actor): Promise<Denial> {
    const denial = await this.denial(id);
    if (denial.status !== "open") throw new AppError(`Denial is ${denial.status}`, 409);
    const claim = await this.claim(denial.claimId);
    const patient = await this.patient(claim.patientId);
    const encounter = claim.encounterId ? await this.store.get<Encounter>(this.org, "encounters", claim.encounterId) : null;
    const approvedAuths = await this.store.find<PriorAuth>(this.org, "prior_auths", { patientId: claim.patientId, status: "approved" });
    const draft = await draftResubmission(this.llm, { denial, claim, note: encounter?.note ?? "", patientAge: ageOn(patient.dob, claim.serviceDate), patientGender: patient.gender, approvedAuths });
    await this.logAi({ target: "denial", targetId: id, task: "resubmission", payload: { summary: draft.summary, fixes: draft.fieldFixes.length, citations: draft.justification.length, blocked: draft.blockedSentences.length }, outcome: "pending" }).then((log) => {
      draft.suggestionId = log.id;
    });
    const updated = { ...denial, draft, assignedTo: denial.assignedTo ?? actor.id };
    await this.store.put(this.org, "denials", updated);
    await this.audit.record(this.org, actor, "denial.ai_draft", "denial", id, undefined, { ms: draft.ms, engine: this.llm.engine });
    return updated;
  }

  async resubmit(id: string, input: { type: "correction" | "internal complaint"; comment: string; applyFixes: boolean }, actor: Actor) {
    return this.exclusive(async () => {
      const denial = await this.denial(id);
      if (denial.status !== "open") throw new AppError(`Denial is ${denial.status}`, 409);
      const payer = payerById(denial.payerId);
      if (daysBetween(this.today(), denial.deadline) < 0) throw new AppError(`The ${payer.name} resubmission window closed on ${denial.deadline}`, 409);
      if (input.comment.trim().length < 10) throw new AppError("A resubmission comment of at least 10 characters is required", 422);
      const claim = await this.claim(denial.claimId);
      const patient = await this.patient(claim.patientId);
      const activity = claim.activities.find((a) => a.id === denial.activityId);
      if (!activity) throw new AppError("Denied activity not found on claim", 404);
      const before = structuredClone({ activity, diagnoses: claim.diagnoses });
      if (input.applyFixes && denial.draft)
        for (const fix of denial.draft.fieldFixes) {
          if (fix.field === "PriorAuthorizationID") activity.priorAuthNumber = fix.to;
          else if (fix.field === "Activity.Net") {
            activity.gross = round2(contractPrice(claim.payerId, activity.code) * activity.quantity);
            activity.net = round2(Math.max(0, activity.gross - activity.patientShare));
          } else if (/diagnosis/i.test(fix.field) && lookupCode(fix.to)?.active)
            claim.diagnoses = claim.diagnoses.map((d) => (d.code === fix.from ? { ...d, code: fix.to, description: lookupCode(fix.to)?.description ?? d.description } : d));
        }
      // A resubmission carries only the activities being resubmitted.
      const resubClaim: Claim = { ...claim, activities: [{ ...activity }], gross: activity.gross, patientShare: activity.patientShare, net: activity.net };
      const xml = this.claimXml(resubClaim, patient, { type: input.type, comment: input.comment.trim().slice(0, 2000), attachment: denial.draft?.attachments.join("; ") });
      const submission: Submission = { id: newId("sub"), kind: "resubmission", claimIds: [claim.id], xml, approverId: actor.id, approvedAt: new Date().toISOString(), status: "sent" };
      await this.store.put(this.org, "submissions", submission);
      const response = await this.gateway.submitClaims(this.senderId, xml);
      submission.gatewayResponse = response;
      submission.status = response.status;
      await this.store.put(this.org, "submissions", submission);
      if (response.status !== "acknowledged") throw new AppError(`Gateway rejected the resubmission: ${(response.errors ?? []).map((e) => e.message).join("; ")}`, 502);
      activity.paid = 0;
      activity.denialCode = undefined;
      claim.status = "resubmitted";
      claim.resubmissionCount = (claim.resubmissionCount ?? 0) + 1;
      claim.timeline.push({ status: "resubmitted", at: new Date().toISOString(), by: actor.id, note: `${input.type} for ${activity.code} (${denial.code})` });
      await this.store.put(this.org, "claims", claim);
      const edited = denial.draft ? input.comment.trim() !== resubmissionComment(denial.draft).trim() : true;
      await this.decideAi(denial.draft?.suggestionId, edited ? "edited" : "accepted", actor.id);
      const updated: Denial = { ...denial, status: "resubmitted", resubmittedAt: new Date().toISOString() };
      await this.store.put(this.org, "denials", updated);
      await this.audit.record(this.org, actor, "denial.resubmit", "denial", id, before, { type: input.type, submissionId: submission.id, activity, diagnoses: claim.diagnoses });
      return { denial: updated, submission };
    });
  }

  async writeOff(id: string, reason: string, actor: Actor): Promise<Denial> {
    return this.exclusive(async () => {
      if (!reason || reason.trim().length < 5) throw new AppError("A write-off reason is mandatory", 422);
      const denial = await this.denial(id);
      if (denial.status !== "open") throw new AppError(`Denial is ${denial.status}`, 409);
      const updated: Denial = { ...denial, status: "written_off", writeOffReason: reason.trim() };
      await this.store.put(this.org, "denials", updated);
      await this.decideAi(denial.draft?.suggestionId, "rejected", actor.id);
      const claim = await this.claim(denial.claimId);
      const siblings = await this.store.find<Denial>(this.org, "denials", { claimId: claim.id });
      if (claim.status === "denied" && siblings.every((d) => d.status === "written_off")) claim.status = "written_off";
      claim.timeline.push({ status: "written_off", at: new Date().toISOString(), by: actor.id, note: `${denial.activityCode}: ${reason.trim()}` });
      await this.store.put(this.org, "claims", claim);
      await this.audit.record(this.org, actor, "denial.write_off", "denial", id, undefined, { reason: reason.trim(), amount: denial.amount });
      return updated;
    });
  }

  // ---------------------------------------------------------------- Eligibility and prior auth (M7)

  async checkEligibility(input: { emiratesId?: string; memberId?: string; date?: string }, actor: Actor) {
    if (!input.emiratesId && !input.memberId) throw new AppError("Enter an Emirates ID or member ID", 422);
    const result = await this.gateway.checkEligibility({ ...input, date: input.date ?? this.today() });
    await this.audit.record(this.org, actor, "eligibility.check", "member", input.memberId ?? "by-eid", undefined, { eligible: result.eligible });
    return result;
  }

  async draftPriorAuth(input: { patientId: string; encounterId?: string; diagnosis: string; codes: string[]; note: string }, actor: Actor): Promise<PriorAuth> {
    const patient = await this.patient(input.patientId);
    if (!lookupCode(input.diagnosis)?.active) throw new AppError(`${input.diagnosis} is not an active diagnosis code`, 422);
    for (const c of input.codes) if (!lookupCode(c)?.active) throw new AppError(`${c} is not an active code`, 422);
    const justification = await draftPriorAuthJustification(this.llm, input.note, input.diagnosis, input.codes);
    const prior: PriorAuth = {
      id: newId("pa"),
      encounterId: input.encounterId,
      patientId: patient.id,
      payerId: patient.payerId,
      services: input.codes.map((c) => ({ code: c, description: lookupCode(c)?.description ?? c })),
      diagnosis: input.diagnosis,
      justification,
      status: "draft",
      createdAt: new Date().toISOString(),
    };
    await this.store.put(this.org, "prior_auths", prior);
    await this.logAi({ target: "prior_auth", targetId: prior.id, task: "prior_auth", payload: { justification }, outcome: "pending" });
    await this.audit.record(this.org, actor, "prior_auth.draft", "prior_auth", prior.id);
    return prior;
  }

  async submitPriorAuth(id: string, justification: string | undefined, actor: Actor): Promise<PriorAuth> {
    const prior = await this.need<PriorAuth>("prior_auths", id, "Prior auth");
    if (prior.status !== "draft" && prior.status !== "info_requested") throw new AppError(`Prior auth is ${prior.status}`, 409);
    const patient = await this.patient(prior.patientId);
    const payer = payerById(prior.payerId);
    const encounter = prior.encounterId ? await this.store.get<Encounter>(this.org, "encounters", prior.encounterId) : null;
    const clinician = encounter ? clinicianById(encounter.clinicianId) : CLINICIANS[0];
    if (justification !== undefined) prior.justification = justification.trim();
    const xml = buildPriorRequest({
      id: prior.id,
      memberId: patient.memberId,
      emiratesId: this.emiratesId(patient),
      payerRegulatorId: payer.regulatorPayerId,
      facilityLicence: ORGANIZATION.facilityLicence,
      clinicianLicence: clinician.licence,
      diagnosis: prior.diagnosis,
      services: prior.services.map((s) => ({ code: s.code, codeType: lookupCode(s.code)?.type ?? "CPT" })),
      justification: prior.justification,
    });
    const res = await this.gateway.submitPriorRequest(this.senderId, xml);
    const updated: PriorAuth = { ...prior, status: "pending", gatewayRef: res.ref, approvedBy: actor.id };
    await this.store.put(this.org, "prior_auths", updated);
    await this.store.put(this.org, "submissions", { id: newId("sub"), kind: "prior_request", claimIds: [], xml, approverId: actor.id, approvedAt: new Date().toISOString(), status: "sent", gatewayResponse: res } satisfies Submission);
    await this.audit.record(this.org, actor, "prior_auth.approve_send", "prior_auth", id, undefined, { ref: res.ref });
    return updated;
  }

  async refreshPriorAuths(): Promise<number> {
    const pending = await this.store.find<PriorAuth>(this.org, "prior_auths", { status: "pending" });
    let changed = 0;
    for (const prior of pending) {
      if (!prior.gatewayRef) continue;
      const res = await this.gateway.fetchPriorAuth(this.senderId, prior.gatewayRef);
      if (res.status === "pending") continue;
      changed++;
      await this.store.put(this.org, "prior_auths", { ...prior, status: res.status, approvalNumber: res.approvalNumber, validUntil: res.validUntil, justification: prior.justification });
      if (prior.encounterId && res.approvalNumber) {
        const enc = await this.store.get<Encounter>(this.org, "encounters", prior.encounterId);
        if (enc) await this.store.put(this.org, "encounters", { ...enc, priorAuthNumber: res.approvalNumber });
      }
      await this.notify("prior_auth", `Prior auth ${prior.id} ${res.status}${res.approvalNumber ? ` (${res.approvalNumber})` : ""}${res.comment ? `: ${res.comment}` : ""}`, prior.id);
      await this.audit.record(this.org, SYSTEM, "prior_auth.status", "prior_auth", prior.id, { status: "pending" }, { status: res.status, approvalNumber: res.approvalNumber });
    }
    return changed;
  }

  // ---------------------------------------------------------------- Deadlines (task engine)

  async deadlineAlerts(): Promise<number> {
    const open = await this.store.find<Denial>(this.org, "denials", { status: "open" });
    let n = 0;
    for (const d of open) {
      const left = daysBetween(this.today(), d.deadline);
      if (left >= 0 && left <= 5) {
        const id = `deadline_${d.id}`;
        if (!(await this.store.get(this.org, "notifications", id))) {
          await this.notify("deadline", `${d.payerName} denial on ${d.activityCode} (AED ${d.amount.toFixed(0)}) must be resubmitted within ${left} day(s)`, d.id);
          n++;
        }
      }
    }
    return n;
  }

  // ---------------------------------------------------------------- Patient transparency (M10)

  async estimate(patientId: string, codes: string[]) {
    const patient = await this.patient(patientId);
    const plan = planFor(patient);
    const lines = codes.map((code) => {
      const entry = lookupCode(code);
      if (!entry?.active || entry.type === "ICD10") throw new AppError(`${code} is not a billable service code`, 422);
      return { code, service: entry.plain, price: contractPrice(patient.payerId, code) };
    });
    const total = round2(lines.reduce((s, l) => s + l.price, 0));
    const patientShare = Math.min(round2((total * plan.copayPercent) / 100), plan.copayCapPerVisit);
    return {
      payer: payerById(patient.payerId).name,
      plan: plan.name,
      lines,
      total,
      insurerShare: round2(total - patientShare),
      patientShare,
      assumptions: [
        `${plan.name} plan: ${plan.copayPercent}% co-pay, capped at AED ${plan.copayCapPerVisit} per visit.`,
        "Prices are the insurer's contract prices for this clinic.",
        "Assumes coverage is active on the visit date and any required prior approval is granted.",
        "Excludes services added on the day and pharmacy items.",
      ],
    };
  }

  async createShareLink(input: { claimId?: string; estimate?: unknown }, actor: Actor): Promise<ShareLink> {
    if (!input.claimId && !input.estimate) throw new AppError("Nothing to share", 422);
    if (input.claimId) await this.claim(input.claimId);
    const link: ShareLink = { id: randomBytes(18).toString("base64url"), claimId: input.claimId, estimate: input.estimate, expiresAt: addDays(new Date(), 7).toISOString(), createdAt: new Date().toISOString() };
    await this.store.put(this.org, "share_links", link);
    await this.audit.record(this.org, actor, "share.create", "share", link.id, undefined, { claimId: input.claimId, expiresAt: link.expiresAt });
    return link;
  }

  /** Public, no-login view with the minimum data needed (PRD M10.2). */
  async sharedView(token: string) {
    const link = await this.store.get<ShareLink>(this.org, "share_links", token);
    if (!link || link.expiresAt < new Date().toISOString()) throw new AppError("This link has expired or does not exist", 404);
    if (!link.claimId) return { kind: "estimate", estimate: link.estimate, expiresAt: link.expiresAt };
    const claim = await this.claim(link.claimId);
    const patient = await this.patient(claim.patientId);
    const denials = await this.store.find<Denial>(this.org, "denials", { claimId: claim.id });
    const statusText: Record<string, string> = {
      draft: "Your clinic is preparing the insurance claim.",
      scrubbed: "Your clinic is preparing the insurance claim.",
      submitted: "The claim has been sent to your insurer.",
      acknowledged: "Your insurer has received the claim and is reviewing it.",
      paid: "Your insurer has paid its share. You only owe your co-pay.",
      partially_paid: "Your insurer paid part of the claim. The clinic is following up on the rest; you will not be charged more without being told.",
      denied: "Your insurer declined part of the claim. The clinic is reviewing it and may appeal.",
      resubmitted: "The clinic has appealed your insurer's decision and is waiting for a reply.",
      written_off: "The clinic has closed this claim with your insurer.",
      rejected: "The claim needs a correction by the clinic before your insurer can review it.",
    };
    return {
      kind: "bill",
      firstName: patient.name.split(" ")[0],
      visitDate: claim.serviceDate,
      clinic: ORGANIZATION.name,
      insurer: claim.payerName,
      services: claim.activities.map((a) => ({ service: lookupCode(a.code)?.plain ?? a.description, amount: a.gross })),
      total: claim.gross,
      yourShare: claim.patientShare,
      insurerShare: claim.net,
      status: statusText[claim.status] ?? claim.status,
      whatWeAreDoing: denials
        .filter((d) => d.status === "open" || d.status === "resubmitted")
        .map((d) => `${lookupCode(d.activityCode)?.plain ?? d.activityCode}: ${DENIAL_INDEX.get(d.code)?.plain ?? d.plainReason} ${d.status === "resubmitted" ? "We have appealed." : "We are reviewing this."}`),
      expiresAt: link.expiresAt,
    };
  }

  // ---------------------------------------------------------------- Public bill explainer (PRD M10.3)

  /**
   * Patient uploads a bill photo; OCR reads it, the model structures it and every code or denial
   * code found is explained from Sanad's own tables (not the model's memory). Works without the
   * model by pulling amounts and codes out of the transcript directly.
   */
  async explainBill(pages: string[]): Promise<BillExplanation> {
    if (!this.llm.ocr.enabled) throw new AppError("We can't read bill photos right now. Please ask the clinic's billing desk to go through it with you.", 503);
    const text = (await this.llm.ocr.read(pages).catch(() => {
      throw new AppError("We couldn't read that photo. Try a sharper, well-lit picture of the whole bill.", 422);
    })).text;
    if (!text.trim() || /^\[no text\]$/i.test(text.trim())) throw new AppError("We couldn't find any text on that photo. Try a sharper, well-lit picture of the whole bill.", 422);

    const model = this.llm.enabled
      ? await this.llm
          .structured({
            task: "bill-explanation",
            schema: BillSchema,
            system:
              "You help UAE patients understand a medical bill or insurance statement. Use only what is written in the transcript. List each billed line with its description, any code printed next to it (CPT, ICD-10, drug or denial code) and its amount in AED. Report what the insurer paid and what the patient owes if the bill states it (0 if not stated). Flags: short plain-language notes about anything unusual (a denial, a large patient share, a missing approval). Questions: 2-4 short questions the patient could ask their insurer or clinic. No medical advice.",
            user: `Bill transcript:\n\n${text.slice(0, 8000)}`,
            effort: "low",
            maxTokens: 2048,
          })
          .catch(() => null)
      : null;
    const result = model ?? offlineBill(text);

    const codeNotes = new Map<string, string>();
    const lines = result.lines.map((line) => {
      const code = line.code?.trim().toUpperCase();
      const entry = code ? lookupCode(code) : undefined;
      if (code && entry) codeNotes.set(code, entry.plain);
      return { desc: line.desc, code: code || undefined, amount: line.amount, plain: entry?.plain };
    });
    // Denial codes are explained from the official list, wherever they appear on the bill.
    const denials = [...new Set(text.toUpperCase().match(/\b[A-Z]{4}-\d{3,4}\b/g) ?? [])]
      .map((code) => DENIAL_INDEX.get(code))
      .filter((d): d is NonNullable<typeof d> => !!d)
      .map((d) => ({ code: d.code, plain: d.plain }));
    return {
      lines,
      insurerPaid: result.insurerPaid,
      youPay: result.youPay,
      flags: result.flags,
      questionsToAsk: result.questionsToAsk,
      denials,
      readByAssistant: !!model,
    };
  }
}

const BillSchema = z.object({
  lines: z.array(z.object({ desc: z.string(), code: z.string().optional(), amount: z.number() })).max(60),
  insurerPaid: z.number(),
  youPay: z.number(),
  flags: z.array(z.string()).max(6),
  questionsToAsk: z.array(z.string()).max(5),
});

export interface BillExplanation {
  lines: { desc: string; code?: string; amount: number; plain?: string }[];
  insurerPaid: number;
  youPay: number;
  flags: string[];
  questionsToAsk: string[];
  denials: { code: string; plain: string }[];
  /** False when the bill was read by simple rules only (lines may be incomplete). */
  readByAssistant: boolean;
}

/** Rule-based reading: "<description> ... <amount>" lines plus labelled totals. */
function offlineBill(text: string): z.output<typeof BillSchema> {
  const amountAt = (line: string) => {
    const m = line.match(/(-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)\s*(?:AED)?\s*$/i);
    return m ? Number(m[1].replace(/,/g, "")) : undefined;
  };
  const total = (re: RegExp) => {
    const line = text.split("\n").find((l) => re.test(l));
    return line ? (amountAt(line) ?? 0) : 0;
  };
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/total|insur|patient share|you (pay|owe)|balance|due|paid/i.test(l))
    .map((l) => ({ l, amount: amountAt(l) }))
    .filter((x): x is { l: string; amount: number } => x.amount !== undefined && x.amount > 0)
    .slice(0, 40)
    .map(({ l, amount }) => ({ desc: l.replace(/[\s.:-]*(AED)?\s*[\d,]+(\.\d+)?\s*(AED)?$/i, "").trim() || l, code: l.match(/\b(\d{5}|[A-Z]\d{2}(\.\d{1,4})?|[A-Z]\d{2}-\d{4}-\d{5}-\d{2})\b/)?.[1], amount }));
  return {
    lines,
    insurerPaid: total(/insur(er|ance) (paid|share|pays)|covered by/i),
    youPay: total(/patient share|you (pay|owe)|amount due|balance/i),
    flags: ["We read this bill with simple rules, so some lines may be missing. The clinic's billing desk can confirm the details."],
    questionsToAsk: ["Which of these services did my insurance cover, and why?", "Is my share on this bill the co-pay my plan sets?", "Was anything denied, and can it be appealed?"],
  };
}
