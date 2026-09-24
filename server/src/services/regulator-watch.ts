// Regulator Watch, after OpenMuse's page watches: re-downloads the DOH lists on a schedule (or on
// demand), compares the parsed content with the committed snapshot, saves what changed, reloads the
// rules in place and reports which open claims and denials the change touches.
import { REF_DIR, SOURCES, fetchSource, httpFetcher, readManifest, readSnapshot, saveSources, type DenialCodeRef, type FetchedSource, type Fetcher, type Source, type Table } from "../data/ref-import.ts";
import { refDenialCodes, refDrugCount, refManifest, reloadRefData } from "../data/ref-data.ts";
import { rebuildDenialCodes } from "../data/reference.ts";
import type { Claim, Denial } from "../domain/types.ts";
import { newId } from "../util.ts";
import { resetXsdCache } from "../xml/xsd-check.ts";
import type { Actor } from "./audit.ts";
import type { Platform } from "./platform.ts";

export interface SourceChange {
  name: string;
  label: string;
  status: "unchanged" | "updated" | "failed";
  records?: number;
  added: string[];
  removed: string[];
  changed: string[];
  error?: string;
}

export interface RegulatorCheck {
  id: string;
  checkedAt: string;
  by: string;
  changes: SourceChange[];
  affectedClaims: string[];
  affectedDenials: string[];
  summary: string;
}

const KIND = "reg_checks";

/** Key → comparable value for each list, so a diff can name what changed. */
function keyed(name: string, content: string | null): Map<string, string> | null {
  if (!content) return null;
  try {
    if (name === "denial-codes") return new Map((JSON.parse(content) as DenialCodeRef[]).map((d) => [d.code, d.text]));
    if (name === "drugs" || name === "ref-prices") {
      const table = JSON.parse(content) as Table;
      const price = table.columns.indexOf(name === "drugs" ? "unitPrice" : "refPricePack");
      const status = table.columns.indexOf("status");
      return new Map(table.rows.map((r) => [String(r[0]), `${r[price]}|${status >= 0 ? r[status] : ""}`]));
    }
  } catch {
    return null;
  }
  return null;
}

function diff(before: Map<string, string> | null, after: Map<string, string> | null) {
  if (!before || !after) return { added: [], removed: [], changed: [] };
  return {
    added: [...after.keys()].filter((k) => !before.has(k)),
    removed: [...before.keys()].filter((k) => !after.has(k)),
    changed: [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k)),
  };
}

const OPEN_CLAIM = new Set(["draft", "scrubbed"]);

export class RegulatorWatch {
  private checking?: Promise<RegulatorCheck>;
  private readonly dir: string;
  private readonly fetcher: Fetcher;
  private readonly sources: Source[];

  constructor(
    private readonly platform: Platform,
    options: { dir?: string; fetcher?: Fetcher; sources?: Source[] } = {},
  ) {
    this.dir = options.dir ?? REF_DIR;
    this.fetcher = options.fetcher ?? httpFetcher;
    this.sources = options.sources ?? SOURCES;
  }

  async status() {
    const manifest = refManifest();
    const checks = await this.platform.store.list<RegulatorCheck>(this.platform.org, KIND);
    return {
      publisher: manifest?.publisher ?? "Department of Health Abu Dhabi",
      updatedAt: manifest?.fetchedAt,
      denialCodes: refDenialCodes().length,
      drugs: refDrugCount(),
      sources: (manifest?.sources ?? []).map(({ label, records, fetchedAt }) => ({ label, records, fetchedAt })),
      lastCheck: checks.sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0] ?? null,
    };
  }

  /** One check at a time; a second caller gets the running check. */
  check(actor: Actor): Promise<RegulatorCheck> {
    this.checking ??= this.run(actor).finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private async run(actor: Actor): Promise<RegulatorCheck> {
    const known = new Map((readManifest(this.dir)?.sources ?? []).map((s) => [s.name, s.contentSha256]));
    const changes: SourceChange[] = [];
    const updated: FetchedSource[] = [];
    for (const source of this.sources) {
      try {
        const fetched = await fetchSource(source, this.fetcher);
        if (known.get(source.name) === fetched.entry.contentSha256) {
          changes.push({ name: source.name, label: source.label, status: "unchanged", records: fetched.entry.records, added: [], removed: [], changed: [] });
          continue;
        }
        const before = keyed(source.name, await readSnapshot(source.file, this.dir));
        changes.push({ name: source.name, label: source.label, status: "updated", records: fetched.entry.records, ...diff(before, keyed(source.name, fetched.content)) });
        updated.push(fetched);
      } catch (error) {
        changes.push({ name: source.name, label: source.label, status: "failed", added: [], removed: [], changed: [], error: (error as Error).message });
      }
    }

    if (updated.length) {
      await saveSources(updated, this.dir);
      reloadRefData(this.dir);
      rebuildDenialCodes();
      resetXsdCache();
    }

    // Which open work does the change touch?
    const touchedDrugs = new Set(changes.filter((c) => c.name === "drugs" || c.name === "ref-prices").flatMap((c) => [...c.removed, ...c.changed]));
    const touchedDenials = new Set(changes.filter((c) => c.name === "denial-codes").flatMap((c) => [...c.removed, ...c.changed]));
    const claims = await this.platform.store.list<Claim>(this.platform.org, "claims");
    const affectedClaims = claims.filter((c) => !c.historical && OPEN_CLAIM.has(c.status) && c.activities.some((a) => touchedDrugs.has(a.code))).map((c) => c.id);
    const denials = await this.platform.store.find<Denial>(this.platform.org, "denials", { status: "open" });
    const affectedDenials = denials.filter((d) => !d.historical && touchedDenials.has(d.code)).map((d) => d.id);

    const updatedLabels = changes.filter((c) => c.status === "updated");
    const failed = changes.filter((c) => c.status === "failed");
    const unreachable = failed.length ? ` Couldn't reach ${failed.map((c) => c.label.toLowerCase()).join(", ")}; the current version stays in place.` : "";
    const summary = updatedLabels.length
      ? `${updatedLabels.map((c) => `${c.label}: ${[c.added.length && `${c.added.length} new`, c.removed.length && `${c.removed.length} removed`, c.changed.length && `${c.changed.length} changed`].filter(Boolean).join(", ") || "updated"}`).join(" · ")}. Affects ${affectedClaims.length} unsubmitted claim(s) and ${affectedDenials.length} open denial(s).${unreachable}`
      : failed.length === changes.length
        ? "Couldn't reach the regulator's website. The current rules stay in place."
        : `No changes since the last update.${unreachable}`;
    const check: RegulatorCheck = { id: newId("reg"), checkedAt: new Date().toISOString(), by: actor.id, changes, affectedClaims, affectedDenials, summary };
    await this.platform.store.put(this.platform.org, KIND, check);
    await this.platform.audit.record(this.platform.org, actor, "rules.check", "rules", check.id, undefined, { updated: updatedLabels.map((c) => c.name), failed: failed.map((c) => c.name), affectedClaims, affectedDenials });
    if (updatedLabels.length) await this.platform.notify("rules", `Regulator lists updated. ${summary}`, check.id);
    return check;
  }

  /** Daily background check; returns a stop function. */
  schedule(intervalMs = 24 * 60 * 60 * 1000): () => void {
    const system: Actor = { id: "system", role: "system" };
    const timer = setInterval(() => void this.check(system).catch((e) => console.warn(`[rules] check failed: ${(e as Error).message}`)), intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}
