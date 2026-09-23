// AI coding assistant (PRD M2): suggests ICD-10-CM and CPT/HCPCS/drug codes with evidence spans.
// Two engines share one output contract and the same guardrails:
//  - every code must exist, be active, and fit the patient's demographics in the loaded code set
//  - every code must carry at least one evidence span that exists verbatim in the note
import { z } from "zod";
import { CODES, type CodeEntry, lookupCode } from "../data/codeset.ts";
import type { CodeSuggestion, EvidenceSpan } from "../domain/types.ts";
import { locateQuote, newId, sentences } from "../util.ts";
import type { Llm } from "./llm.ts";

export interface CodingInput {
  note: string;
  age: number;
  gender: "M" | "F";
  encounterType: string;
  specialty: string;
}

export interface CodingResult {
  suggestions: CodeSuggestion[];
  gaps: { id: string; question: string; reason: string }[];
  engine: "sample" | "model";
}

const NEGATION = /\b(no|denies|denied|without|negative for|not)\b/i;
const UNCERTAIN = /\b(suspected|possible|probable|rule out|query)\b|\?/i;

function demographicOk(entry: CodeEntry, input: CodingInput): boolean {
  if (entry.gender && entry.gender !== input.gender) return false;
  if (entry.minAge !== undefined && input.age < entry.minAge) return false;
  if (entry.maxAge !== undefined && input.age > entry.maxAge) return false;
  return true;
}

function assessmentRange(note: string): { start: number; end: number } | null {
  const m = /^assessment:.*$/im.exec(note);
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

/** Offline coding engine: pattern retrieval over the code set with negation/uncertainty handling. */
export function sampleCode(input: CodingInput): CodingResult {
  const { note } = input;
  const sents = sentences(note);
  const assessment = assessmentRange(note);
  const found = new Map<
    string,
    { entry: CodeEntry; spans: EvidenceSpan[]; first: number; positions: number[] }
  >();
  for (const entry of CODES) {
    if (!entry.active || !entry.patterns?.length || !demographicOk(entry, input)) continue;
    for (const pattern of entry.patterns) {
      const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
      for (const m of note.matchAll(re)) {
        const start = m.index ?? 0;
        const end = start + m[0].length;
        const sentence = sents.find((s) => start >= s.start && start < s.end);
        if (!sentence) continue;
        const prefix = note.slice(sentence.start, start);
        const clause = prefix.split(/[,;:]/).pop() ?? "";
        if (NEGATION.test(clause)) continue;
        const window = note.slice(Math.max(sentence.start, start - 30), end);
        if (UNCERTAIN.test(window)) continue;
        const current = found.get(entry.code) ?? { entry, spans: [], first: start, positions: [] };
        current.positions.push(start);
        if (!current.spans.some((s) => s.start === sentence.start))
          current.spans.push({ start: sentence.start, end: sentence.end, text: sentence.text });
        current.first = Math.min(current.first, start);
        found.set(entry.code, current);
      }
    }
  }
  for (const { entry } of [...found.values()])
    for (const weaker of entry.supersedes ?? []) found.delete(weaker);

  const inAssessment = (spans: EvidenceSpan[]) =>
    !!assessment && spans.some((s) => s.start >= assessment.start && s.start < assessment.end);
  // Principal diagnosis: the first one listed in the Assessment line; otherwise first mentioned.
  const assessmentKey = (f: { positions: number[]; first: number }) => {
    const inside = assessment
      ? f.positions.filter((p) => p >= assessment.start && p < assessment.end)
      : [];
    return inside.length ? Math.min(...inside) : Number.MAX_SAFE_INTEGER;
  };
  const principalFirst = [...found.values()]
    .filter((f) => f.entry.type === "ICD10")
    .sort((a, b) => assessmentKey(a) - assessmentKey(b) || a.first - b.first);
  const procedures = [...found.values()]
    .filter((f) => f.entry.type !== "ICD10")
    .sort((a, b) => a.first - b.first);

  const confidence = (f: { spans: EvidenceSpan[] }, base: number) =>
    Math.min(0.97, base + (inAssessment(f.spans) ? 0.18 : 0) + 0.05 * (f.spans.length - 1));
  const suggestions: CodeSuggestion[] = [
    ...principalFirst.map((f, i) => ({
      id: newId("sug"),
      code: f.entry.code,
      codeType: f.entry.type,
      description: f.entry.description,
      confidence: Number(confidence(f, i === 0 ? 0.7 : 0.6).toFixed(2)),
      evidence: f.spans,
      role: (i === 0 ? "principal" : "secondary") as CodeSuggestion["role"],
      decision: "pending" as const,
    })),
    ...procedures.map((f) => ({
      id: newId("sug"),
      code: f.entry.code,
      codeType: f.entry.type,
      description: f.entry.description,
      confidence: Number(confidence(f, 0.78).toFixed(2)),
      evidence: f.spans,
      role: "procedure" as const,
      decision: "pending" as const,
    })),
  ];
  return { suggestions, gaps: detectGaps(input, suggestions), engine: "sample" };
}

/** Documentation specificity checklist: questions only, never invented clinical facts. */
export function detectGaps(input: CodingInput, suggestions: CodeSuggestion[]) {
  const note = input.note;
  const codes = new Set(suggestions.map((s) => s.code));
  const gaps: { id: string; question: string; reason: string }[] = [];
  const add = (question: string, reason: string) => gaps.push({ id: newId("gap"), question, reason });
  if (/knee pain|pain in the knee/i.test(note) && !/\b(right|left|bilateral)\b[^.\n]*knee/i.test(note))
    add("Which knee is affected (right, left or bilateral)?", "ICD-10-CM knee pain codes require laterality; M25.569 (unspecified) is frequently denied.");
  if (/\bdiabetes\b/i.test(note) && !/type (1|2|one|two)|\bT[12]DM\b|gestational|prediabetes/i.test(note))
    add("Please document the diabetes type (type 1, type 2 or other) and any complications.", "Diabetes cannot be coded to E10/E11 without the type.");
  if (/ankle (sprain|injury)|inversion injury/i.test(note) && !/\b(right|left)\b[^.\n]*ankle/i.test(note))
    add("Which ankle was injured (right or left)?", "Ankle sprain codes (S93.4-) require laterality.");
  if ((codes.has("73721") || /\bMRI\b/.test(note)) && !/\d+ weeks? of [^.\n]*(physiotherapy|conservative|analgesia)/i.test(note))
    add("Please document the duration and outcome of conservative treatment before the MRI.", "Payers deny advanced imaging (MNEC-003) without failed conservative therapy on record.");
  if (/shoulder (pain|impingement)/i.test(note) && !/\b(right|left)\b[^.\n]*shoulder/i.test(note))
    add("Which shoulder is affected (right or left)?", "Shoulder impingement codes (M75.4-) require laterality.");
  return gaps;
}

const ModelOutput = z.object({
  codes: z.array(
    z.object({
      code: z.string(),
      role: z.enum(["principal", "secondary", "procedure"]),
      confidence: z.number(),
      evidence_quotes: z.array(z.string()),
    }),
  ),
  documentation_questions: z.array(z.object({ question: z.string(), reason: z.string() })),
});

const SYSTEM = `You are a certified outpatient medical coder in the UAE (DHA/DOH, ICD-10-CM and CPT/HCPCS).
Code only what the clinical note documents as performed or diagnosed at this encounter.
Follow outpatient guidelines: do not code uncertain diagnoses ("suspected", "rule out", "probable") - code the documented symptom instead. Do not code negated findings or services only planned for later.
Choose codes ONLY from the provided code list. Exactly one diagnosis must have role "principal".
For every code, copy one or more short evidence quotes verbatim from the note (exact substrings).
Confidence is 0-1. If documentation is missing specificity a coder would need (laterality, type, duration of conservative treatment), write a question for the doctor; never invent clinical facts.`;

export async function modelCode(llm: Llm, input: CodingInput): Promise<CodingResult> {
  const codeList = CODES.filter((c) => c.active)
    .map((c) => `${c.code} | ${c.type} | ${c.description}`)
    .join("\n");
  const out = await llm.structured({
    task: "coding",
    schema: ModelOutput,
    system: SYSTEM,
    user: `Patient: ${input.age}-year-old ${input.gender === "F" ? "female" : "male"}. Encounter: ${input.encounterType}, ${input.specialty}.\n\nCode list:\n${codeList}\n\nClinical note:\n"""\n${input.note}\n"""`,
    effort: "medium",
  });
  const suggestions: CodeSuggestion[] = [];
  for (const c of out.codes) {
    const entry = lookupCode(c.code);
    // Guardrail M2.2: codes outside the code set, inactive, or demographically invalid are never shown.
    if (!entry || !entry.active || !demographicOk(entry, input)) continue;
    if (suggestions.some((s) => s.code === entry.code)) continue;
    const evidence = c.evidence_quotes
      .map((q) => {
        const loc = locateQuote(input.note, q);
        return loc ? { ...loc, text: input.note.slice(loc.start, loc.end) } : null;
      })
      .filter((e): e is EvidenceSpan => !!e);
    // Guardrail: evidence span must exist in the note.
    if (!evidence.length) continue;
    const isDx = entry.type === "ICD10";
    suggestions.push({
      id: newId("sug"),
      code: entry.code,
      codeType: entry.type,
      description: entry.description,
      confidence: Math.max(0, Math.min(1, Number(c.confidence.toFixed(2)))),
      evidence,
      role: isDx ? (c.role === "principal" ? "principal" : "secondary") : "procedure",
      decision: "pending",
    });
  }
  const dx = suggestions.filter((s) => s.codeType === "ICD10");
  if (dx.length && !dx.some((s) => s.role === "principal")) dx[0].role = "principal";
  let seenPrincipal = false;
  for (const s of dx) {
    if (s.role === "principal") {
      if (seenPrincipal) s.role = "secondary";
      seenPrincipal = true;
    }
  }
  suggestions.sort((a, b) => order(a.role) - order(b.role));
  const gaps = out.documentation_questions.map((g) => ({ id: newId("gap"), ...g }));
  return { suggestions, gaps, engine: "model" };
}

const order = (role: CodeSuggestion["role"]) => (role === "principal" ? 0 : role === "secondary" ? 1 : 2);

export async function suggestCodes(llm: Llm, input: CodingInput): Promise<CodingResult> {
  if (!llm.enabled) return sampleCode(input);
  try {
    return await modelCode(llm, input);
  } catch (error) {
    // Degrade to the offline engine rather than blocking the coder.
    console.warn(`[coding] model unavailable, using offline engine: ${(error as Error).message}`);
    return sampleCode(input);
  }
}
