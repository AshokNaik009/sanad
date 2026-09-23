// Deterministic synthetic dataset (PRD section 10). Fake Emirates IDs use the clearly invalid
// 784-0000- range; names are generated; no real patient data is ever used.
import { lookupCode } from "./data/codeset.ts";
import { BASE_NOTES, type BaseNote, type Side, renderNote } from "./data/notes.ts";
import {
  CLINICIANS,
  DENIAL_INDEX,
  ORGANIZATION,
  PAYERS,
  SPECIALTY_CLINICIANS,
  USERS,
  authRequired,
  clinicianById,
  payerById,
} from "./data/reference.ts";
import type {
  Activity,
  Claim,
  Denial,
  Encounter,
  Patient,
  PriorAuth,
  RemittanceLine,
} from "./domain/types.ts";
import type { GatewayMember, GatewayScript } from "./gateway/mock-gateway.ts";
import { chargemasterPrice, contractPrice, recalcTotals } from "./rules/pricing.ts";
import { scrubClaim } from "./rules/scrubber.ts";
import type { Platform } from "./services/platform.ts";
import { addDays, encrypt, isoDate, maskEmiratesId, round2, rng } from "./util.ts";
import { buildClaimSubmission } from "./xml/claim-xml.ts";

const FIRST_M = ["Ahmed", "Omar", "Yousef", "Khalid", "Rashid", "Arjun", "Rohan", "Vikram", "Joseph", "Daniel", "Mohammed", "Hamdan", "Faisal", "Tariq", "Imran", "Sanjay", "Ali", "Hassan", "Karim", "Nabil"];
const FIRST_F = ["Aisha", "Fatima", "Mariam", "Noura", "Hessa", "Priya", "Ananya", "Sara", "Leila", "Maya", "Reem", "Latifa", "Shamma", "Zainab", "Grace", "Hana", "Dana", "Salma", "Meera", "Rania"];
const LAST = ["Al Mansoori", "Al Hashimi", "Khan", "Nair", "Haddad", "Rahman", "Al Suwaidi", "Pillai", "Fernandes", "Qureshi", "Al Marri", "Menon", "Saleh", "Aziz", "Kapoor", "Al Nuaimi", "Farouk", "Thomas", "Iyer", "Al Ketbi"];

export interface SeedOptions {
  /** Release the seeded payer remittance run immediately instead of holding it for the demo. */
  releaseRemittances?: boolean;
  historical?: number;
}

export interface SeedSummary {
  patients: number;
  encounters: number;
  seededErrorClaims: number;
  controlClaims: number;
  seededDenials: number;
  seededUnderpayments: number;
  historicalClaims: number;
  demoEncounterId: string;
}

export async function seed(platform: Platform, gatewayAdmin: (path: string, body: unknown) => Promise<void>, options: SeedOptions = {}): Promise<SeedSummary> {
  const { store, org, config } = platform;
  const r = rng(20260923);
  const today = platform.today();
  const daysAgo = (n: number) => isoDate(addDays(today, -n));

  await store.clear(org);
  await gatewayAdmin("/admin/reset", {});

  await store.put(org, "meta", { ...ORGANIZATION, id: "organization" });
  await store.putMany(org, "users", USERS);
  await store.putMany(org, "clinicians", CLINICIANS);
  await store.putMany(org, "payers", PAYERS);
  const priceList = PAYERS.flatMap((p) =>
    [...new Set(BASE_NOTES.flatMap((b) => b.gold("right").procedures.concat(b.gold("left").procedures)))].map((code) => ({
      id: `${p.id}_${code}`,
      payerId: p.id,
      code,
      netPrice: contractPrice(p.id, code),
      effectiveFrom: "2026-01-01",
    })),
  );
  await store.putMany(org, "price_list", priceList);

  // ------------------------------------------------------------------ Patients (150)
  const patients: Patient[] = [];
  for (let i = 0; i < 150; i++) {
    const gender: "M" | "F" = i % 2 === 0 ? "F" : "M";
    const child = i % 15 === 7;
    const age = child ? r.int(5, 14) : r.int(19, 76);
    const dob = isoDate(new Date(Date.UTC(new Date(today).getUTCFullYear() - age, r.int(0, 11), r.int(1, 28))));
    const payer = PAYERS[i % 3];
    const plan = r.pick(["Basic", "Enhanced", "Enhanced", "Premium"]);
    const eid = `784-0000-${String(1000000 + i * 7919).slice(0, 7)}-${i % 10}`;
    const expired = i % 25 === 11; // 6 members whose cover lapsed mid-year
    patients.push({
      id: `pat_${String(i + 1).padStart(3, "0")}`,
      name: `${gender === "F" ? r.pick(FIRST_F) : r.pick(FIRST_M)} ${r.pick(LAST)}`,
      dob,
      gender,
      emiratesIdEnc: encrypt(config.encryptionKey, eid),
      emiratesIdMasked: maskEmiratesId(eid),
      memberId: `${payer.regulatorPayerId.slice(0, 4)}-${String(20000 + i * 37).padStart(6, "0")}`,
      payerId: payer.id,
      plan,
      coverageStart: "2026-01-01",
      coverageEnd: expired ? "2026-06-30" : "2026-12-31",
      network: payer.plans.find((p) => p.name === plan)?.network ?? "General",
    });
  }
  // The demo patient: physiotherapy on Nahr Health (auth-heavy payer).
  Object.assign(patients[0], { name: "Mariam Al Mansoori", gender: "F", dob: "1968-04-12", payerId: "payer_nahr", plan: "Enhanced", memberId: "A001-020000", coverageEnd: "2026-12-31" });
  await store.putMany(org, "patients", patients);
  await gatewayAdmin(
    "/admin/members",
    patients.map((p): GatewayMember => ({
      id: p.memberId,
      emiratesId: platform.emiratesId(p),
      payerId: p.payerId,
      plan: p.plan,
      network: p.network,
      gender: p.gender,
      dob: p.dob,
      coverageStart: p.coverageStart,
      coverageEnd: p.coverageEnd,
    })),
  );

  const age = (p: Patient, on = today) => Math.floor((new Date(on).getTime() - new Date(p.dob).getTime()) / 31_557_600_000);
  const activeAdults = patients.filter((p) => p.coverageEnd >= today && age(p) >= 18);
  const pickPatient = (pred: (p: Patient) => boolean) => {
    const pool = activeAdults.filter(pred);
    return pool[r.int(0, pool.length - 1)];
  };
  const noteBy = (key: string) => BASE_NOTES.find((b) => b.key === key) as BaseNote;

  // ------------------------------------------------------------------ Encounters and claims
  const encounters: Encounter[] = [];
  const claims: Claim[] = [];
  const priorAuths: PriorAuth[] = [];
  const gatewayPriors: unknown[] = [];
  const scripts: GatewayScript[] = [];
  let encSeq = 0;

  const makeEncounter = (base: BaseNote, patient: Patient, date: string, side: Side = "right", extra: Partial<Encounter> = {}): Encounter => {
    const clinicianId = r.pick(SPECIALTY_CLINICIANS[base.specialty]);
    const enc: Encounter = {
      id: `enc_${String(++encSeq).padStart(4, "0")}`,
      patientId: patient.id,
      clinicianId,
      payerId: patient.payerId,
      date,
      type: "outpatient",
      specialty: base.specialty,
      note: renderNote(base, side, age(patient, date)),
      source: "synthetic_emr",
      status: "to_code",
      ...extra,
    };
    encounters.push(enc);
    return enc;
  };

  const approve = (patient: Patient, codes: string[], diagnosis: string, date: string, encounterId?: string): PriorAuth => {
    const payer = payerById(patient.payerId);
    const n = priorAuths.length + 1;
    const approvalNumber = `PA-${payer.id.replace("payer_", "").toUpperCase()}-${String(480000 + n * 17)}`;
    const pa: PriorAuth = {
      id: `pa_seed_${n}`,
      encounterId,
      patientId: patient.id,
      payerId: payer.id,
      services: codes.map((code) => ({ code, description: lookupCode(code)?.description ?? code })),
      diagnosis,
      justification: "Approved before the visit (seeded).",
      status: "approved",
      approvalNumber,
      validUntil: isoDate(addDays(date, 30)),
      gatewayRef: `PRSEED${n}`,
      createdAt: addDays(date, -3).toISOString(),
    };
    priorAuths.push(pa);
    gatewayPriors.push({ id: pa.gatewayRef, senderId: platform.senderId, payerId: payer.id, memberId: patient.memberId, diagnosis, codes, justification: pa.justification, decideAt: pa.createdAt, status: "approved", approvalNumber, validUntil: pa.validUntil });
    return pa;
  };

  /** Build a claim the way the coding workflow would, priced at the contract price (clean). */
  const makeClaim = (enc: Encounter, patient: Patient, codes: { principal: string; procedures: string[]; secondary?: string[] }, extra: Partial<Claim> = {}): Claim => {
    const clinician = clinicianById(enc.clinicianId);
    const payer = payerById(patient.payerId);
    const activities: Activity[] = codes.procedures.map((code, i) => {
      const entry = lookupCode(code);
      return {
        id: `act_${enc.id.slice(4)}_${i + 1}`,
        codeType: entry?.type === "ICD10" || !entry ? "CPT" : entry.type,
        code,
        description: entry?.description ?? code,
        quantity: 1,
        gross: Math.min(chargemasterPrice(code), contractPrice(payer.id, code)),
        patientShare: 0,
        net: 0,
        clinicianLicence: clinician.licence,
      };
    });
    const claim: Claim = {
      id: `clm_${enc.id.slice(4)}`,
      encounterId: enc.id,
      patientId: patient.id,
      payerId: payer.id,
      payerName: payer.name,
      clinicianId: clinician.id,
      clinicianName: clinician.name,
      clinicianLicence: clinician.licence,
      specialty: enc.specialty,
      encounterType: enc.type,
      serviceDate: enc.date,
      status: "draft",
      diagnoses: [
        { code: codes.principal, type: "principal", description: lookupCode(codes.principal)?.description ?? codes.principal },
        ...(codes.secondary ?? []).map((code) => ({ code, type: "secondary" as const, description: lookupCode(code)?.description ?? code })),
      ],
      activities,
      gross: 0,
      patientShare: 0,
      net: 0,
      timeline: [{ status: "draft", at: new Date(enc.date).toISOString(), note: "Imported from practice management system" }],
      ...extra,
    };
    recalcTotals(claim, patient);
    enc.status = "claimed";
    enc.claimId = claim.id;
    enc.codedAt = new Date(enc.date).toISOString();
    claims.push(claim);
    return claim;
  };

  const attachAuthIfNeeded = (claim: Claim, patient: Patient) => {
    const payer = payerById(claim.payerId);
    const needs = claim.activities.filter((a) => authRequired(payer, a.code));
    if (!needs.length) return;
    const pa = approve(patient, needs.map((a) => a.code), claim.diagnoses[0].code, claim.serviceDate, claim.encounterId);
    for (const a of needs) a.priorAuthNumber = pa.approvalNumber;
  };

  // 1. Coding gold set: 20 encounters waiting in the coding queue.
  const gold: Encounter[] = [];
  BASE_NOTES.forEach((base, i) => {
    const patient = i === 0 ? patients[0] : pickPatient((p) => (base.key === "derm-acne" ? age(p) < 40 : true));
    const enc = makeEncounter(base, patient, daysAgo(1 + (i % 3)), "right", { gold: base.gold("right") });
    gold.push(enc);
  });
  const demo = gold[0];
  // Front desk obtained approval before the visit, but the number never reached the encounter.
  approve(patients[0], ["97161", "97110", "G0283"], "M17.11", demo.date);

  // 2. Thirty claims with seeded scrubber errors (one error family each).
  type Seeded = { key: string; family: string; payer?: string; side?: Side; gender?: "M" | "F"; child?: boolean; mutate: (c: Claim, p: Patient) => void; codes?: { principal: string; procedures: string[] } };
  const seeded: Seeded[] = [
    // Authorisation (6): services needing approval, none on file.
    ...[0, 1, 2].map(() => ({ key: "physio-knee-oa", family: "authorisation", payer: "payer_nahr", mutate: () => {} })),
    ...[0, 1].map(() => ({ key: "physio-shoulder", family: "authorisation", payer: "payer_nahr", mutate: () => {} })),
    { key: "ortho-knee-injection", family: "authorisation", payer: "payer_saffron", mutate: (c: Claim) => c.activities.push(act(c, "20610")) },
    // Code pairing (5): medical necessity mismatches and exclusive pairs.
    { key: "gp-urti", family: "code_pairing", payer: "payer_gulf", mutate: (c: Claim) => c.activities.push(act(c, "83036")) },
    { key: "physio-low-back", family: "code_pairing", payer: "payer_gulf", mutate: (c: Claim) => c.activities.push(act(c, "87880")) },
    { key: "gp-asthma", family: "code_pairing", payer: "payer_saffron", mutate: (c: Claim) => c.activities.push(act(c, "72100")) },
    { key: "physio-low-back", family: "code_pairing", payer: "payer_gulf", mutate: (c: Claim) => c.activities.push(act(c, "97530")) },
    { key: "gp-headache-im", family: "code_pairing", payer: "payer_gulf", mutate: (c: Claim) => c.activities.push(act(c, "20610")), codes: { principal: "M17.11", procedures: ["99203", "96372"] } },
    // Pricing (5): billed above the payer contract.
    { key: "gp-diabetes", family: "pricing", payer: "payer_nahr", mutate: (c: Claim) => { c.activities[0] = { ...act(c, "99214"), gross: 350 }; } },
    { key: "gp-hypertension", family: "pricing", payer: "payer_saffron", mutate: (c: Claim) => { c.activities[0] = { ...act(c, "99214"), gross: 350 }; } },
    { key: "physio-shoulder", family: "pricing", payer: "payer_saffron", mutate: (c: Claim) => { c.activities[0].gross = 200; } },
    { key: "derm-eczema", family: "pricing", payer: "payer_gulf", mutate: (c: Claim) => { c.activities[0].gross = 300; } },
    { key: "gp-uti", family: "pricing", payer: "payer_gulf", mutate: (c: Claim) => { c.activities[1].gross = 95; } },
    // Duplicates (4): created below against in-flight claims.
    // Completeness (4)
    ...[0, 1].map((i) => ({ key: i ? "derm-psoriasis" : "gp-asthma", family: "completeness", payer: "payer_gulf", mutate: (c: Claim) => { c.clinicianLicence = undefined; for (const a of c.activities) a.clinicianLicence = undefined; } })),
    ...[0, 1].map((i) => ({ key: i ? "derm-acne" : "gp-vitd", family: "completeness", payer: "payer_saffron", mutate: (c: Claim) => { c.encounterType = undefined; } })),
    // Demographic (3)
    { key: "gp-uti", family: "demographic", payer: "payer_gulf", gender: "M" as const, mutate: (c: Claim) => { c.diagnoses[0] = dx("Z01.419"); c.activities = [c.activities[0]]; } },
    { key: "gp-uti", family: "demographic", payer: "payer_saffron", gender: "F" as const, mutate: (c: Claim) => { c.diagnoses[0] = dx("N40.0"); c.activities = [c.activities[0]]; } },
    { key: "gp-annual", family: "demographic", payer: "payer_gulf", child: true, mutate: () => {} },
    // Code validity (3): deleted code M54.5.
    ...[0, 1, 2].map(() => ({ key: "physio-low-back", family: "code_validity", payer: "payer_gulf", mutate: (c: Claim) => { c.diagnoses[0] = { ...dx("M54.50"), code: "M54.5", description: "Low back pain" }; } })),
  ];
  function act(c: Claim, code: string): Activity {
    const entry = lookupCode(code);
    return { id: `${c.activities[0]?.id ?? `act_${c.id}`}_x${code}`, codeType: entry?.type === "ICD10" || !entry ? "CPT" : entry.type, code, description: entry?.description ?? code, quantity: 1, gross: Math.min(chargemasterPrice(code), contractPrice(c.payerId, code)), patientShare: 0, net: 0, clinicianLicence: c.clinicianLicence };
  }
  function dx(code: string) {
    return { code, type: "principal" as const, description: lookupCode(code)?.description ?? code };
  }
  const errorClaims: Claim[] = [];
  for (const s of seeded) {
    const base = noteBy(s.key);
    const patient = s.child
      ? (patients.filter((p) => age(p) < 18 && p.coverageEnd >= today && p.payerId === s.payer)[0] ?? patients.find((p) => age(p) < 18 && p.coverageEnd >= today) as Patient)
      : pickPatient((p) => (!s.payer || p.payerId === s.payer) && (!s.gender || p.gender === s.gender));
    const enc = makeEncounter(base, patient, daysAgo(r.int(2, 20)));
    const claim = makeClaim(enc, patient, s.codes ?? base.gold("right"), { seed: { errors: [s.family] } });
    if (s.family !== "authorisation") attachAuthIfNeeded(claim, patient);
    s.mutate(claim, patient);
    recalcTotals(claim, patient);
    errorClaims.push(claim);
  }

  // 3. Clean control drafts (ready to submit), used for false-flag measurement.
  const controls: Claim[] = [];
  for (const key of ["gp-urti", "gp-hypertension", "derm-acne", "derm-sk-cryo", "gp-uti", "derm-eczema", "gp-asthma", "ortho-ankle", "derm-psoriasis", "gp-vitd"]) {
    const base = noteBy(key);
    const patient = pickPatient(() => true);
    const enc = makeEncounter(base, patient, daysAgo(r.int(1, 6)));
    const claim = makeClaim(enc, patient, base.gold("right"), { seed: { errors: [] } });
    attachAuthIfNeeded(claim, patient);
    recalcTotals(claim, patient);
    controls.push(claim);
  }

  // 4. In-flight claims: acknowledged by the payer, awaiting adjudication (A/R).
  const inflight: Claim[] = [];
  for (let i = 0; i < 40; i++) {
    const base = BASE_NOTES[i % 19];
    const patient = pickPatient(() => true);
    const side: Side = base.sided && i % 2 ? "left" : "right";
    const enc = makeEncounter(base, patient, daysAgo(r.int(6, 45)), side);
    const claim = makeClaim(enc, patient, base.gold(side));
    attachAuthIfNeeded(claim, patient);
    recalcTotals(claim, patient);
    const submittedAt = addDays(enc.date, r.int(1, 4)).toISOString();
    Object.assign(claim, { status: "acknowledged", submittedAt, approvedBy: "u_aisha", approvedAt: submittedAt, submissionId: "sub_legacy" });
    claim.timeline.push({ status: "submitted", at: submittedAt, by: "u_aisha" }, { status: "acknowledged", at: submittedAt });
    inflight.push(claim);
  }
  // Duplicates (4): drafts repeating an in-flight claim's patient, date and service.
  for (let i = 0; i < 4; i++) {
    const original = inflight[i * 3];
    const patient = patients.find((p) => p.id === original.patientId) as Patient;
    const enc = makeEncounter(noteBy(BASE_NOTES[(i * 3) % 19].key), patient, original.serviceDate);
    enc.note = encounters.find((e) => e.id === original.encounterId)?.note ?? enc.note;
    const base = BASE_NOTES[(i * 3) % 19];
    const side: Side = base.sided && (i * 3) % 2 ? "left" : "right";
    const claim = makeClaim(enc, patient, base.gold(side), { seed: { errors: ["duplicates"] } });
    claim.activities.forEach((a, j) => (a.priorAuthNumber = original.activities[j]?.priorAuthNumber));
    errorClaims.push(claim);
  }

  // 5. The held payer remittance run: 15 denials, 5 underpayments, 25 clean payments.
  const heldBatch: Claim[] = [];
  const denialPlan: { key: string; payer: string; side?: Side; deny: string; code?: string; comment?: string; settledDaysAgo: number; lateService?: boolean; expired?: boolean; mutate?: (c: Claim) => void; noAuth?: boolean; only?: string }[] = [
    { key: "ortho-knee-mri", payer: "payer_gulf", deny: "MNEC-003", code: "73721", settledDaysAgo: 12 },
    { key: "ortho-knee-mri", payer: "payer_saffron", side: "left", deny: "MNEC-003", code: "73721", settledDaysAgo: 24 },
    { key: "ortho-knee-injection", payer: "payer_nahr", deny: "MNEC-005", code: "20610", settledDaysAgo: 9 },
    { key: "physio-knee-oa", payer: "payer_nahr", deny: "AUTH-001", settledDaysAgo: 18, noAuth: true, only: "97110" },
    { key: "physio-shoulder", payer: "payer_nahr", side: "left", deny: "AUTH-001", settledDaysAgo: 6, noAuth: true, only: "97140" },
    { key: "ortho-knee-injection", payer: "payer_saffron", side: "left", deny: "AUTH-001", settledDaysAgo: 27, noAuth: true },
    { key: "physio-low-back", payer: "payer_gulf", deny: "CODE-020", settledDaysAgo: 8, only: "97110", mutate: (c) => { c.diagnoses[0] = { code: "M54.5", type: "principal", description: "Low back pain" }; } },
    { key: "gp-asthma", payer: "payer_saffron", deny: "CODE-010", settledDaysAgo: 15, mutate: (c) => { c.activities.push({ ...c.activities[0], id: `${c.activities[0].id}_b`, code: "93000", description: lookupCode("93000")?.description ?? "", gross: 150 }); } },
    { key: "derm-acne", payer: "payer_nahr", deny: "PRCE-001", settledDaysAgo: 10, mutate: (c) => { c.activities[0] = { ...c.activities[0], code: "99214", description: lookupCode("99214")?.description ?? "", gross: 350 }; } },
    { key: "gp-hypertension", payer: "payer_saffron", deny: "PRCE-001", settledDaysAgo: 20, mutate: (c) => { c.activities[0] = { ...c.activities[0], code: "99214", description: lookupCode("99214")?.description ?? "", gross: 350 }; } },
    { key: "gp-uti", payer: "payer_gulf", deny: "ELIG-001", settledDaysAgo: 14, expired: true, only: "99213" },
    { key: "derm-eczema", payer: "payer_nahr", deny: "ELIG-001", settledDaysAgo: 25, expired: true },
    { key: "gp-diabetes", payer: "payer_nahr", deny: "TIME-001", settledDaysAgo: 5, lateService: true, only: "99213" },
    { key: "physio-shoulder", payer: "payer_gulf", deny: "DOC-001", code: "97140", comment: "Please provide the physiotherapy plan of care and session notes.", settledDaysAgo: 16 },
    { key: "physio-knee-oa", payer: "payer_saffron", side: "left", deny: "OTHR-999", code: "97110", comment: "Frequency of physiotherapy sessions exceeds policy without documented functional improvement.", settledDaysAgo: 11 },
  ];
  const denialClaims: Claim[] = [];
  for (const d of denialPlan) {
    const base = noteBy(d.key);
    const side = d.side ?? "right";
    const patient = d.expired
      ? (patients.find((p) => p.payerId === d.payer && p.coverageEnd < today && age(p) >= 18 && !denialClaims.some((c) => c.patientId === p.id)) as Patient)
      : pickPatient((p) => p.payerId === d.payer);
    const serviceDate = d.lateService ? daysAgo(payerById(d.payer).submissionWindowDays + 12) : d.expired ? "2026-07-14" : daysAgo(Math.min(d.settledDaysAgo + r.int(15, 30), payerById(d.payer).submissionWindowDays - 5));
    const enc = makeEncounter(base, patient, serviceDate, side);
    const claim = makeClaim(enc, patient, base.gold(side), { seed: { denial: d.deny } });
    if (d.only) claim.activities = claim.activities.filter((a) => a.code === d.only);
    if (!d.noAuth) attachAuthIfNeeded(claim, patient);
    d.mutate?.(claim);
    recalcTotals(claim, patient);
    const scripted: GatewayScript = { id: claim.id, activities: {}, comment: d.comment, hold: true, settledDaysAgo: d.settledDaysAgo };
    if (d.code) scripted.activities[d.code] = { denialCode: d.deny };
    if (d.deny === "OTHR-999" || d.deny === "DOC-001") scripted.comment = d.comment;
    scripts.push(scripted);
    denialClaims.push(claim);
    heldBatch.push(claim);
  }
  for (let i = 0; i < 30; i++) {
    const base = BASE_NOTES[(i * 7) % 19];
    const side: Side = base.sided && i % 2 ? "left" : "right";
    const patient = pickPatient(() => true);
    const settledDaysAgo = r.int(1, 12);
    const enc = makeEncounter(base, patient, daysAgo(settledDaysAgo + r.int(14, 40)), side);
    const claim = makeClaim(enc, patient, base.gold(side), i < 5 ? { seed: { underpay: true } } : {});
    attachAuthIfNeeded(claim, patient);
    recalcTotals(claim, patient);
    const script: GatewayScript = { id: claim.id, activities: {}, hold: true, settledDaysAgo };
    if (i < 5) script.activities[claim.activities[0].code] = { payFraction: [0.8, 0.85, 0.9, 0.75, 0.88][i] };
    scripts.push(script);
    heldBatch.push(claim);
  }

  // 6. Recently paid claims outside the gateway (practice history before go-live).
  const remaining = 200 - encounters.length;
  for (let i = 0; i < remaining; i++) {
    const base = BASE_NOTES[i % 19];
    const patient = pickPatient(() => true);
    const side: Side = base.sided && i % 2 ? "left" : "right";
    const enc = makeEncounter(base, patient, daysAgo(r.int(20, 60)), side);
    const claim = makeClaim(enc, patient, base.gold(side));
    attachAuthIfNeeded(claim, patient);
    recalcTotals(claim, patient);
    const submittedAt = addDays(enc.date, 2).toISOString();
    const paidAt = addDays(submittedAt, payerById(claim.payerId).paymentLagDays - r.int(0, 20)).toISOString();
    if (paidAt > new Date().toISOString()) {
      Object.assign(claim, { status: "acknowledged", submittedAt, approvedBy: "u_aisha", approvedAt: submittedAt });
    } else {
      Object.assign(claim, { status: "paid", submittedAt, paidAt, paidAmount: claim.net, firstPass: true, approvedBy: "u_aisha", approvedAt: submittedAt });
      for (const a of claim.activities) a.paid = a.net;
    }
    claim.timeline.push({ status: "submitted", at: submittedAt, by: "u_aisha" }, { status: claim.status, at: claim.paidAt ?? submittedAt });
  }

  // ------------------------------------------------------------------ Historical claims (12 months)
  const hist = historical(options.historical ?? 2000, patients, today, r);

  // Scrub the drafts in memory so the queue opens with scores computed (one bulk write, not N round trips).
  for (const claim of [...errorClaims, ...controls]) {
    const patient = patients.find((p) => p.id === claim.patientId) as Patient;
    const result = scrubClaim(claim, {
      patient,
      priorAuths: priorAuths.filter((p) => p.patientId === claim.patientId),
      otherClaims: claims.filter((c) => c.patientId === claim.patientId && c.id !== claim.id),
      today,
      xml: platform.claimXml(claim, patient),
    });
    Object.assign(claim, { issues: result.issues, cleanClaimScore: result.score, denialRisk: result.denialRisk, status: result.issues.some((i) => i.severity === "blocking") ? "draft" : "scrubbed" });
  }
  await store.putMany(org, "prior_auths", priorAuths);
  await gatewayAdmin("/admin/prior-approvals", gatewayPriors);
  await gatewayAdmin("/admin/scripts", scripts);
  await store.putMany(org, "encounters", encounters);
  await store.putMany(org, "claims", claims);
  await store.putMany(org, "claims", hist.claims);
  await store.putMany(org, "denials", hist.denials);
  await store.putMany(org, "remittance_lines", hist.lines);


  // Send the held batch through the gateway exactly as a pre-go-live PMS would have.
  for (const [payerId, batch] of Map.groupBy(heldBatch, (c) => c.payerId)) {
    const payer = payerById(payerId);
    const xml = buildClaimSubmission(platform.senderId, payer.regulatorPayerId, batch.map((claim) => {
      const patient = patients.find((p) => p.id === claim.patientId) as Patient;
      return { claim, memberId: patient.memberId, emiratesId: platform.emiratesId(patient), payerRegulatorId: payer.regulatorPayerId, facilityLicence: ORGANIZATION.facilityLicence };
    }));
    const res = await platform.gateway.submitClaims(platform.senderId, xml);
    if (res.status !== "acknowledged") throw new Error(`Seed submission rejected: ${JSON.stringify(res.errors?.slice(0, 3))}`);
    for (const claim of batch) {
      const script = scripts.find((s) => s.id === claim.id);
      const submittedAt = addDays(today, -((script?.settledDaysAgo ?? 5) + r.int(20, 35))).toISOString();
      Object.assign(claim, { status: "acknowledged", submittedAt, approvedBy: "u_aisha", approvedAt: submittedAt, submissionId: "sub_legacy" });
      claim.timeline.push({ status: "submitted", at: submittedAt, by: "u_aisha" }, { status: "acknowledged", at: submittedAt, note: `Payer claim ID ${res.claims?.find((c) => c.id === claim.id)?.idPayer}` });
    }
    await store.putMany(org, "claims", batch);
  }
  if (options.releaseRemittances) {
    await gatewayAdmin("/admin/release", {});
    await platform.pollRemittances();
  }
  await platform.audit.record(org, { id: "system", role: "system" }, "demo.reset", "organization", org, undefined, { encounters: encounters.length, historical: hist.claims.length });

  return {
    patients: patients.length,
    encounters: encounters.length,
    seededErrorClaims: errorClaims.length,
    controlClaims: controls.length,
    seededDenials: denialPlan.length,
    seededUnderpayments: 5,
    historicalClaims: hist.claims.length,
    demoEncounterId: demo.id,
  };
}

/** Twelve months of adjudicated history, including a recent rise in Nahr physiotherapy auth denials. */
function historical(count: number, patients: Patient[], today: string, r: ReturnType<typeof rng>) {
  const claims: Claim[] = [];
  const denials: Denial[] = [];
  const lines: RemittanceLine[] = [];
  const underpayRate: Record<string, number> = { payer_nahr: 0.03, payer_saffron: 0.09, payer_gulf: 0.015 };
  const baseDeny: Record<string, number> = { payer_nahr: 0.08, payer_saffron: 0.11, payer_gulf: 0.05 };
  const categoryCodes: Record<string, string[]> = {
    auth: ["AUTH-001", "AUTH-003"],
    medical_necessity: ["MNEC-003", "MNEC-005"],
    coding: ["CODE-010", "CODE-014", "CODE-020"],
    pricing: ["PRCE-001", "PRCE-010"],
    eligibility: ["ELIG-001", "ELIG-005"],
    duplicate: ["DUPL-001"],
    timeliness: ["TIME-001"],
    documentation: ["DOC-001"],
  };
  const catWeights: [string, number][] = [["auth", 0.26], ["medical_necessity", 0.2], ["coding", 0.18], ["pricing", 0.12], ["eligibility", 0.1], ["documentation", 0.08], ["duplicate", 0.04], ["timeliness", 0.02]];
  const pickCat = () => {
    let x = r.next();
    for (const [c, w] of catWeights) if ((x -= w) <= 0) return c;
    return "auth";
  };
  for (let i = 0; i < count; i++) {
    const base = BASE_NOTES[r.int(0, 18)];
    const side: Side = base.sided && r.chance(0.5) ? "left" : "right";
    const codes = base.gold(side);
    const patient = patients[r.int(0, patients.length - 1)];
    const payer = payerById(patient.payerId);
    const clinician = clinicianById(r.pick(SPECIALTY_CLINICIANS[base.specialty]));
    const serviceAge = r.int(45, 365);
    const serviceDate = isoDate(addDays(today, -serviceAge));
    const submittedAt = addDays(serviceDate, r.int(1, 6));
    const lag = Math.max(10, Math.round(payer.paymentLagDays + (r.next() - 0.5) * 24));
    const paidAt = addDays(submittedAt, lag);
    const settled = paidAt > new Date(today) ? addDays(today, -1) : paidAt;
    const id = `clm_h${String(i + 1).padStart(5, "0")}`;
    const activities: Activity[] = codes.procedures.map((code, j) => {
      const gross = contractPrice(payer.id, code);
      return { id: `act_h${i + 1}_${j + 1}`, codeType: (lookupCode(code)?.type ?? "CPT") as Activity["codeType"], code, description: lookupCode(code)?.description ?? code, quantity: 1, gross, patientShare: 0, net: gross };
    });
    const claim: Claim = {
      id,
      patientId: patient.id,
      payerId: payer.id,
      payerName: payer.name,
      clinicianId: clinician.id,
      clinicianName: clinician.name,
      clinicianLicence: clinician.licence,
      specialty: base.specialty,
      encounterType: "outpatient",
      serviceDate,
      status: "paid",
      diagnoses: [{ code: codes.principal, type: "principal", description: lookupCode(codes.principal)?.description ?? "" }],
      activities,
      gross: 0,
      patientShare: 0,
      net: 0,
      submittedAt: submittedAt.toISOString(),
      historical: true,
      timeline: [{ status: "paid", at: settled.toISOString(), note: "Historical import" }],
    };
    recalcTotals(claim, patient);
    // Recent spike: Nahr now enforces auth on physiotherapy more strictly (last ~30 days of settlement).
    const recent = (new Date(today).getTime() - settled.getTime()) / 86_400_000 <= 30;
    const nahrPhysioSpike = payer.id === "payer_nahr" && base.specialty === "Physiotherapy" && recent;
    let firstPass = true;
    for (const a of claim.activities) {
      const deny = nahrPhysioSpike ? r.chance(0.45) : r.chance(baseDeny[payer.id] / Math.max(1, claim.activities.length * 0.7));
      let paid = a.net;
      let denialCode: string | undefined;
      if (deny) {
        const cat = nahrPhysioSpike && r.chance(0.8) ? "auth" : pickCat();
        denialCode = r.pick(categoryCodes[cat]);
        paid = 0;
        firstPass = false;
        const info = DENIAL_INDEX.get(denialCode);
        const deniedAt = isoDate(settled);
        const deadline = isoDate(addDays(deniedAt, payer.resubmissionWindowDays));
        const worked = r.chance(0.7);
        const recovered = worked && r.chance(info?.baseRecovery ?? 0.4);
        const status: Denial["status"] = deadline >= today && !worked ? "open" : recovered ? "recovered" : worked ? "lost" : "written_off";
        if (status === "open") {
          // Old open items are closed out as written off so the live worklist is the demo set.
          denials.push(histDenial("written_off"));
        } else denials.push(histDenial(status));
        function histDenial(st: Denial["status"]): Denial {
          return {
            id: `den_${id}_${a.id}`,
            claimId: id,
            activityId: a.id,
            activityCode: a.code,
            payerId: payer.id,
            payerName: payer.name,
            clinicianName: clinician.name,
            specialty: base.specialty,
            code: denialCode as string,
            plainReason: info?.plain ?? "",
            category: info?.category ?? "documentation",
            classifiedBy: "lookup",
            amount: a.net,
            recoveryProbability: info?.baseRecovery ?? 0.4,
            recoveryBand: (info?.baseRecovery ?? 0.4) >= 0.6 ? "High" : (info?.baseRecovery ?? 0.4) >= 0.35 ? "Medium" : "Low",
            priorityScore: 0,
            deniedAt,
            deadline,
            status: st,
            recoveredAmount: st === "recovered" ? a.net : 0,
            writeOffReason: st === "written_off" ? "Historical: not worked before deadline" : undefined,
            historical: true,
          };
        }
      } else if (r.chance(underpayRate[payer.id])) {
        paid = round2(a.net * (0.82 + r.next() * 0.12));
        firstPass = false;
      }
      a.paid = paid;
      a.denialCode = denialCode;
      const variance = round2(a.net - paid);
      lines.push({
        id: `ra_h${i + 1}_${a.id}`,
        remittanceId: `ra_hist_${isoDate(settled).slice(0, 7)}_${payer.id}`,
        claimId: id,
        activityId: a.id,
        activityCode: a.code,
        payerId: payer.id,
        payerName: payer.name,
        expected: a.net,
        paid,
        variance,
        denialCode,
        paymentReference: `PAY-${payer.regulatorPayerId}-${isoDate(settled).replaceAll("-", "")}`,
        settledAt: settled.toISOString(),
        status: denialCode ? "denied" : variance > 5 ? "underpaid" : "paid",
        matched: true,
      });
    }
    claim.paidAmount = round2(claim.activities.reduce((s, a) => s + (a.paid ?? 0), 0));
    claim.firstPass = firstPass;
    claim.paidAt = settled.toISOString();
    claim.status = claim.activities.every((a) => (a.paid ?? 0) >= a.net - 5) ? "paid" : claim.paidAmount > 0 ? "partially_paid" : "denied";
    claims.push(claim);
  }
  return { claims, denials, lines };
}
