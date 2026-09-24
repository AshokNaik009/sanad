// Denial intelligence (PRD M5): classification, recovery probability, priority and
// citation-required resubmission drafts. Lookup tables decide first; the LLM only handles
// free-text payer comments and writing, and every factual sentence must cite the note.
import { z } from "zod";
import { lookupCode } from "../data/codeset.ts";
import { CATEGORY_LABEL, COMMENT_DRIVEN_CODES, DENIAL_INDEX } from "../data/reference.ts";
import type {
  Citation,
  Claim,
  Denial,
  DenialCategory,
  PriorAuth,
  ResubmissionDraft,
} from "../domain/types.ts";
import { contractPrice } from "../rules/pricing.ts";
import { daysBetween, locateQuote, newId, sentences } from "../util.ts";
import { sampleCode } from "./coding.ts";
import type { Llm } from "./llm.ts";

const CATEGORIES = [
  "auth",
  "eligibility",
  "coding",
  "medical_necessity",
  "pricing",
  "duplicate",
  "timeliness",
  "documentation",
] as const satisfies readonly DenialCategory[];

const KEYWORD_RULES: [RegExp, DenialCategory][] = [
  [/prior (approval|auth)|pre-?auth|authori[sz]ation/i, "auth"],
  [/not (medically )?(necessary|indicated)|necessity|frequency|too frequent|conservative/i, "medical_necessity"],
  [/eligib|not covered|membership|expired|network/i, "eligibility"],
  [/code|coding|diagnosis (does not|inconsistent)|modifier/i, "coding"],
  [/tariff|price|contract|unbundl|included in/i, "pricing"],
  [/duplicate|already (paid|submitted)/i, "duplicate"],
  [/late|time limit|timely|deadline/i, "timeliness"],
  [/report|notes?|document|records?|information/i, "documentation"],
];

const ClassOutput = z.object({
  category: z.enum(CATEGORIES),
  plain_explanation: z.string(),
});

export async function classifyDenial(
  llm: Llm,
  code: string,
  comment?: string,
): Promise<{ category: DenialCategory; plain: string; by: "lookup" | "ai" }> {
  const known = DENIAL_INDEX.get(code);
  // Lookup table first; only generic codes with free text go to the model.
  if (known && !(comment && COMMENT_DRIVEN_CODES.has(code))) return { category: known.category, plain: known.plain, by: "lookup" };
  const text = comment ?? known?.text ?? code;
  if (llm.enabled) {
    const out = await llm
      .structured({
      task: "denial-classification",
      schema: ClassOutput,
      system:
        "You classify UAE health insurance claim denials for a provider billing team. Pick exactly one root-cause category and explain the denial in one plain-language sentence a billing specialist can act on. Do not speculate beyond the payer's text.",
      user: `Denial code: ${code}\nPayer comment: ${text}`,
        effort: "low",
        maxTokens: 1024,
      })
      .catch(() => null);
    if (out) return { category: out.category, plain: out.plain_explanation, by: "ai" };
  }
  const hit = KEYWORD_RULES.find(([re]) => re.test(text));
  const category = hit?.[1] ?? "documentation";
  return {
    category,
    plain: comment ? `Payer comment: "${comment}" (classified as ${CATEGORY_LABEL[category].toLowerCase()}).` : known?.plain ?? "Unrecognised denial code.",
    by: "ai",
  };
}

export interface RecoveryInputs {
  code: string;
  category: DenialCategory;
  note?: string;
  hasApprovedAuth: boolean;
  payerHistoricalRecovery?: number;
}

/** Heuristic recovery probability (MVP), blended with the payer's historical recovery for the category. */
export function recoveryProbability(input: RecoveryInputs): { p: number; band: Denial["recoveryBand"] } {
  let p = DENIAL_INDEX.get(input.code)?.baseRecovery ?? 0.4;
  const note = input.note ?? "";
  if (input.category === "medical_necessity" || input.category === "documentation") {
    if (/\d+ weeks? of [^.\n]*(physiotherapy|conservative|analgesia|treatment)/i.test(note)) p += 0.15;
    if (/positive|tenderness|effusion|locking|limited|reduced/i.test(note)) p += 0.08;
  }
  if (input.category === "auth" && input.hasApprovedAuth) p += 0.3;
  if (input.payerHistoricalRecovery !== undefined) p = 0.65 * p + 0.35 * input.payerHistoricalRecovery;
  p = Math.max(0.02, Math.min(0.95, p));
  return { p: Number(p.toFixed(2)), band: p >= 0.6 ? "High" : p >= 0.35 ? "Medium" : "Low" };
}

/** Priority = amount x recovery probability x deadline urgency. */
export function priorityScore(amount: number, p: number, deadline: string, today: string): number {
  const daysLeft = daysBetween(today, deadline);
  const urgency = daysLeft < 0 ? 0 : daysLeft <= 7 ? 1.5 : daysLeft <= 14 ? 1.25 : 1;
  return Math.round(amount * p * urgency);
}

export interface DraftContext {
  denial: Denial;
  claim: Claim;
  note: string;
  patientAge: number;
  patientGender: "M" | "F";
  approvedAuths: PriorAuth[];
}

const cite = (note: string, quote: string): Citation | null => {
  const loc = locateQuote(note, quote);
  return loc ? { quote: note.slice(loc.start, loc.end), start: loc.start, end: loc.end } : null;
};

/** Offline drafter: category templates filled only with sentences that exist in the note. */
function sampleDraft(ctx: DraftContext): Omit<ResubmissionDraft, "generatedAt" | "ms" | "suggestionId"> {
  const { denial, claim, note } = ctx;
  const activity = claim.activities.find((a) => a.id === denial.activityId);
  const code = activity?.code ?? denial.activityCode;
  const entry = lookupCode(code);
  const sents = sentences(note);
  const find = (re: RegExp) => sents.find((s) => re.test(s.text));
  const justification: ResubmissionDraft["justification"] = [];
  const addFact = (sentence: string, re: RegExp) => {
    const s = find(re);
    const c = s ? cite(note, s.text) : null;
    if (c) justification.push({ sentence, citations: [c] });
  };
  const fieldFixes: ResubmissionDraft["fieldFixes"] = [];
  const attachments = ["Clinical note for the encounter"];
  let type: ResubmissionDraft["type"] = "correction";
  let summary = "";

  switch (denial.category) {
    case "medical_necessity":
    case "documentation": {
      type = "internal complaint";
      summary = `Request reconsideration of ${code} (${entry?.description ?? "service"}): the clinical record documents the indication the payer questioned.`;
      addFact("The presenting symptoms and their duration are documented at the visit.", /(\d+ (weeks?|months?|days?)|after a|for \d)/i);
      addFact("Objective examination findings support the clinical indication.", /(positive|tenderness|effusion|crepitus|limited|lag|swelling)/i);
      addFact("Conservative management was tried first and did not resolve the problem.", /(weeks? of [^.]*(physiotherapy|conservative|analgesia)|despite|without improvement)/i);
      addFact("The treating clinician recorded why the service was needed for the next clinical decision.", /(to (confirm|guide|assess)|decision|plan:)/i);
      attachments.push(entry?.type === "CPT" && code.startsWith("7") ? "Imaging request form" : "Treatment plan");
      break;
    }
    case "auth": {
      const auth = ctx.approvedAuths.find((p) => p.services.some((s) => s.code === code));
      if (auth?.approvalNumber) {
        fieldFixes.push({ field: "PriorAuthorizationID", activityId: denial.activityId, from: activity?.priorAuthNumber ?? "(blank)", to: auth.approvalNumber, reason: `Approval ${auth.approvalNumber} was granted before the service but was not transmitted on the claim.` });
        summary = `Correction: attach prior approval ${auth.approvalNumber} obtained on ${auth.createdAt.slice(0, 10)} for ${code}.`;
        attachments.push(`Prior approval ${auth.approvalNumber}`);
      } else {
        type = "internal complaint";
        summary = `No approval on file for ${code}. Request retrospective approval with the clinical justification below, or write off if the payer does not accept retro approvals.`;
      }
      addFact("The clinical need for the service is documented in the note.", /(assessment:|referral|pain|reduced function)/i);
      break;
    }
    case "coding": {
      const coded = sampleCode({ note, age: ctx.patientAge, gender: ctx.patientGender, encounterType: "outpatient", specialty: claim.specialty });
      const principal = claim.diagnoses.find((d) => d.type === "principal");
      const better = coded.suggestions.find((s) => s.codeType === "ICD10" && (!entry?.supportedBy?.length || entry.supportedBy.some((p) => s.code.startsWith(p))));
      if (principal && principal.code === "M54.5") {
        fieldFixes.push({ field: "Diagnosis.Code", from: "M54.5", to: "M54.50", reason: "M54.5 was deleted from ICD-10-CM; M54.50 is the active replacement." });
      } else if (better && principal && better.code !== principal.code) {
        fieldFixes.push({ field: "Diagnosis.Code", from: principal.code, to: better.code, reason: `${better.code} (${better.description}) is documented and supports ${code}.` });
        const ev = better.evidence[0];
        if (ev) justification.push({ sentence: `The documented diagnosis is ${better.description}.`, citations: [{ quote: ev.text, start: ev.start, end: ev.end }] });
      }
      summary = fieldFixes.length ? `Correction: ${fieldFixes.map((f) => `${f.from} → ${f.to}`).join(", ")}.` : "Review the codes against the note; no automatic correction found.";
      break;
    }
    case "pricing": {
      const agreed = contractPrice(claim.payerId, code);
      fieldFixes.push({ field: "Activity.Net", activityId: denial.activityId, from: activity?.net.toFixed(2), to: (agreed - (activity?.patientShare ?? 0)).toFixed(2), reason: `Bill at the ${claim.payerName} contract price of AED ${agreed.toFixed(2)}.` });
      summary = `Correction: re-bill ${code} at the contract price; the difference above tariff is not recoverable.`;
      break;
    }
    case "eligibility":
      summary = "Coverage was not active on the date of service. Re-check eligibility; if coverage is confirmed, resubmit with the correct member ID, otherwise transfer the balance to the patient.";
      attachments.push("Eligibility check result");
      break;
    case "duplicate":
      summary = "The payer already received this service. Confirm the original claim was paid, then write this line off as a duplicate.";
      break;
    case "timeliness":
      summary = "Submitted after the payer's time limit. Resubmit only with proof of timely original submission (gateway acknowledgement); otherwise write off.";
      attachments.push("Original submission acknowledgement");
      type = "internal complaint";
      break;
  }
  return { summary, fieldFixes, justification, attachments, blockedSentences: [], type };
}

const DraftOutput = z.object({
  summary: z.string(),
  resubmission_type: z.enum(["correction", "internal complaint"]),
  field_fixes: z.array(z.object({ field: z.string(), from: z.string(), to: z.string(), reason: z.string() })),
  justification: z.array(z.object({ sentence: z.string(), note_quotes: z.array(z.string()) })),
  attachments: z.array(z.string()),
});

const DRAFT_SYSTEM = `You draft resubmissions of denied UAE health insurance claims for a provider billing specialist.
Rules:
- Every justification sentence states one clinical or administrative fact and cites one or more short verbatim quotes from the clinical note in note_quotes.
- Never introduce a diagnosis, finding, date or treatment that is not in the note. If the note does not support resubmission, say so in the summary and leave justification empty.
- Use "correction" when a field on the claim was wrong and is being fixed; use "internal complaint" when the claim was correct and you are contesting the payer's decision.
- Field fixes may only change codes to valid ICD-10-CM/CPT/HCPCS codes, attach approval numbers already known, or set prices to the contract price given.
- Write for a payer medical reviewer: concise, factual, no persuasion adjectives.`;

async function modelDraft(llm: Llm, ctx: DraftContext) {
  const { denial, claim, note } = ctx;
  const auths = ctx.approvedAuths.map((a) => `${a.approvalNumber} for ${a.services.map((s) => s.code).join(",")} valid until ${a.validUntil}`).join("; ") || "none";
  const activity = claim.activities.find((a) => a.id === denial.activityId);
  const out = await llm.structured({
    task: "resubmission-draft",
    schema: DraftOutput,
    system: DRAFT_SYSTEM,
    user: [
      `Payer: ${claim.payerName}. Denial ${denial.code} (${DENIAL_INDEX.get(denial.code)?.text ?? ""}); category ${denial.category}.`,
      denial.payerComment ? `Payer comment: ${denial.payerComment}` : "",
      `Denied activity: ${activity?.code} ${activity?.description}, net AED ${activity?.net.toFixed(2)}, contract price AED ${contractPrice(claim.payerId, denial.activityCode).toFixed(2)}.`,
      `Claim diagnoses: ${claim.diagnoses.map((d) => `${d.code} (${d.type})`).join(", ")}.`,
      `Approved prior authorisations on file: ${auths}.`,
      `Patient: ${ctx.patientAge}-year-old ${ctx.patientGender === "F" ? "female" : "male"}.`,
      `Clinical note:\n"""\n${note}\n"""`,
    ].filter(Boolean).join("\n"),
    effort: "medium",
  });
  const justification: ResubmissionDraft["justification"] = [];
  const blocked: string[] = [];
  for (const j of out.justification) {
    const citations = j.note_quotes.map((q) => cite(note, q)).filter((c): c is Citation => !!c);
    // Guardrail: sentences without a verifiable quote from the note are blocked, not sent.
    if (citations.length) justification.push({ sentence: j.sentence, citations });
    else blocked.push(j.sentence);
  }
  const fieldFixes = out.field_fixes.filter((f) => !/code/i.test(f.field) || lookupCode(f.to)?.active);
  return {
    summary: out.summary,
    fieldFixes: fieldFixes.map((f) => ({ ...f, activityId: /diagnosis/i.test(f.field) ? undefined : denial.activityId })),
    justification,
    attachments: out.attachments,
    blockedSentences: blocked,
    type: out.resubmission_type,
  };
}

export async function draftResubmission(llm: Llm, ctx: DraftContext): Promise<ResubmissionDraft> {
  const started = Date.now();
  const body = llm.enabled ? await modelDraft(llm, ctx).catch(() => sampleDraft(ctx)) : sampleDraft(ctx);
  return { ...body, generatedAt: new Date().toISOString(), ms: Date.now() - started, suggestionId: newId("ai") };
}

export function resubmissionComment(draft: ResubmissionDraft): string {
  const lines = [draft.summary, ...draft.justification.map((j) => `${j.sentence} Note: "${j.citations[0]?.quote}".`)];
  return lines.join(" ").slice(0, 2000);
}
