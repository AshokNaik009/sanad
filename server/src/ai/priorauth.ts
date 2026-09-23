// Prior-authorisation drafting (PRD M7.2): clinical justification from the referral note.
import { z } from "zod";
import { lookupCode } from "../data/codeset.ts";
import { sentences } from "../util.ts";
import type { Llm } from "./llm.ts";

export async function draftPriorAuthJustification(
  llm: Llm,
  note: string,
  diagnosis: string,
  codes: string[],
): Promise<string> {
  const services = codes.map((c) => `${c} ${lookupCode(c)?.description ?? ""}`).join("; ");
  if (llm.enabled) {
    const out = await llm
      .structured({
      task: "prior-auth",
      schema: z.object({ justification: z.string() }),
      system:
        "You write prior-authorisation clinical justifications for UAE payers. Use only facts in the referral note: history, examination findings, previous treatment and why the requested service changes management. 3-5 sentences, no invented facts, no persuasion adjectives.",
      user: `Diagnosis: ${diagnosis} ${lookupCode(diagnosis)?.description ?? ""}\nRequested services: ${services}\nReferral note:\n"""\n${note}\n"""`,
        effort: "low",
        maxTokens: 2048,
      })
      .catch(() => null);
    if (out) return out.justification;
  }
  const picks = sentences(note)
    .map((s) => s.text)
    .filter((s) => /(history|assessment|examination|referral|weeks|months|positive|limited|reduced|despite|without improvement)/i.test(s))
    .slice(0, 5)
    .map((s) => s.replace(/^(History|Examination|Assessment|Referral|Symptoms|Treatment today):\s*/i, ""));
  return `${picks.join(" ")} Requested: ${services}.`.trim();
}
