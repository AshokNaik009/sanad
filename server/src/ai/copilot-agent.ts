// The ⌘K copilot as a small tool-using agent (OpenMuse pattern: the model picks a tool, the tool
// result renders as a card, and anything outward-facing becomes a proposal a person approves).
// Tool choice uses the model when available and a keyword router otherwise; the tools themselves
// are deterministic and reuse the platform services.
import { z } from "zod";
import { CATEGORY_LABEL, DENIAL_INDEX, PAYERS } from "../data/reference.ts";
import type { Claim, Denial, PayerRisk } from "../domain/types.ts";
import type { Actor } from "../services/audit.ts";
import type { Platform } from "../services/platform.ts";
import type { Proposals } from "../services/proposals.ts";
import { type CopilotAnswer, askCopilot } from "./copilot.ts";

export type AgentCard =
  | { type: "denial_code"; code: string; text: string; plain: string; category: string; openCount: number; openAmount: number }
  | { type: "denial"; id: string; code: string; activityCode: string; payerName: string; amount: number; deadline: string; plain: string; band: string }
  | { type: "claim"; id: string; status: string; score?: number; payerName: string; issues: { rule: string; severity: string; message: string }[]; risks: PayerRisk[] }
  | { type: "proposal"; id: string; title: string; summary: string; amount: number; payerName: string; status: string };

export interface AgentAnswer extends Partial<CopilotAnswer> {
  question: string;
  tool: ToolName;
  answer: string;
  cards: AgentCard[];
}

const TOOLS = ["ask_data", "explain_denial_code", "check_claim", "worklist", "draft_appeals"] as const;
type ToolName = (typeof TOOLS)[number];

const Route = z.object({
  tool: z.enum(TOOLS),
  payer: z.string().optional(),
  code: z.string().optional(),
  claimId: z.string().optional(),
  limit: z.number().int().min(1).max(10).optional(),
});
type RouteOut = z.output<typeof Route>;

const ROUTER_PROMPT = `You route a clinic billing question to one tool. Tools:
- ask_data: any question answered with numbers from claims, denials, payments or A/R (trends, rates, totals, rankings).
- explain_denial_code: what a denial code means (e.g. "what does MNEC-003 mean"). Set code.
- check_claim: whether a specific claim is ready or what is wrong with it. Set claimId (looks like clm_0102).
- worklist: which denials to work first / what is urgent. Optional payer.
- draft_appeals: prepare, draft or write appeals/resubmissions for open denials. Optional payer and limit.
Payers: ${PAYERS.map((p) => p.name).join(", ")}. Put the payer's first word in payer if mentioned.`;

function keywordRoute(question: string): RouteOut {
  const q = question.toLowerCase();
  const payer = /(nahr|saffron|gulf)/i.exec(question)?.[1];
  const code = /\b([A-Z]{4}-\d{3,4})\b/i.exec(question)?.[1]?.toUpperCase();
  const claimId = /\b(clm_[a-z0-9]+)\b/i.exec(question)?.[1]?.toLowerCase();
  const limit = Number(/\b(\d{1,2})\b/.exec(q)?.[1]) || undefined;
  if (/(draft|prepare|write|queue).*(appeal|resubmi)|appeal.*(for|all)/.test(q)) return { tool: "draft_appeals", payer, limit };
  if (code && /(mean|explain|what is|why)/.test(q)) return { tool: "explain_denial_code", code };
  if (claimId) return { tool: "check_claim", claimId };
  if (/(work first|urgent|priorit|worklist|what should i)/.test(q)) return { tool: "worklist", payer };
  if (code) return { tool: "explain_denial_code", code };
  return { tool: "ask_data" };
}

const byPayer = (payer?: string) => (d: { payerName: string }) => !payer || d.payerName.toLowerCase().includes(payer.toLowerCase());
const aed = (n: number) => `AED ${Math.round(n).toLocaleString("en")}`;

export class CopilotAgent {
  constructor(
    private readonly platform: Platform,
    private readonly proposals: Proposals,
  ) {}

  private async route(question: string): Promise<RouteOut> {
    const fallback = keywordRoute(question);
    if (!this.platform.llm.enabled) return fallback;
    const routed = await this.platform.llm
      .structured({ task: "copilot-route", schema: Route, system: ROUTER_PROMPT, user: question, effort: "low", maxTokens: 512 })
      .catch(() => null);
    // Deterministic identifiers from the text win over the model's reading of them.
    return routed ? { ...routed, code: fallback.code ?? routed.code, claimId: fallback.claimId ?? routed.claimId } : fallback;
  }

  async ask(question: string, actor: Actor, can: { propose: boolean }): Promise<AgentAnswer> {
    const route = await this.route(question);
    switch (route.tool) {
      case "explain_denial_code":
        return this.explainCode(question, route.code);
      case "check_claim":
        return this.checkClaim(question, route.claimId);
      case "worklist":
        return this.worklist(question, route.payer);
      case "draft_appeals":
        if (!can.propose) return { question, tool: route.tool, answer: "Your role can view denials but not prepare appeals. A biller can ask me to draft them.", cards: [] };
        return this.draftAppeals(question, actor, route.payer, route.limit ?? 3);
      default: {
        const data = await askCopilot(this.platform.llm, this.platform.store, this.platform.org, question);
        return { ...data, tool: "ask_data", cards: [] };
      }
    }
  }

  private async explainCode(question: string, code?: string): Promise<AgentAnswer> {
    const info = code ? DENIAL_INDEX.get(code) : undefined;
    if (!info) return { question, tool: "explain_denial_code", answer: code ? `${code} is not in the current regulator denial list.` : "Which denial code? For example: what does MNEC-003 mean?", cards: [] };
    const open = (await this.platform.listDenials({ status: "open" })).filter((d) => d.code === info.code);
    const amount = open.reduce((s, d) => s + d.amount, 0);
    return {
      question,
      tool: "explain_denial_code",
      answer: `${info.code}: ${info.plain} ${open.length ? `You have ${open.length} open denial${open.length === 1 ? "" : "s"} with this code worth ${aed(amount)}.` : "You have no open denials with this code."}`,
      cards: [{ type: "denial_code", code: info.code, text: info.text, plain: info.plain, category: CATEGORY_LABEL[info.category], openCount: open.length, openAmount: amount }],
    };
  }

  private async checkClaim(question: string, claimId?: string): Promise<AgentAnswer> {
    const claim = claimId ? await this.platform.store.get<Claim>(this.platform.org, "claims", claimId) : null;
    if (!claim) return { question, tool: "check_claim", answer: claimId ? `I couldn't find claim ${claimId}.` : "Which claim? Give me its ID, like clm_0102.", cards: [] };
    const issues = claim.issues ?? [];
    const risks = await this.platform.payerIntel.risksFor(claim);
    const blocking = issues.filter((i) => i.severity === "blocking");
    const open = risks.filter((r) => !r.mitigated);
    const answer = blocking.length
      ? `Claim ${claim.id} is not ready: ${blocking.length} issue${blocking.length === 1 ? "" : "s"} must be fixed first (${blocking.map((b) => b.rule).join(", ")}).`
      : `Claim ${claim.id} passes every check${claim.cleanClaimScore !== undefined ? ` (score ${claim.cleanClaimScore}/100)` : ""}.${open.length ? ` Watch out: ${open[0].message}` : ""}`;
    return {
      question,
      tool: "check_claim",
      answer,
      cards: [{ type: "claim", id: claim.id, status: claim.status, score: claim.cleanClaimScore, payerName: claim.payerName, issues: issues.slice(0, 5).map(({ rule, severity, message }) => ({ rule, severity, message })), risks }],
    };
  }

  private denialCard(d: Denial): AgentCard {
    return { type: "denial", id: d.id, code: d.code, activityCode: d.activityCode, payerName: d.payerName, amount: d.amount, deadline: d.deadline, plain: d.plainReason, band: d.recoveryBand };
  }

  private async worklist(question: string, payer?: string): Promise<AgentAnswer> {
    const today = this.platform.today();
    const open = (await this.platform.listDenials({ status: "open" })).filter((d) => !d.historical && d.deadline >= today).filter(byPayer(payer));
    const top = open.slice(0, 5);
    const total = open.reduce((s, d) => s + d.amount, 0);
    return {
      question,
      tool: "worklist",
      answer: top.length
        ? `${open.length} open denial${open.length === 1 ? "" : "s"}${payer ? ` from ${payer}` : ""} worth ${aed(total)}. Start with these — ranked by amount, chance of recovery and deadline.`
        : "No open denials inside their appeal window.",
      cards: top.map((d) => this.denialCard(d)),
    };
  }

  private async draftAppeals(question: string, actor: Actor, payer: string | undefined, limit: number): Promise<AgentAnswer> {
    const today = this.platform.today();
    const pending = new Set((await this.proposals.list("awaiting_review")).map((p) => p.entityId));
    const targets = (await this.platform.listDenials({ status: "open" }))
      .filter((d) => !d.historical && d.deadline >= today && !pending.has(d.id))
      .filter(byPayer(payer))
      .slice(0, limit);
    const cards: AgentCard[] = [];
    for (const d of targets) {
      const drafted = d.draft ? d : await this.platform.draftDenial(d.id, actor);
      const p = await this.proposals.proposeResubmission(drafted, "copilot", actor);
      cards.push({ type: "proposal", id: p.id, title: p.title, summary: p.summary, amount: p.amount, payerName: p.payerName, status: p.status });
    }
    const amount = targets.reduce((s, d) => s + d.amount, 0);
    return {
      question,
      tool: "draft_appeals",
      answer: cards.length
        ? `I drafted ${cards.length} appeal${cards.length === 1 ? "" : "s"} worth ${aed(amount)}. Nothing has been sent — review and approve each one.`
        : `There are no open denials${payer ? ` from ${payer}` : ""} without an appeal waiting for review.`,
      cards,
    };
  }
}
