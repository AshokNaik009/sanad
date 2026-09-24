// Reference configuration. Payers and clinicians are fictional; denial codes are the official
// DOH list imported by `npm run import-ref` (see ref-import.ts), with Sanad's plain-language notes.
import type {
  Clinician,
  DenialCategory,
  Organization,
  Payer,
  Specialty,
  User,
} from "../domain/types.ts";
import { refDenialCodes } from "./ref-data.ts";

export const ORG_ID = "org_demo";

export const ORGANIZATION: Organization = {
  id: ORG_ID,
  name: "Al Waha Demo Medical Centre",
  emirate: "Dubai",
  regulator: "DHA",
  facilityLicence: "DHA-F-DEMO-0001",
};

export const CLINICIANS: Clinician[] = [
  { id: "cl_1", name: "Dr. Fatima Al Suwaidi", licence: "DHA-P-DEMO-1001", specialty: "GP" },
  { id: "cl_2", name: "Dr. Arjun Menon", licence: "DHA-P-DEMO-1002", specialty: "GP" },
  { id: "cl_3", name: "Layla Haddad, PT", licence: "DHA-P-DEMO-1003", specialty: "Physiotherapy" },
  { id: "cl_4", name: "Omar Siddiqui, PT", licence: "DHA-P-DEMO-1004", specialty: "Physiotherapy" },
  { id: "cl_5", name: "Dr. Mariam Khoury", licence: "DHA-P-DEMO-1005", specialty: "Dermatology" },
  { id: "cl_6", name: "Dr. Samuel Okafor", licence: "DHA-P-DEMO-1006", specialty: "Orthopaedics" },
  { id: "cl_7", name: "Dr. Hana Yousef", licence: "DHA-P-DEMO-1007", specialty: "Orthopaedics" },
  { id: "cl_8", name: "Dr. Priya Raman", licence: "DHA-P-DEMO-1008", specialty: "Lab" },
];

export const USERS: User[] = [
  { id: "u_aisha", orgId: ORG_ID, name: "Aisha (Billing)", role: "biller" },
  { id: "u_rahul", orgId: ORG_ID, name: "Rahul (Claims coder)", role: "coder" },
  { id: "u_fatima", orgId: ORG_ID, name: "Dr. Fatima", role: "doctor", clinicianId: "cl_1" },
  { id: "u_omar", orgId: ORG_ID, name: "Omar (Finance)", role: "finance" },
  { id: "u_noor", orgId: ORG_ID, name: "Noor (Front desk)", role: "frontdesk" },
  { id: "u_admin", orgId: ORG_ID, name: "Admin", role: "admin" },
];

const plans = [
  { name: "Basic", network: "Restricted", copayPercent: 20, copayCapPerVisit: 100, annualLimit: 150000, deductible: 0 },
  { name: "Enhanced", network: "General", copayPercent: 10, copayCapPerVisit: 50, annualLimit: 500000, deductible: 0 },
  { name: "Premium", network: "Comprehensive", copayPercent: 0, copayCapPerVisit: 0, annualLimit: 2000000, deductible: 0 },
];

export const PAYERS: Payer[] = [
  {
    id: "payer_nahr",
    name: "Nahr Health Insurance",
    regulatorPayerId: "A001-DEMO",
    submissionWindowDays: 90,
    resubmissionWindowDays: 60,
    paymentLagDays: 38,
    authRequired: ["97*", "G0283", "73721", "20610"],
    plans,
    priceFactor: 1.0,
  },
  {
    id: "payer_saffron",
    name: "Saffron TPA",
    regulatorPayerId: "T002-DEMO",
    submissionWindowDays: 60,
    resubmissionWindowDays: 30,
    paymentLagDays: 52,
    authRequired: ["73721", "20610", "11102"],
    plans,
    priceFactor: 1.05,
  },
  {
    id: "payer_gulf",
    name: "Gulf Crescent Assurance",
    regulatorPayerId: "A003-DEMO",
    submissionWindowDays: 90,
    resubmissionWindowDays: 45,
    paymentLagDays: 28,
    authRequired: ["73721"],
    plans,
    priceFactor: 1.1,
  },
];

/** Contract prices that sit below the facility chargemaster (payer-negotiated discounts). */
export const PRICE_OVERRIDES: Record<string, Record<string, number>> = {
  payer_nahr: { "97110": 150, "73721": 2100, "99214": 320 },
  payer_saffron: { "99214": 320, "97140": 185 },
  payer_gulf: {},
};

export interface DenialCodeConfig {
  code: string;
  text: string;
  plain: string;
  category: DenialCategory;
  baseRecovery: number;
}

/** Root-cause category for each DOH denial type; codes below override where the action differs. */
const TYPE_CATEGORY: Record<string, DenialCategory> = {
  Eligibility: "eligibility",
  Authorization: "auth",
  "Administrative information": "documentation",
  "Benefit expiration": "eligibility",
  "Clinical information": "coding",
  Duplicate: "duplicate",
  "Medical Necessity": "medical_necessity",
  "Non-coverage": "eligibility",
  Price: "pricing",
  "Timely filing": "timeliness",
  "Take-back": "pricing",
  "Pay-back": "pricing",
  Copay: "pricing",
};

/** Sanad's plain-language reading of each official code (the official wording is kept in `text`). */
const GUIDE: Record<string, { plain: string; category?: DenialCategory }> = {
  "AUTH-001": { plain: "The insurer needed to approve this service before it was done, and no approval number was on the claim." },
  "AUTH-003": { plain: "The approval number on the claim is not valid for this patient or service." },
  "AUTH-004": { plain: "The service was done outside the dates the approval covers." },
  "AUTH-005": { plain: "What was billed does not match what the insurer approved." },
  "AUTH-006": { plain: "The insurer flagged a dangerous drug combination.", category: "medical_necessity" },
  "AUTH-007": { plain: "The insurer thinks this drug duplicates another therapy the patient is on.", category: "medical_necessity" },
  "AUTH-008": { plain: "The insurer thinks the drug dose is not appropriate.", category: "medical_necessity" },
  "AUTH-009": { plain: "The prescription had expired when it was dispensed." },
  "AUTH-010": { plain: "This overlaps with another claim or approval that was already paid.", category: "duplicate" },
  "AUTH-011": { plain: "The patient is still in the policy's waiting period for this condition." },
  "BENX-002": { plain: "The patient has used up this benefit for the period." },
  "BENX-005": { plain: "The patient's annual limit or sub-limit has been reached." },
  "CLAI-008": { plain: "This visit overlaps an inpatient stay; only services outside the stay can be billed." },
  "CLAI-009": { plain: "The date of birth on the claim is after the visit date.", category: "coding" },
  "CLAI-010": { plain: "The claim shows a date of death before the visit date.", category: "coding" },
  "CLAI-012": { plain: "The insurer says the claim does not follow the contract; the reason is in their comment." },
  "CLAI-014": { plain: "The resubmission type does not fit what was changed." },
  "CLAI-015": { plain: "Service codes are missing from an inpatient (DRG) claim.", category: "coding" },
  "CLAI-016": { plain: "The claim was billed under the wrong billing regime." },
  "CLAI-017": { plain: "This service is not available on direct billing with this insurer." },
  "CLAI-018": { plain: "The claim was recalled by the clinic." },
  "CODE-010": { plain: "The service or diagnosis does not fit the treating clinician's specialty." },
  "CODE-011": { plain: "The inpatient grouping (DRG) on the claim was calculated incorrectly." },
  "CODE-012": { plain: "The visit type does not fit the services or diagnosis billed." },
  "CODE-013": { plain: "The main diagnosis code is not valid as a principal diagnosis (it may be retired or too vague)." },
  "CODE-014": { plain: "A code on the claim does not fit the patient's age or gender." },
  "CODE-015": { plain: "The service or diagnosis does not fit this type of facility." },
  "COPY-001": { plain: "The co-pay or deductible was not collected from the patient." },
  "DUPL-001": { plain: "The insurer already received this same service for this patient and date." },
  "DUPL-002": { plain: "The insurer already paid for the same or a similar service recently." },
  "ELIG-001": { plain: "The patient's insurance was not active on the visit date." },
  "ELIG-005": { plain: "The visit was after the patient's cover ended." },
  "ELIG-006": { plain: "The visit was before the patient's cover started." },
  "ELIG-007": { plain: "The patient's plan does not include this clinic's network." },
  "MNEC-003": { plain: "The insurer thinks the service was not medically necessary from what was sent." },
  "MNEC-004": { plain: "The insurer needs a supporting diagnosis or more clinical information to accept this service.", category: "coding" },
  "MNEC-005": { plain: "The insurer thinks this service was repeated too often." },
  "MNEC-006": { plain: "The insurer thinks a different service should have been used first." },
  "NCOV-001": { plain: "The patient's plan does not cover this diagnosis." },
  "NCOV-002": { plain: "Pre-existing conditions are not covered by the patient's plan." },
  "NCOV-0026": { plain: "The drug is not on the plan's formulary." },
  "NCOV-003": { plain: "The patient's plan does not cover this service." },
  "NCOV-025": { plain: "An audit found the service was not performed." },
  "PRCE-001": { plain: "The amount billed does not match the agreed price." },
  "PRCE-002": { plain: "This service is already paid as part of another service." },
  "PRCE-003": { plain: "The insurer is recovering an earlier payment." },
  "PRCE-006": { plain: "This consultation falls within the free follow-up period." },
  "PRCE-007": { plain: "There is no contract price for this service with this insurer." },
  "PRCE-008": { plain: "Multiple-procedure pricing rules were not applied correctly." },
  "PRCE-010": { plain: "These services should be billed with a single bundled code." },
  "PYBK-003": { plain: "A co-pay is being paid back or reversed." },
  "TIME-001": { plain: "The claim reached the insurer after the deadline." },
  "TIME-002": { plain: "Information the insurer asked for was not sent in time.", category: "documentation" },
  "TIME-003": { plain: "The appeal was not made in the right way or in time." },
  "TKBK-001": { plain: "The insurer took back a payment to correct it." },
  "TKBK-002": { plain: "The insurer took back a payment after an audit." },
  "TKBK-003": { plain: "The insurer took back co-payments." },
};

/** Codes whose real reason is in the payer's free-text comment, so the comment decides the category. */
export const COMMENT_DRIVEN_CODES = new Set(["CLAI-012", "MNEC-004"]);

const BASE_RECOVERY: Record<DenialCategory, number> = {
  auth: 0.55,
  eligibility: 0.25,
  coding: 0.7,
  medical_necessity: 0.6,
  pricing: 0.3,
  duplicate: 0.15,
  timeliness: 0.1,
  documentation: 0.65,
};

function buildDenialCodes(): DenialCodeConfig[] {
  return refDenialCodes().map((d) => {
    const guide = GUIDE[d.code];
    const category = guide?.category ?? TYPE_CATEGORY[d.type] ?? "documentation";
    return { code: d.code, text: d.text, plain: guide?.plain ?? d.text, category, baseRecovery: BASE_RECOVERY[category] };
  });
}

export const DENIAL_CODES: DenialCodeConfig[] = buildDenialCodes();

export const DENIAL_INDEX = new Map(DENIAL_CODES.map((d) => [d.code, d]));

/** Re-reads the imported list in place (Regulator Watch), keeping existing references valid. */
export function rebuildDenialCodes(): void {
  DENIAL_CODES.splice(0, DENIAL_CODES.length, ...buildDenialCodes());
  DENIAL_INDEX.clear();
  for (const d of DENIAL_CODES) DENIAL_INDEX.set(d.code, d);
}

export const CATEGORY_LABEL: Record<DenialCategory, string> = {
  auth: "Authorisation",
  eligibility: "Eligibility",
  coding: "Billing codes",
  medical_necessity: "Medical necessity",
  pricing: "Pricing",
  duplicate: "Duplicate",
  timeliness: "Timeliness",
  documentation: "Documentation",
};

export const SPECIALTY_CLINICIANS: Record<Specialty, string[]> = {
  GP: ["cl_1", "cl_2"],
  Physiotherapy: ["cl_3", "cl_4"],
  Dermatology: ["cl_5"],
  Orthopaedics: ["cl_6", "cl_7"],
  Lab: ["cl_8"],
};

export function payerById(id: string): Payer {
  const payer = PAYERS.find((p) => p.id === id);
  if (!payer) throw new Error(`Unknown payer ${id}`);
  return payer;
}

export function clinicianById(id: string): Clinician {
  const clinician = CLINICIANS.find((c) => c.id === id);
  if (!clinician) throw new Error(`Unknown clinician ${id}`);
  return clinician;
}

export function authRequired(payer: Payer, code: string): boolean {
  return payer.authRequired.some((rule) =>
    rule.endsWith("*") ? code.startsWith(rule.slice(0, -1)) : rule === code,
  );
}
