// Append-only, hash-chained audit log. Each event includes the previous event's hash, so an
// edit or deletion anywhere in the chain is detectable by verify().
import type { Store } from "../db.ts";
import type { AuditEvent, Role } from "../domain/types.ts";
import { sha256, stableStringify } from "../util.ts";

export interface Actor {
  id: string;
  role: Role | "system";
}

export class AuditLog {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: Store) {}

  record(
    org: string,
    actor: Actor,
    action: string,
    entity: string,
    entityId: string,
    before?: unknown,
    after?: unknown,
  ): Promise<AuditEvent> {
    const run = this.queue.then(async () => {
      const head = await this.store.get<{ id: string; seq: number; hash: string }>(org, "meta", "audit_head");
      const seq = (head?.seq ?? 0) + 1;
      const base = {
        id: `aud_${String(seq).padStart(8, "0")}`,
        seq,
        actor: actor.id,
        role: actor.role,
        action,
        entity,
        entityId,
        before,
        after,
        at: new Date().toISOString(),
        prevHash: head?.hash ?? "genesis",
      };
      const event: AuditEvent = { ...base, hash: sha256(stableStringify(base)) };
      if (!(await this.store.insert(org, "audit", event)))
        throw new Error("Audit sequence conflict");
      await this.store.put(org, "meta", { id: "audit_head", seq, hash: event.hash });
      return event;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async forEntity(org: string, entityId: string): Promise<AuditEvent[]> {
    const events = await this.store.find<AuditEvent>(org, "audit", { entityId });
    return events.sort((a, b) => a.seq - b.seq);
  }

  async verify(org: string): Promise<{ ok: boolean; count: number; brokenAt?: number }> {
    const events = (await this.store.list<AuditEvent>(org, "audit")).sort((a, b) => a.seq - b.seq);
    let prev = "genesis";
    for (const e of events) {
      const { hash, ...base } = e;
      if (e.prevHash !== prev || sha256(stableStringify(base)) !== hash)
        return { ok: false, count: events.length, brokenAt: e.seq };
      prev = hash;
    }
    return { ok: true, count: events.length };
  }
}
