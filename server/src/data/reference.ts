// Reference configuration. Payers are fictional; denial codes follow the shape of the
// regulator lists but must be replaced with the current published DHA/DOH lists before a pilot.
import type {
  Clinician,
  DenialCategory,
  Organization,
  Payer,
  Specialty,
  User,
} from "../domain/types.ts";

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
  { id: "u_rahul", orgId: ORG_ID, name: "Rahul (Coder)", role: "coder" },
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

export const DENIAL_CODES: DenialCodeConfig[] = [
  { code: "AUTH-001", text: "Prior approval is required and was not obtained", plain: "The insurer needed to approve this service before it was done, and no approval number was on the claim.", category: "auth", baseRecovery: 0.55 },
  { code: "AUTH-003", text: "Activity not covered by the prior approval", plain: "An approval exists, but it does not cover this exact service.", category: "auth", baseRecovery: 0.5 },
  { code: "ELIG-001", text: "Patient is not a covered member on the date of service", plain: "The patient's insurance was not active on the visit date.", category: "eligibility", baseRecovery: 0.25 },
  { code: "ELIG-005", text: "Service provided outside the member's network", plain: "The patient's plan does not include this clinic's network.", category: "eligibility", baseRecovery: 0.2 },
  { code: "CODE-010", text: "Activity/diagnosis inconsistent", plain: "The diagnosis on the claim does not support the service billed.", category: "coding", baseRecovery: 0.7 },
  { code: "CODE-014", text: "Activity/diagnosis inconsistent with patient age/gender", plain: "A code on the claim does not fit the patient's age or gender.", category: "coding", baseRecovery: 0.75 },
  { code: "CODE-020", text: "Invalid or inactive code", plain: "A code on the claim is not valid or has been retired.", category: "coding", baseRecovery: 0.85 },
  { code: "MNEC-003", text: "Service is not clinically indicated based on good clinical practice", plain: "The insurer thinks the service was not medically necessary from what was sent.", category: "medical_necessity", baseRecovery: 0.6 },
  { code: "MNEC-005", text: "Service/supply may be appropriate, but too frequent", plain: "The insurer thinks this service was repeated too often.", category: "medical_necessity", baseRecovery: 0.45 },
  { code: "PRCE-001", text: "Payment is included in the allowed amount / price exceeds agreed tariff", plain: "The amount billed was above the price agreed with the insurer.", category: "pricing", baseRecovery: 0.3 },
  { code: "PRCE-010", text: "Unbundling: activity included in another billed activity", plain: "This service is considered part of another service on the same claim.", category: "pricing", baseRecovery: 0.35 },
  { code: "DUPL-001", text: "Duplicate of a previously submitted claim or activity", plain: "The insurer already received this same service for this patient and date.", category: "duplicate", baseRecovery: 0.15 },
  { code: "TIME-001", text: "Submission or resubmission after the contractual time limit", plain: "The claim reached the insurer after the deadline.", category: "timeliness", baseRecovery: 0.1 },
  { code: "DOC-001", text: "Insufficient documentation / clinical information requested", plain: "The insurer wants more clinical information before paying.", category: "documentation", baseRecovery: 0.65 },
  { code: "OTHR-999", text: "Other - see payer comment", plain: "The insurer gave a free-text reason; see the comment.", category: "documentation", baseRecovery: 0.4 },
];

export const DENIAL_INDEX = new Map(DENIAL_CODES.map((d) => [d.code, d]));

export const CATEGORY_LABEL: Record<DenialCategory, string> = {
  auth: "Authorisation",
  eligibility: "Eligibility",
  coding: "Coding",
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
