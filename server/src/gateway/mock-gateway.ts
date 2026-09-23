// Mock DHA eClaimLink / DOH Shafafiya gateway with scripted payer adjudication.
// It is a separate Hono app with its own namespace in the store, reachable only over HTTP
// through the adapter, so the platform cannot shortcut the exchange.
import { Hono } from "hono";
import { lookupCode } from "../data/codeset.ts";
import { DENIAL_INDEX, PAYERS, authRequired } from "../data/reference.ts";
import type { Store } from "../db.ts";
import { contractPrice } from "../rules/pricing.ts";
import { addDays, ageOn, daysBetween, dhaDate, isoDate, newId, parseDhaDate, round2 } from "../util.ts";
import {
  type ParsedRemittanceClaim,
  buildRemittanceAdvice,
  parseXml,
  validateClaimXml,
} from "../xml/claim-xml.ts";

const NS = "gateway";

export interface GatewayMember {
  id: string; // member ID
  emiratesId: string;
  payerId: string;
  plan: string;
  network: string;
  gender: "M" | "F";
  dob: string;
  coverageStart: string;
  coverageEnd: string;
}

/** Scripted outcome for a claim, used to seed realistic denials and underpayments. */
export interface GatewayScript {
  id: string; // claim ID
  activities: Record<string, { denialCode?: string; payFraction?: number }>;
  comment?: string;
  hold?: boolean;
  /** Adjudicate as if settled this many days ago (seeded history). */
  settledDaysAgo?: number;
}

interface GatewayClaim {
  id: string; // `${claimId}#${n}`
  claimId: string;
  idPayer: string;
  senderId: string;
  payerRegulatorId: string;
  memberId: string;
  patientId: string;
  serviceDate: string;
  transactionDate: string;
  /** Claim-level Net/Gross, used to compare activity nets with contract prices net of co-pay. */
  netRatio: number;
  diagnoses: string[];
  activities: {
    id: string;
    code: string;
    type: string;
    quantity: number;
    net: number;
    priorAuth?: string;
  }[];
  resubmission?: { type: string; comment: string };
  adjudicateAt: string;
  status: "pending" | "adjudicated";
}

interface GatewayPrior {
  id: string; // ref
  senderId: string;
  payerId: string;
  memberId: string;
  diagnosis: string;
  codes: string[];
  justification: string;
  decideAt: string;
  status: "pending" | "approved" | "rejected" | "info_requested";
  approvalNumber?: string;
  validUntil?: string;
  comment?: string;
}

interface GatewayRemittance {
  id: string;
  senderId: string;
  xml: string;
  createdAt: string;
  held: boolean;
  downloaded: boolean;
}

interface AdjudicationContext {
  scripts: Map<string, GatewayScript>;
  members: Map<string, GatewayMember>;
  priors: GatewayPrior[];
  adjudicated: GatewayClaim[];
}

const payerByRegulatorId = (id: string) => PAYERS.find((p) => p.regulatorPayerId === id);
const list = <T>(v: unknown): T[] => (v === undefined ? [] : Array.isArray(v) ? (v as T[]) : [v as T]);

export function createMockGateway(store: Store, options: { adjudicationDelaySeconds: number }) {
  const app = new Hono();

  async function adjudicateDue(now = new Date()) {
    const pending = await store.find<GatewayClaim>(NS, "claims", { status: "pending" });
    const due = pending.filter((c) => c.adjudicateAt <= now.toISOString());
    if (!due.length) return;
    // Group into one remittance per sender, payer and hold flag.
    const groups = new Map<string, { claims: ParsedRemittanceClaim[]; held: boolean; senderId: string; payerId: string }>();
    // Preload scripts, members, approvals and prior claims once for the whole batch.
    const ctx: AdjudicationContext = {
      scripts: new Map((await store.getMany<GatewayScript>(NS, "scripts", due.map((c) => c.claimId))).map((x) => [x.id, x])),
      members: new Map((await store.getMany<GatewayMember>(NS, "members", [...new Set(due.map((c) => c.memberId))])).map((m) => [m.id, m])),
      priors: await store.find<GatewayPrior>(NS, "prior_requests", { status: "approved" }),
      adjudicated: await store.find<GatewayClaim>(NS, "claims", { status: "adjudicated" }),
    };
    for (const claim of due) {
      const script = ctx.scripts.get(claim.claimId) ?? null;
      const result = adjudicate(claim, script, now, ctx);
      const held = !!script?.hold && !claim.resubmission;
      const key = `${claim.senderId}|${claim.payerRegulatorId}|${held}`;
      const group = groups.get(key) ?? { claims: [], held, senderId: claim.senderId, payerId: claim.payerRegulatorId };
      group.claims.push(result);
      groups.set(key, group);
      claim.status = "adjudicated";
      ctx.adjudicated.push(claim);
    }
    await store.putMany(NS, "claims", due);
    for (const group of groups.values()) {
      const remittance: GatewayRemittance = {
        id: newId("ra"),
        senderId: group.senderId,
        xml: buildRemittanceAdvice(group.payerId, group.senderId, group.claims, now),
        createdAt: now.toISOString(),
        held: group.held,
        downloaded: false,
      };
      await store.put(NS, "remittances", remittance);
    }
  }

  function adjudicate(claim: GatewayClaim, script: GatewayScript | null, now: Date, ctx: AdjudicationContext): ParsedRemittanceClaim {
    const payer = payerByRegulatorId(claim.payerRegulatorId);
    const member = ctx.members.get(claim.memberId);
    const settled = script?.settledDaysAgo !== undefined && !claim.resubmission ? addDays(now, -script.settledDaysAgo) : now;
    const priors = ctx.priors.filter((p) => p.memberId === claim.memberId);
    const others = ctx.adjudicated.filter(
      (c) => c.memberId === claim.memberId && c.claimId !== claim.claimId && c.serviceDate === claim.serviceDate,
    );
    const lateDays = daysBetween(claim.serviceDate, claim.transactionDate);
    const appealAccepted = !!claim.resubmission && claim.resubmission.comment.length >= 40;
    const activities = claim.activities.map((a): ParsedRemittanceClaim["activities"][number] => {
      const scripted = script?.activities[a.code];
      const deny = (code: string) => ({ id: a.id, code: a.code, net: a.net, paymentAmount: 0, denialCode: code });
      const entry = lookupCode(a.code);
      if (!payer) return deny("ELIG-001");
      if (!member || claim.serviceDate < member.coverageStart || claim.serviceDate > member.coverageEnd) return deny("ELIG-001");
      if (!entry || !entry.active) return deny("CODE-020");
      if (claim.diagnoses.some((d) => !lookupCode(d)?.active)) return deny("CODE-020");
      if (authRequired(payer, a.code)) {
        const ok = priors.some((p) => p.approvalNumber === a.priorAuth && p.codes.includes(a.code));
        if (!ok) return deny("AUTH-001");
      }
      if (entry.supportedBy?.length && !claim.diagnoses.some((d) => entry.supportedBy?.some((p) => d.startsWith(p))))
        return deny("CODE-010");
      const codesToCheck = [a.code, ...claim.diagnoses];
      for (const c of codesToCheck) {
        const e = lookupCode(c);
        const age = ageOn(member.dob, claim.serviceDate);
        if (e?.gender && e.gender !== member.gender) return deny("CODE-014");
        if ((e?.minAge !== undefined && age < e.minAge) || (e?.maxAge !== undefined && age > e.maxAge)) return deny("CODE-014");
      }
      if (others.some((o) => o.activities.some((x) => x.code === a.code))) return deny("DUPL-001");
      if (!claim.resubmission && lateDays > payer.submissionWindowDays) return deny("TIME-001");
      // Scripted clinical/documentation outcomes: a well-argued resubmission overturns them.
      if (scripted?.denialCode && !(appealAccepted && ["medical_necessity", "documentation"].includes(DENIAL_INDEX.get(scripted.denialCode)?.category ?? "")))
        return deny(scripted.denialCode);
      const allowed = round2(contractPrice(payer.id, a.code) * a.quantity * (claim.resubmission ? 1 : claim.netRatio));
      // Tolerance absorbs co-pay apportionment rounding.
      if (allowed > 0 && a.net > allowed + 0.5)
        return { id: a.id, code: a.code, net: a.net, paymentAmount: allowed, denialCode: "PRCE-001" };
      const fraction = claim.resubmission ? 1 : (scripted?.payFraction ?? 1);
      return { id: a.id, code: a.code, net: a.net, paymentAmount: round2(a.net * fraction) };
    });
    return {
      id: claim.claimId,
      idPayer: claim.idPayer,
      paymentReference: `PAY-${claim.payerRegulatorId}-${isoDate(settled).replaceAll("-", "")}-${claim.idPayer.slice(-4)}`,
      dateSettlement: dhaDate(settled),
      comments: activities.some((a) => a.denialCode) ? script?.comment : undefined,
      activities,
    };
  }

  app.post("/claims", async (c) => {
    const senderId = c.req.header("X-Sender-ID") ?? "";
    const xml = await c.req.text();
    const errors = validateClaimXml(xml);
    if (errors.length) return c.json({ status: "rejected", errors });
    const doc = parseXml(xml)["Claim.Submission"] as Record<string, any>;
    const transactionId = newId("tx");
    const transactionDate = parseDhaDate(String(doc.Header.TransactionDate));
    const accepted: { id: string; idPayer: string }[] = [];
    const raws = list<Record<string, any>>(doc.Claim);
    const ids = raws.map((r) => String(r.ID));
    const scriptMap = new Map((await store.getMany<GatewayScript>(NS, "scripts", ids)).map((x) => [x.id, x]));
    const known = (await store.list<GatewayClaim>(NS, "claims")).filter((c) => ids.includes(c.claimId));
    const toStore: GatewayClaim[] = [];
    for (const raw of raws) {
      const existing = known.filter((c) => c.claimId === String(raw.ID));
      const idPayer = existing[0]?.idPayer ?? `${String(doc.Header.ReceiverID).slice(0, 4)}${Math.floor(Math.random() * 9e7 + 1e7)}`;
      const script = scriptMap.get(String(raw.ID));
      const delay = script?.hold || script?.settledDaysAgo !== undefined ? 0 : options.adjudicationDelaySeconds;
      const claim: GatewayClaim = {
        id: `${raw.ID}#${existing.length + 1}`,
        claimId: String(raw.ID),
        idPayer,
        senderId,
        payerRegulatorId: String(raw.PayerID),
        memberId: String(raw.MemberID),
        patientId: String(raw.Encounter.PatientID),
        serviceDate: isoDate(new Date(parseDhaDate(String(raw.Encounter.Start)))),
        transactionDate: isoDate(new Date(transactionDate)),
        netRatio: Number(raw.Gross) > 0 ? Number(raw.Net) / Number(raw.Gross) : 1,
        diagnoses: list<Record<string, any>>(raw.Diagnosis).map((d) => String(d.Code)),
        activities: list<Record<string, any>>(raw.Activity).map((a) => ({
          id: String(a.ID),
          code: String(a.Code),
          type: String(a.Type),
          quantity: Number(a.Quantity),
          net: Number(a.Net),
          priorAuth: a.PriorAuthorizationID ? String(a.PriorAuthorizationID) : undefined,
        })),
        resubmission: raw.Resubmission ? { type: String(raw.Resubmission.Type), comment: String(raw.Resubmission.Comment) } : undefined,
        adjudicateAt: new Date(Date.now() + delay * 1000).toISOString(),
        status: "pending",
      };
      toStore.push(claim);
      accepted.push({ id: claim.claimId, idPayer });
    }
    await store.putMany(NS, "claims", toStore);
    return c.json({ status: "acknowledged", transactionId, claims: accepted });
  });

  app.get("/remittances", async (c) => {
    const sender = c.req.query("sender") ?? "";
    await adjudicateDue();
    const ready = (await store.find<GatewayRemittance>(NS, "remittances", { senderId: sender, downloaded: false, held: false })).sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt),
    );
    for (const r of ready) await store.put(NS, "remittances", { ...r, downloaded: true });
    return c.json({ remittances: ready.map((r) => ({ id: r.id, xml: r.xml })) });
  });

  app.post("/prior-requests", async (c) => {
    const senderId = c.req.header("X-Sender-ID") ?? "";
    const doc = parseXml(await c.req.text())["Prior.Request"] as Record<string, any> | undefined;
    if (!doc?.Authorization) return c.json({ error: "Not a Prior.Request document" }, 422);
    const auth = doc.Authorization;
    const payer = payerByRegulatorId(String(auth.PayerID));
    if (!payer) return c.json({ error: "Unknown payer" }, 422);
    const observations = list<Record<string, any>>(auth.Observation);
    const prior: GatewayPrior = {
      id: newId("PR").toUpperCase(),
      senderId,
      payerId: payer.id,
      memberId: String(auth.MemberID),
      diagnosis: String(list<Record<string, any>>(auth.Diagnosis)[0]?.Code ?? ""),
      codes: list<Record<string, any>>(auth.Activity).map((a) => String(a.Code)),
      justification: String(observations.find((o) => o.Code === "Justification")?.Value ?? ""),
      decideAt: new Date(Date.now() + options.adjudicationDelaySeconds * 1000).toISOString(),
      status: "pending",
    };
    await store.put(NS, "prior_requests", prior);
    return c.json({ ref: prior.id, status: prior.status });
  });

  app.get("/prior-requests/:ref", async (c) => {
    const prior = await store.get<GatewayPrior>(NS, "prior_requests", c.req.param("ref"));
    if (!prior) return c.json({ error: "Unknown prior request" }, 404);
    if (prior.status === "pending" && prior.decideAt <= new Date().toISOString()) {
      const member = await store.get<GatewayMember>(NS, "members", prior.memberId);
      const unsupported = prior.codes.filter((code) => {
        const entry = lookupCode(code);
        return entry?.supportedBy?.length && !entry.supportedBy.some((p) => prior.diagnosis.startsWith(p));
      });
      if (!member) Object.assign(prior, { status: "rejected", comment: "Member not found" });
      else if (unsupported.length)
        Object.assign(prior, { status: "rejected", comment: `Diagnosis ${prior.diagnosis} does not support ${unsupported.join(", ")}` });
      else if (prior.justification.trim().length < 40)
        Object.assign(prior, { status: "info_requested", comment: "Please provide clinical justification (history, findings, prior treatment)." });
      else
        Object.assign(prior, {
          status: "approved",
          approvalNumber: `PA-${prior.payerId.replace("payer_", "").toUpperCase()}-${prior.id.slice(-6)}`,
          validUntil: isoDate(addDays(new Date(), 30)),
        });
      await store.put(NS, "prior_requests", prior);
    }
    return c.json({
      ref: prior.id,
      status: prior.status,
      approvalNumber: prior.approvalNumber,
      validUntil: prior.validUntil,
      comment: prior.comment,
    });
  });

  app.get("/eligibility", async (c) => {
    const { emiratesId, memberId, date } = c.req.query();
    let member = memberId ? await store.get<GatewayMember>(NS, "members", memberId) : null;
    if (!member && emiratesId) member = (await store.find<GatewayMember>(NS, "members", { emiratesId }))[0] ?? null;
    if (!member) return c.json({ eligible: false, reason: "No member found for the given identifiers" });
    const payer = PAYERS.find((p) => p.id === member.payerId);
    const plan = payer?.plans.find((p) => p.name === member.plan);
    const on = date || isoDate(new Date());
    const active = on >= member.coverageStart && on <= member.coverageEnd;
    return c.json({
      eligible: active,
      payerId: member.payerId,
      memberId: member.id,
      plan: member.plan,
      network: member.network,
      coverageStart: member.coverageStart,
      coverageEnd: member.coverageEnd,
      copayPercent: plan?.copayPercent,
      copayCapPerVisit: plan?.copayCapPerVisit,
      reason: active ? undefined : `Coverage ended ${member.coverageEnd}`,
    });
  });

  // Mock-only administration used by the seed script and the demo controls.
  app.post("/admin/members", async (c) => {
    const members = (await c.req.json()) as GatewayMember[];
    await store.putMany(NS, "members", members);
    return c.json({ ok: true, count: members.length });
  });
  app.post("/admin/scripts", async (c) => {
    const scripts = (await c.req.json()) as GatewayScript[];
    await store.putMany(NS, "scripts", scripts);
    return c.json({ ok: true, count: scripts.length });
  });
  app.post("/admin/prior-approvals", async (c) => {
    const priors = (await c.req.json()) as GatewayPrior[];
    await store.putMany(NS, "prior_requests", priors);
    return c.json({ ok: true });
  });
  app.post("/admin/release", async (c) => {
    await adjudicateDue();
    const held = await store.find<GatewayRemittance>(NS, "remittances", { held: true });
    for (const r of held) await store.put(NS, "remittances", { ...r, held: false });
    return c.json({ released: held.length });
  });
  app.post("/admin/reset", async (c) => {
    await store.clear(NS);
    return c.json({ ok: true });
  });

  return app;
}
