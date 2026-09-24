// Demo code set: a small, real subset of ICD-10-CM, CPT and HCPCS; drug codes come from the
// imported DOH drug list. `patterns` drive the offline (sample) coding engine; every
// suggestion from any engine is filtered against this table (PRD M2.2).
import type { CodeType } from "../domain/types.ts";
import { drugLabel, refDrug } from "./ref-data.ts";

export interface CodeEntry {
  code: string;
  type: CodeType;
  description: string;
  plain: string;
  active: boolean;
  patterns?: RegExp[];
  gender?: "M" | "F";
  minAge?: number;
  maxAge?: number;
  /** Less specific codes this code replaces when both are found. */
  supersedes?: string[];
  /** Base chargemaster tariff in AED (procedures only). */
  tariff?: number;
  /** ICD-10 prefixes that establish medical necessity; empty means any diagnosis. */
  supportedBy?: string[];
}

const icd = (
  code: string,
  description: string,
  plain: string,
  patterns: RegExp[],
  extra: Partial<CodeEntry> = {},
): CodeEntry => ({ code, type: "ICD10", description, plain, active: true, patterns, ...extra });

const cpt = (
  code: string,
  description: string,
  plain: string,
  tariff: number,
  patterns: RegExp[],
  supportedBy: string[] = [],
  extra: Partial<CodeEntry> = {},
): CodeEntry => ({
  code,
  type: "CPT",
  description,
  plain,
  active: true,
  patterns,
  tariff,
  supportedBy,
  ...extra,
});

/** A DOH drug code with its description taken from the imported list. */
const drug = (code: string, plain: string, patterns: RegExp[], fallbackTariff: number): CodeEntry => {
  const d = refDrug(code);
  return { code, type: "DRUG", description: d ? drugLabel(d) : code, plain, active: true, patterns, tariff: d?.unitPrice ?? fallbackTariff, supportedBy: [] };
};

const MSK = ["M", "S"];

export const CODES: CodeEntry[] = [
  // Diagnoses
  icd("J06.9", "Acute upper respiratory infection, unspecified", "Common cold / throat infection", [/upper respiratory (tract )?infection/i, /\bURTI\b/]),
  icd("J02.9", "Acute pharyngitis, unspecified", "Sore throat infection", [/pharyngitis/i]),
  icd("J20.9", "Acute bronchitis, unspecified", "Chest cold (bronchitis)", [/acute bronchitis/i]),
  icd("J45.909", "Unspecified asthma, uncomplicated", "Asthma", [/\basthma\b/i]),
  icd("I10", "Essential (primary) hypertension", "High blood pressure", [/\bhypertension\b/i]),
  icd("E11.9", "Type 2 diabetes mellitus without complications", "Type 2 diabetes", [/type 2 diabetes/i, /\bT2DM\b/]),
  icd("E11.65", "Type 2 diabetes mellitus with hyperglycemia", "Type 2 diabetes with high sugar", [/type 2 diabetes[^.]*(hyperglyc|poorly controlled|uncontrolled)/i], { supersedes: ["E11.9"] }),
  icd("R73.03", "Prediabetes", "Prediabetes", [/prediabetes/i]),
  icd("E78.5", "Hyperlipidemia, unspecified", "High cholesterol", [/hyperlipid/i, /dyslipid/i]),
  icd("E55.9", "Vitamin D deficiency, unspecified", "Low vitamin D", [/vitamin d deficiency/i]),
  icd("K21.9", "Gastro-esophageal reflux disease without esophagitis", "Acid reflux", [/\bGERD\b/, /gastro-?o?esophageal reflux/i]),
  icd("N39.0", "Urinary tract infection, site not specified", "Urine infection", [/urinary tract infection/i, /\bUTI\b/]),
  icd("R51.9", "Headache, unspecified", "Headache", [/tension-type headache|headache/i]),
  icd("M54.50", "Low back pain, unspecified", "Lower back pain", [/low(er)? back pain/i, /lumbago/i]),
  icd("M54.5", "Low back pain (deleted code, replaced by M54.50)", "Lower back pain", [], { active: false }),
  icd("M54.2", "Cervicalgia", "Neck pain", [/neck pain/i, /cervicalgia/i]),
  icd("M25.569", "Pain in unspecified knee", "Knee pain", [/knee pain/i, /pain in the knee/i]),
  icd("M25.561", "Pain in right knee", "Right knee pain", [/right knee pain/i, /pain in the right knee/i], { supersedes: ["M25.569"] }),
  icd("M25.562", "Pain in left knee", "Left knee pain", [/left knee pain/i, /pain in the left knee/i], { supersedes: ["M25.569"] }),
  icd("M17.11", "Unilateral primary osteoarthritis, right knee", "Right knee arthritis", [/osteoarthritis of the right knee/i, /right knee osteoarthritis/i], { supersedes: ["M25.561", "M25.569"] }),
  icd("M17.12", "Unilateral primary osteoarthritis, left knee", "Left knee arthritis", [/osteoarthritis of the left knee/i, /left knee osteoarthritis/i], { supersedes: ["M25.562", "M25.569"] }),
  icd("S83.241A", "Other tear of medial meniscus, current injury, right knee, initial encounter", "Right knee cartilage tear", [/medial meniscus tear[^.]*right|right[^.]*medial meniscus tear/i], { supersedes: ["M25.561", "M25.569"] }),
  icd("S83.242A", "Other tear of medial meniscus, current injury, left knee, initial encounter", "Left knee cartilage tear", [/medial meniscus tear[^.]*left|left[^.]*medial meniscus tear/i], { supersedes: ["M25.562", "M25.569"] }),
  icd("M75.41", "Impingement syndrome of right shoulder", "Right shoulder impingement", [/right shoulder impingement|impingement[^.]*right shoulder/i]),
  icd("M75.42", "Impingement syndrome of left shoulder", "Left shoulder impingement", [/left shoulder impingement|impingement[^.]*left shoulder/i]),
  icd("S93.401A", "Sprain of unspecified ligament of right ankle, initial encounter", "Right ankle sprain", [/right ankle sprain|sprain(ed)? (of )?the right ankle|inversion injury[^.]*right ankle/i]),
  icd("S93.402A", "Sprain of unspecified ligament of left ankle, initial encounter", "Left ankle sprain", [/left ankle sprain|sprain(ed)? (of )?the left ankle|inversion injury[^.]*left ankle/i]),
  icd("L70.0", "Acne vulgaris", "Acne", [/\bacne\b/i]),
  icd("L20.9", "Atopic dermatitis, unspecified", "Eczema", [/atopic dermatitis/i, /\beczema\b/i]),
  icd("L40.0", "Psoriasis vulgaris", "Psoriasis", [/psoriasis/i]),
  icd("B35.1", "Tinea unguium", "Fungal nail infection", [/onychomycosis/i, /fungal nail/i]),
  icd("L82.1", "Other seborrheic keratosis", "Benign skin growth", [/seborrh?o?eic keratos[ie]s/i]),
  icd("D22.5", "Melanocytic nevi of trunk", "Mole on the trunk", [/(atypical|changing|pigmented) (mole|na?ev[ui]s)[^.]*(back|trunk|chest)/i]),
  icd("Z00.00", "Encounter for general adult medical examination without abnormal findings", "Routine adult check-up", [/annual (health )?check|routine (health|medical) (check|exam)/i], { minAge: 18 }),
  icd("Z01.419", "Encounter for gynecological examination without abnormal findings", "Routine women's health exam", [/gyn(a)?ecological exam/i], { gender: "F" }),
  icd("N40.0", "Benign prostatic hyperplasia without lower urinary tract symptoms", "Enlarged prostate", [/benign prostatic hyperplasia|\bBPH\b/i], { gender: "M" }),
  icd("Z23", "Encounter for immunization", "Vaccination visit", [/influenza vaccin|flu (shot|vaccin)/i]),

  // Evaluation and management
  cpt("99203", "Office visit, new patient, low complexity", "New patient consultation", 300, [/new patient/i]),
  cpt("99212", "Office visit, established patient, straightforward", "Short follow-up consultation", 180, [/brief follow-up|medication refill/i]),
  cpt("99213", "Office visit, established patient, low complexity", "Follow-up consultation", 250, [/follow-up (visit|consultation|review)|returns for review/i]),
  cpt("99214", "Office visit, established patient, moderate complexity", "Detailed follow-up consultation", 350, [/moderate complexity|detailed review of/i]),
  // Physiotherapy
  cpt("97161", "Physical therapy evaluation, low complexity", "Physiotherapy assessment", 300, [/(initial )?physiotherapy (evaluation|assessment)/i], MSK),
  cpt("97110", "Therapeutic exercises, each 15 minutes", "Therapeutic exercise", 180, [/therapeutic exercise|strengthening exercise/i], MSK),
  cpt("97140", "Manual therapy techniques, each 15 minutes", "Manual therapy", 200, [/manual therapy|joint mobili[sz]ation/i], MSK),
  cpt("97530", "Therapeutic activities, each 15 minutes", "Functional activities", 190, [/functional (activities|training)/i], MSK),
  { code: "G0283", type: "HCPCS", description: "Electrical stimulation, unattended", plain: "Electrical muscle stimulation (TENS)", active: true, patterns: [/\bTENS\b|electrical stimulation/i], tariff: 90, supportedBy: MSK },
  // Imaging and procedures
  cpt("73721", "MRI any joint of lower extremity without contrast", "Knee MRI scan", 2400, [/MRI (of )?the (right |left )?knee/i], ["M17", "M25.56", "S83", "M23"]),
  cpt("73560", "Radiologic exam, knee, 1 or 2 views", "Knee X-ray", 250, [/knee x-?ray|x-?ray of the (right |left )?knee/i], ["M17", "M25.56", "S83", "S80"]),
  cpt("73030", "Radiologic exam, shoulder, complete", "Shoulder X-ray", 250, [/shoulder x-?ray|x-?ray of the (right |left )?shoulder/i], ["M75", "M25.51", "S4"]),
  cpt("72100", "Radiologic exam, lumbosacral spine, 2 or 3 views", "Lower back X-ray", 280, [/lumbar (spine )?x-?ray|x-?ray of the lumbar/i], ["M54", "S33"]),
  cpt("20610", "Arthrocentesis, aspiration and/or injection, major joint", "Joint injection", 600, [/intra-?articular (steroid )?injection/i], ["M17", "M25.56", "M75"]),
  cpt("29540", "Strapping; ankle and/or foot", "Ankle strapping", 150, [/ankle strapping|strapped the ankle/i], ["S93", "M25.57"]),
  cpt("11102", "Tangential biopsy of skin, single lesion", "Skin biopsy", 450, [/shave biopsy/i], ["D22", "L82", "D48", "L98"]),
  cpt("17110", "Destruction of benign lesions, up to 14", "Freezing of skin lesions", 400, [/cryotherapy/i], ["L82", "B07"]),
  cpt("96372", "Therapeutic injection, subcutaneous or intramuscular", "Injection", 80, [/intramuscular injection|IM injection/i]),
  cpt("90471", "Immunization administration, single vaccine", "Vaccine given", 60, [/influenza vaccin|flu (shot|vaccin)/i], ["Z23"]),
  cpt("93000", "Electrocardiogram with interpretation and report", "Heart tracing (ECG)", 150, [/\bECG\b|electrocardiogram/i], ["I10", "R07", "E11", "Z00"]),
  // Laboratory
  cpt("80053", "Comprehensive metabolic panel", "Blood chemistry panel", 180, [/comprehensive metabolic panel/i, /\bCMP\b/]),
  cpt("83036", "Hemoglobin A1c", "Diabetes blood test (HbA1c)", 120, [/HbA1c/i], ["E11", "R73", "Z00"]),
  cpt("80061", "Lipid panel", "Cholesterol test", 150, [/lipid (panel|profile)/i], ["E78", "E11", "I10", "Z00"]),
  cpt("85025", "Complete blood count with automated differential", "Full blood count", 90, [/\bCBC\b|complete blood count|full blood count/i]),
  cpt("82306", "Vitamin D; 25 hydroxy", "Vitamin D test", 220, [/vitamin d (level|test)/i], ["E55"]),
  cpt("81003", "Urinalysis, automated, without microscopy", "Urine test", 50, [/urinalysis|urine dipstick/i], ["N39", "E11", "R30", "Z00"]),
  cpt("87880", "Rapid streptococcus antigen test", "Rapid strep throat test", 90, [/rapid strep/i], ["J02", "J03", "J06"]),
  cpt("36415", "Collection of venous blood by venipuncture", "Blood draw", 30, [/venipuncture|blood (was )?drawn/i]),
  // Drugs: HCPCS plus two real DOH drug codes (tariff = DOH unit price to public, per unit).
  { code: "J3301", type: "HCPCS", description: "Injection, triamcinolone acetonide, 10 mg", plain: "Steroid injection medicine", active: true, patterns: [/triamcinolone/i], tariff: 45, supportedBy: [] },
  drug("A54-4064-00334-01", "Antibiotic (amoxicillin)", [/amoxicillin/i], 1.18),
  drug("G93-5627-01796-01", "Anti-inflammatory injection", [/diclofenac/i], 4.6),
];

export const CODE_INDEX = new Map(CODES.map((c) => [c.code, c]));

/** Any other DOH drug code resolves from the imported drug list. */
function drugEntry(code: string): CodeEntry | undefined {
  const d = refDrug(code);
  if (!d) return undefined;
  return { code: d.code, type: "DRUG", description: drugLabel(d), plain: `${d.generic} (${d.name})`, active: d.status !== "Deleted", tariff: d.unitPrice, supportedBy: [] };
}

export function lookupCode(code: string): CodeEntry | undefined {
  const key = code.trim().toUpperCase();
  return CODE_INDEX.get(key) ?? drugEntry(key);
}

/** A code is usable only if it exists in the loaded code set and is active. */
export function isValidCode(code: string, type?: CodeType): boolean {
  const entry = lookupCode(code);
  return !!entry && entry.active && (!type || entry.type === type);
}

/** Procedure pairs that must not be billed together in one session (unbundling edits). */
export const EXCLUSIVE_PAIRS: [string, string, string][] = [
  ["97140", "97530", "Manual therapy and therapeutic activities in the same session need a distinct-procedure justification"],
  ["99203", "99213", "New and established patient visits cannot be billed on the same day"],
  ["99213", "99214", "Only one established-patient visit level may be billed per day"],
  ["20610", "96372", "Joint injection already includes the injection administration"],
];

export const ACTIVITY_TYPE_CODE: Record<Exclude<CodeType, "ICD10">, number> = {
  CPT: 3,
  HCPCS: 4,
  DRUG: 5,
};
