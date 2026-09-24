// Proposals, after OpenMuse's ActionService: anything an agent (Denial Autopilot, the copilot)
// wants to send outside the clinic is stored as a proposal with a content hash. It runs only
// when a person approves that exact content; the decision and outcome go to the audit log.
import { resubmissionComment } from "../ai/denials.ts";
import type { Denial } from "../domain/types.ts";
import { AppError, newId, sha256, stableStringify } from "../util.ts";
import type { Actor } from "./audit.ts";
import type { Platform } from "./platform.ts";

export type ProposalKind = "resubmit_denial";

export interface ResubmitPayload {
  denialId: string;
  claimId: string;
  type: "correction" | "internal complaint";
  comment: string;
  fixes: { field: string; from?: string; to: string; reason: string }[];
}

export interface Proposal {
  id: string;
  kind: ProposalKind;
  source: "autopilot" | "copilot";
  entityId: string;
  title: string;
  summary: string;
  amount: number;
  payerName: string;
  deadline?: string;
  payload: ResubmitPayload;
  contentHash: string;
  status: "awaiting_review" | "approved" | "declined" | "failed" | "expired";
  proposedBy: string;
  proposedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  reason?: string;
  outcome?: string;
}

const KIND = "proposals";
const hashOf = (kind: ProposalKind, payload: ResubmitPayload) => sha256(stableStringify({ kind, payload }));

export class Proposals {
  constructor(private readonly platform: Platform) {}

  private get store() {
    return this.platform.store;
  }
  private get org() {
    return this.platform.org;
  }

  async list(status?: Proposal["status"]): Promise<Proposal[]> {
    const all = status ? await this.store.find<Proposal>(this.org, KIND, { status }) : await this.store.list<Proposal>(this.org, KIND);
    return all.sort((a, b) => b.proposedAt.localeCompare(a.proposedAt));
  }

  get(id: string): Promise<Proposal> {
    return this.platform.need<Proposal>(KIND, id, "Proposal");
  }

  async pendingFor(entityId: string): Promise<Proposal | undefined> {
    return (await this.store.find<Proposal>(this.org, KIND, { entityId, status: "awaiting_review" }))[0];
  }

  /** Proposes resubmitting a denial with its current draft. One open proposal per denial. */
  async proposeResubmission(denial: Denial, source: Proposal["source"], actor: Actor): Promise<Proposal> {
    if (!denial.draft) throw new AppError("Draft the resubmission before proposing it", 409);
    const existing = await this.pendingFor(denial.id);
    if (existing) return existing;
    const payload: ResubmitPayload = {
      denialId: denial.id,
      claimId: denial.claimId,
      type: denial.draft.type,
      comment: resubmissionComment(denial.draft),
      fixes: denial.draft.fieldFixes.map(({ field, from, to, reason }) => ({ field, from, to, reason })),
    };
    const proposal: Proposal = {
      id: newId("prop"),
      kind: "resubmit_denial",
      source,
      entityId: denial.id,
      title: `Appeal ${denial.activityCode} with ${denial.payerName}`,
      summary: denial.draft.summary,
      amount: denial.amount,
      payerName: denial.payerName,
      deadline: denial.deadline,
      payload,
      contentHash: hashOf("resubmit_denial", payload),
      status: "awaiting_review",
      proposedBy: actor.id,
      proposedAt: new Date().toISOString(),
    };
    await this.store.put(this.org, KIND, proposal);
    await this.platform.audit.record(this.org, actor, "proposal.create", "proposal", proposal.id, undefined, { kind: proposal.kind, entityId: denial.id, source, hash: proposal.contentHash });
    return proposal;
  }

  /**
   * Approve or decline. The caller sends the hash of the content they reviewed; if the stored
   * proposal differs, nothing runs.
   */
  async decide(id: string, hash: string, approve: boolean, actor: Actor, reason?: string): Promise<Proposal> {
    const proposal = await this.get(id);
    if (proposal.status !== "awaiting_review") throw new AppError(`This proposal was already ${proposal.status.replace("_", " ")}`, 409);
    if (proposal.contentHash !== hash || hashOf(proposal.kind, proposal.payload) !== hash)
      throw new AppError("This proposal changed after you opened it; reload and review it again", 409);
    const decided: Proposal = { ...proposal, decidedBy: actor.id, decidedAt: new Date().toISOString(), reason: reason?.trim() || undefined };
    // Resubmission applies the denial's current draft, so it must still be the reviewed one.
    const denial = await this.platform.denial(proposal.payload.denialId);
    const current = denial.draft && hashOf(proposal.kind, { ...proposal.payload, comment: resubmissionComment(denial.draft), fixes: denial.draft.fieldFixes.map(({ field, from, to, reason }) => ({ field, from, to, reason })) });
    if (approve && (denial.status !== "open" || current !== hash)) {
      await this.store.put(this.org, KIND, { ...proposal, status: "expired", outcome: denial.status !== "open" ? `The denial is already ${denial.status.replace("_", " ")}` : "The draft was edited after this proposal" });
      throw new AppError(denial.status !== "open" ? "This denial was already handled" : "The appeal draft changed since this proposal was made; open the denial to review it", 409);
    }
    if (!approve) {
      decided.status = "declined";
    } else {
      try {
        const { submission } = await this.platform.resubmit(proposal.payload.denialId, { type: proposal.payload.type, comment: proposal.payload.comment, applyFixes: true }, actor);
        decided.status = "approved";
        decided.outcome = `Sent to ${proposal.payerName} (${submission.id})`;
      } catch (error) {
        decided.status = "failed";
        decided.outcome = error instanceof Error ? error.message : "Could not send";
      }
    }
    await this.store.put(this.org, KIND, decided);
    await this.platform.audit.record(this.org, actor, approve ? "proposal.approve" : "proposal.decline", "proposal", id, { status: proposal.status }, { status: decided.status, hash, outcome: decided.outcome, reason: decided.reason });
    return decided;
  }

  /** Closes proposals whose denial was handled some other way (manual resubmit or write-off). */
  async expireHandled(): Promise<number> {
    let expired = 0;
    for (const p of await this.list("awaiting_review")) {
      const denial = await this.store.get<Denial>(this.org, "denials", p.entityId);
      if (denial && denial.status === "open") continue;
      await this.store.put(this.org, KIND, { ...p, status: "expired", outcome: "Handled outside this proposal" });
      expired++;
    }
    return expired;
  }
}
