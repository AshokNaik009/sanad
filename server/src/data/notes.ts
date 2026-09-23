// Twenty hand-written synthetic outpatient notes with coder-verified codes (the coding gold set).
// Notes carry no patient names: only age, which is the minimum the coding task needs.
// `{side}` notes are re-used for both knees/shoulders/ankles when generating the other 180 encounters.
import type { Specialty } from "../domain/types.ts";

export type Side = "right" | "left";

export interface BaseNote {
  key: string;
  specialty: Specialty;
  sided?: boolean;
  text: string;
  gold: (side: Side) => { principal: string; procedures: string[] };
}

const fixed = (principal: string, procedures: string[]) => () => ({ principal, procedures });

export const BASE_NOTES: BaseNote[] = [
  {
    key: "physio-knee-oa",
    specialty: "Physiotherapy",
    sided: true,
    text: `Referral: Dr. Okafor (orthopaedics) for osteoarthritis of the {side} knee.
History: {age}-year-old with 8 months of {side} knee pain on stairs and after walking 20 minutes. X-ray last month showed medial joint space narrowing.
Examination: Crepitus on flexion, quadriceps lag 10 degrees, flexion limited to 105 degrees. Timed up-and-go 14 seconds.
Treatment today: Initial physiotherapy assessment completed. Therapeutic exercise for 30 minutes including quadriceps strengthening and closed-chain work. TENS applied for 15 minutes for pain relief.
Assessment: Primary osteoarthritis of the {side} knee with reduced function.
Plan: Two sessions per week for 6 weeks; home exercise programme issued.`,
    gold: (s) => ({ principal: s === "right" ? "M17.11" : "M17.12", procedures: ["97161", "97110", "G0283"] }),
  },
  {
    key: "gp-urti",
    specialty: "GP",
    text: `Established patient seen for a follow-up consultation with 3 days of sore throat, runny nose and mild fever.
History: No shortness of breath, no chest pain. Non-smoker.
Examination: Temperature 37.9 C. Throat mildly red without exudate. Chest clear.
Rapid strep test performed in clinic: negative.
Assessment: Acute upper respiratory tract infection, likely viral.
Plan: Supportive care, paracetamol, fluids. Return if symptoms persist beyond 7 days.`,
    gold: fixed("J06.9", ["99213", "87880"]),
  },
  {
    key: "gp-diabetes",
    specialty: "GP",
    text: `Patient returns for review of type 2 diabetes, poorly controlled with fasting glucose 11.2 mmol/L at home.
Also known essential hypertension on amlodipine 5 mg.
Examination: BP 138/86. Feet: normal sensation, pulses present.
HbA1c and lipid profile ordered; blood drawn today by venipuncture.
Assessment: Type 2 diabetes mellitus, poorly controlled with hyperglycaemia. Essential hypertension, controlled.
Plan: Increase metformin to 1 g twice daily; dietitian referral; review with results in 2 weeks.`,
    gold: fixed("E11.65", ["99213", "83036", "80061", "36415"]),
  },
  {
    key: "gp-hypertension",
    specialty: "GP",
    text: `Follow-up consultation for hypertension. Home readings average 155/95 despite amlodipine 10 mg.
No chest pain, no headache, no visual symptoms.
ECG performed today: sinus rhythm, rate 78, no left ventricular hypertrophy.
Assessment: Essential hypertension, suboptimally controlled.
Plan: Add losartan 50 mg daily; renal function in 2 weeks.`,
    gold: fixed("I10", ["99213", "93000"]),
  },
  {
    key: "derm-acne",
    specialty: "Dermatology",
    text: `New patient, {age} years old, with inflammatory acne on the face and upper back for 1 year.
No previous isotretinoin. Not pregnant, not planning pregnancy.
Examination: Multiple papules and pustules on cheeks and forehead, few nodules, early scarring.
Assessment: Acne vulgaris, moderate.
Plan: Topical adapalene with benzoyl peroxide nightly; doxycycline 100 mg daily for 12 weeks.`,
    gold: fixed("L70.0", ["99203"]),
  },
  {
    key: "derm-sk-cryo",
    specialty: "Dermatology",
    text: `Follow-up consultation for multiple seborrhoeic keratoses on the back that catch on clothing and bleed.
Examination: Six stuck-on, waxy brown papules on the back; two are inflamed.
Procedure: Cryotherapy with liquid nitrogen performed to 6 lesions, two freeze-thaw cycles each.
Assessment: Irritated seborrheic keratosis.
Plan: Wound care advice; review in 3 months.`,
    gold: fixed("L82.1", ["99213", "17110"]),
  },
  {
    key: "derm-mole-biopsy",
    specialty: "Dermatology",
    text: `New patient concerned about a changing mole on the upper back noticed by spouse.
Examination: 7 mm irregular pigmented lesion with two colours on dermoscopy.
Procedure: Shave biopsy performed under local anaesthetic and sent for histology.
Assessment: Atypical pigmented naevus of the trunk; histology will exclude melanoma.
Plan: Results in 7 days.`,
    gold: fixed("D22.5", ["99203", "11102"]),
  },
  {
    key: "ortho-knee-mri",
    specialty: "Orthopaedics",
    sided: true,
    text: `Follow-up consultation. {age}-year-old with {side} knee pain after a twisting injury playing football 8 weeks ago.
Symptoms: Intermittent locking and giving way, pain on the medial side when squatting.
Examination: Medial joint line tenderness, small effusion, McMurray test positive.
Completed 6 weeks of supervised physiotherapy without improvement in locking or pain.
Assessment: Pain in the {side} knee with suspected medial meniscus tear.
Plan: MRI of the {side} knee without contrast to confirm the tear and guide the arthroscopy decision.`,
    gold: (s) => ({ principal: s === "right" ? "M25.561" : "M25.562", procedures: ["99213", "73721"] }),
  },
  {
    key: "ortho-knee-injection",
    specialty: "Orthopaedics",
    sided: true,
    text: `Follow-up consultation for {side} knee osteoarthritis with persistent pain despite 3 months of oral analgesia and physiotherapy.
Examination: Moderate effusion, crepitus, range 5-110 degrees.
Procedure: Intra-articular steroid injection of the {side} knee under aseptic technique using triamcinolone 40 mg.
Assessment: Primary osteoarthritis of the {side} knee.
Plan: Review in 6 weeks; consider total knee replacement referral if no benefit.`,
    gold: (s) => ({ principal: s === "right" ? "M17.11" : "M17.12", procedures: ["99213", "20610", "J3301"] }),
  },
  {
    key: "physio-low-back",
    specialty: "Physiotherapy",
    text: `Initial physiotherapy assessment for low back pain of 4 weeks after lifting boxes at work.
No leg pain, no numbness, no bladder or bowel change; straight leg raise negative bilaterally.
Treatment: Joint mobilisation of the lumbar spine (grade III) and core strengthening exercises for 20 minutes.
Assessment: Non-specific low back pain, mechanical.
Plan: Weekly sessions for 4 weeks; advice to stay active.`,
    gold: fixed("M54.50", ["97161", "97140", "97110"]),
  },
  {
    key: "physio-shoulder",
    specialty: "Physiotherapy",
    sided: true,
    text: `Physiotherapy session 3 of 8 for {side} shoulder impingement.
Pain now 4/10 from 7/10; painful arc 70-120 degrees.
Treatment: Manual therapy to the glenohumeral joint for 15 minutes and therapeutic exercise for rotator cuff and scapular control for 30 minutes.
Assessment: Impingement syndrome of the {side} shoulder, improving.
Plan: Continue plan; progress resistance next session.`,
    gold: (s) => ({ principal: s === "right" ? "M75.41" : "M75.42", procedures: ["97140", "97110"] }),
  },
  {
    key: "ortho-ankle",
    specialty: "Orthopaedics",
    sided: true,
    text: `New patient seen after an inversion injury to the {side} ankle yesterday while running.
Examination: Lateral swelling and tenderness over ATFL; able to weight bear four steps; Ottawa ankle rules negative, so no X-ray required.
Ankle strapping applied.
Assessment: Sprain of the {side} ankle, grade I-II.
Plan: RICE, ibuprofen, early mobilisation; review in 2 weeks if not improving.`,
    gold: (s) => ({ principal: s === "right" ? "S93.401A" : "S93.402A", procedures: ["99203", "29540"] }),
  },
  {
    key: "gp-uti",
    specialty: "GP",
    text: `Established patient seen for a follow-up consultation with dysuria and urinary frequency for 2 days.
No fever, no flank pain, no vaginal discharge. Not pregnant.
Urine dipstick in clinic: nitrites and leucocytes positive.
Assessment: Uncomplicated urinary tract infection.
Plan: Nitrofurantoin 100 mg twice daily for 5 days; fluids.`,
    gold: fixed("N39.0", ["99213", "81003"]),
  },
  {
    key: "gp-annual",
    specialty: "GP",
    text: `Annual health check for a {age}-year-old, asymptomatic, non-smoker.
Examination: BMI 26, BP 124/78, cardiovascular and respiratory examination normal.
Comprehensive metabolic panel, lipid profile, HbA1c and complete blood count ordered; blood drawn today.
Assessment: Routine adult health examination with no abnormal findings.
Plan: Results by phone; lifestyle advice given.`,
    gold: fixed("Z00.00", ["80053", "80061", "83036", "85025", "36415"]),
  },
  {
    key: "gp-vitd",
    specialty: "GP",
    text: `Follow-up consultation for tiredness over 2 months.
Previous vitamin D level last month was 12 ng/mL; other bloods normal.
Assessment: Vitamin D deficiency.
Plan: Cholecalciferol 50,000 IU weekly for 8 weeks, then repeat vitamin D level in 3 months.`,
    gold: fixed("E55.9", ["99213"]),
  },
  {
    key: "gp-asthma",
    specialty: "GP",
    text: `Follow-up consultation for asthma with night-time cough twice weekly and salbutamol use 4 times a week.
No history of hypertension. No fever.
Examination: Scattered wheeze, peak flow 78% of predicted.
Assessment: Asthma, partly controlled.
Plan: Step up to budesonide/formoterol; inhaler technique reviewed.`,
    gold: fixed("J45.909", ["99213"]),
  },
  {
    key: "gp-headache-im",
    specialty: "GP",
    text: `New patient with a band-like headache for 2 days after long work hours; no red-flag features.
Neurological examination normal. BP 122/80.
Diclofenac 75 mg given as an intramuscular injection in clinic.
Assessment: Tension-type headache.
Plan: Sleep hygiene, hydration, simple analgesia; return if worsening.`,
    gold: fixed("R51.9", ["99203", "96372", "DRG-0877-0002"]),
  },
  {
    key: "derm-eczema",
    specialty: "Dermatology",
    text: `Follow-up consultation for atopic dermatitis with a flare on the elbows and behind the knees for 2 weeks.
Sleep disturbed by itch. No signs of infection.
Assessment: Atopic dermatitis, moderate flare.
Plan: Mometasone cream for 2 weeks then twice weekly; emollients.`,
    gold: fixed("L20.9", ["99213"]),
  },
  {
    key: "derm-psoriasis",
    specialty: "Dermatology",
    text: `Patient returns for review of plaque psoriasis on the elbows, knees and scalp, 6% body surface area.
Joint pain denied.
Assessment: Psoriasis vulgaris, moderate.
Plan: Calcipotriol/betamethasone foam; consider phototherapy if no response.`,
    gold: fixed("L40.0", ["99213"]),
  },
  {
    key: "gp-diabetes-unspecified",
    specialty: "GP",
    text: `Follow-up consultation for diabetes. Good adherence to metformin; no hypoglycaemia.
Examination: Weight stable, BP 128/80.
HbA1c ordered today.
Assessment: Diabetes mellitus, stable.
Plan: Continue current treatment; review with HbA1c result.`,
    gold: fixed("E11.9", ["99213", "83036"]),
  },
];

export function renderNote(base: BaseNote, side: Side, age: number): string {
  return base.text.replaceAll("{side}", side).replaceAll("{age}", String(age));
}
