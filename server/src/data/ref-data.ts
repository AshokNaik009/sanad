// In-memory view of the committed DOH snapshots (see ref-import.ts). Loaded once at start-up;
// Regulator Watch calls reloadRefData() after it saves newer lists.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REF_DIR, readManifest, type DenialCodeRef, type Manifest, type Table } from "./ref-import.ts";

export interface DrugRef {
  code: string;
  name: string;
  generic: string;
  strength: string;
  form: string;
  pack: string;
  packPrice: number;
  unitPrice: number;
  status: string;
  /** DOH reference price per pack, when the drug is in a reference-priced group. */
  refPricePack?: number;
}

interface RefData {
  manifest: Manifest | null;
  denialCodes: DenialCodeRef[];
  drugs: Map<string, DrugRef>;
}

function readJson<T>(dir: string, file: string): T | null {
  try {
    return JSON.parse(readFileSync(join(dir, file), "utf8")) as T;
  } catch {
    return null;
  }
}

function rowsOf(table: Table | null): Record<string, string | number>[] {
  if (!table) return [];
  return table.rows.map((row) => Object.fromEntries(table.columns.map((c, i) => [c, row[i]])));
}

function load(dir: string): RefData {
  const refPrices = new Map(rowsOf(readJson<Table>(dir, "ref-prices.json")).map((r) => [String(r.code), Number(r.refPricePack)]));
  const drugs = new Map<string, DrugRef>();
  for (const r of rowsOf(readJson<Table>(dir, "drugs.json"))) {
    const code = String(r.code);
    drugs.set(code, {
      code,
      name: String(r.name),
      generic: String(r.generic),
      strength: String(r.strength),
      form: String(r.form),
      pack: String(r.pack),
      packPrice: Number(r.packPrice),
      unitPrice: Number(r.unitPrice),
      status: String(r.status),
      refPricePack: refPrices.get(code),
    });
  }
  return { manifest: readManifest(dir), denialCodes: readJson<DenialCodeRef[]>(dir, "denial-codes.json") ?? [], drugs };
}

let state = load(REF_DIR);

export function reloadRefData(dir = REF_DIR): void {
  state = load(dir);
}

export const refManifest = () => state.manifest;
export const refDenialCodes = () => state.denialCodes;
export const refDrug = (code: string) => state.drugs.get(code);
export const refDrugCount = () => state.drugs.size;

/** Short label for a DOH drug record, e.g. "PENAMOX 500 mg Capsules (20's)". */
export function drugLabel(d: DrugRef): string {
  return `${d.name} ${d.strength} ${d.form.trim()} (${d.pack})`.replace(/\s+/g, " ");
}
