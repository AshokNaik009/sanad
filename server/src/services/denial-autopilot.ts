// Denial Autopilot, after OpenMuse's durable task engine: a background job that works the open
// denial worklist in priority order, writes a cited resubmission draft for each and turns it
// into a proposal. Nothing is sent: every appeal waits for one-tap approval in the inbox.
// Job state lives in the store with a lease, so a restart or a second click never runs two jobs.
import type { Denial } from "../domain/types.ts";
import { newId } from "../util.ts";
import type { Actor } from "./audit.ts";
import type { Platform } from "./platform.ts";
import type { Proposals } from "./proposals.ts";

export interface AutopilotJob {
  id: string;
  status: "running" | "done" | "failed";
  startedBy: string;
  startedAt: string;
  finishedAt?: string;
  /** Heartbeat; a running job whose lease lapsed (process died) can be replaced. */
  leaseUntil: string;
  total: number;
  processed: number;
  proposed: number;
  skipped: number;
  amount: number;
  current?: string;
  proposalIds: string[];
  errors: string[];
}

const KIND = "jobs";
const LEASE_MS = 60_000;
const AUTOPILOT: Actor = { id: "autopilot", role: "system" };

export class DenialAutopilot {
  private running?: Promise<void>;

  constructor(
    private readonly platform: Platform,
    private readonly proposals: Proposals,
  ) {}

  async latest(): Promise<AutopilotJob | null> {
    const jobs = await this.platform.store.list<AutopilotJob>(this.platform.org, KIND);
    return jobs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
  }

  /** Open denials still inside their appeal window with no proposal waiting, highest priority first. */
  async worklist(): Promise<Denial[]> {
    const today = this.platform.today();
    const open = (await this.platform.listDenials({ status: "open" })).filter((d) => !d.historical && d.deadline >= today);
    const pending = new Set((await this.proposals.list("awaiting_review")).map((p) => p.entityId));
    return open.filter((d) => !pending.has(d.id));
  }

  async start(actor: Actor, limit = 25): Promise<AutopilotJob> {
    const last = await this.latest();
    if (last?.status === "running" && last.leaseUntil > new Date().toISOString()) return last;
    const worklist = (await this.worklist()).slice(0, limit);
    const job: AutopilotJob = {
      id: newId("job"),
      status: "running",
      startedBy: actor.id,
      startedAt: new Date().toISOString(),
      leaseUntil: new Date(Date.now() + LEASE_MS).toISOString(),
      total: worklist.length,
      processed: 0,
      proposed: 0,
      skipped: 0,
      amount: 0,
      proposalIds: [],
      errors: [],
    };
    await this.save(job);
    await this.platform.audit.record(this.platform.org, actor, "autopilot.start", "job", job.id, undefined, { denials: worklist.map((d) => d.id) });
    this.running = this.run(job, worklist).catch(async (error) => {
      await this.save({ ...job, status: "failed", finishedAt: new Date().toISOString(), errors: [...job.errors, (error as Error).message] });
    });
    return job;
  }

  /** Resolves when the current run finishes (tests and scripts). */
  async settled(): Promise<void> {
    await this.running;
  }

  private save(job: AutopilotJob) {
    return this.platform.store.put(this.platform.org, KIND, { ...job, proposalIds: [...job.proposalIds], errors: [...job.errors] });
  }

  private async run(job: AutopilotJob, worklist: Denial[]): Promise<void> {
    for (const item of worklist) {
      job.current = `${item.activityCode} · ${item.payerName}`;
      job.leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
      await this.save(job);
      try {
        // Re-read: a person may have resubmitted or written it off while the job was running.
        const denial = await this.platform.denial(item.id);
        if (denial.status !== "open" || (await this.proposals.pendingFor(denial.id))) {
          job.skipped++;
        } else {
          const drafted = denial.draft ? denial : await this.platform.draftDenial(denial.id, AUTOPILOT);
          const proposal = await this.proposals.proposeResubmission(drafted, "autopilot", AUTOPILOT);
          job.proposalIds.push(proposal.id);
          job.proposed++;
          job.amount += denial.amount;
        }
      } catch (error) {
        job.skipped++;
        job.errors.push(`${item.id}: ${(error as Error).message}`);
      }
      job.processed++;
    }
    job.status = "done";
    job.current = undefined;
    job.finishedAt = new Date().toISOString();
    await this.save(job);
    if (job.proposed)
      await this.platform.notify(
        "approval",
        `Sanad drafted ${job.proposed} appeal${job.proposed === 1 ? "" : "s"} worth AED ${Math.round(job.amount).toLocaleString("en")}. Review them in the inbox.`,
        job.id,
      );
  }
}
