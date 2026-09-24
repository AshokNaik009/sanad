// Regulator reference data from DOH Abu Dhabi (Shafafiya dictionary, public downloads):
// denial codes, the drug list with public prices, the drug reference price list and the
// e-claim XSDs. Snapshots are committed under data/ref so the app runs offline; the manifest
// records where each came from and a hash of the parsed content, which Regulator Watch compares.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../util.ts";
import { readWorkbook, recordsByHeader } from "./xlsx.ts";

export const REF_DIR = join(dirname(fileURLToPath(import.meta.url)), "ref");

const DOH = "https://www.doh.gov.ae/-/media/Feature/shafifya";

export interface Source {
  name: string;
  label: string;
  url: string;
  file: string;
  parse: (bytes: Uint8Array) => Promise<{ content: string; records: number }>;
}

export interface ManifestEntry {
  name: string;
  label: string;
  url: string;
  file: string;
  records: number;
  /** sha256 of the parsed snapshot: stable across re-downloads of an unchanged list. */
  contentSha256: string;
  downloadedBytes: number;
  fetchedAt: string;
}

export interface Manifest {
  publisher: string;
  fetchedAt: string;
  sources: ManifestEntry[];
}

export interface DenialCodeRef {
  code: string;
  text: string;
  type: string;
  effective: string;
}

/** Compact table: one header row, then value rows (keeps a 20k-row list small in git). */
export interface Table {
  columns: string[];
  rows: (string | number)[][];
}

const num = (s: string) => {
  const n = Number(String(s).replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const excelDate = (s: string) => {
  const n = Number(s);
  if (Number.isFinite(n) && n > 20000 && n < 80000) return new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);
  return s.slice(0, 10);
};
const json = (value: unknown) => `${JSON.stringify(value, null, 1)}\n`;
/** One row per line: diff-friendly and a third of the indented size. */
const tableJson = (table: Table) => `{"columns":${JSON.stringify(table.columns)},"rows":[\n${table.rows.map((r) => JSON.stringify(r)).join(",\n")}\n]}\n`;

async function parseDenialCodes(bytes: Uint8Array) {
  const sheet = (await readWorkbook(bytes)).get("Denial");
  if (!sheet) throw new Error("Denial sheet missing from the DOH code workbook");
  const codes: DenialCodeRef[] = recordsByHeader(sheet, "Code")
    .filter((r) => /^[A-Z]{3,5}-\d{3,4}$/.test(r.Code))
    // DRG-* are inpatient grouper adjustments; outpatient clinics never receive them.
    .filter((r) => !r.Code.startsWith("DRG-"))
    .filter((r) => r.Status !== "Retired" && !r.Expired)
    .map((r) => ({ code: r.Code, text: r.Description.replace(/\s+/g, " ").trim(), type: r.Type, effective: excelDate(r.Effective) }))
    .sort((a, b) => a.code.localeCompare(b.code));
  if (codes.length < 30) throw new Error(`Only ${codes.length} active denial codes parsed; the layout may have changed`);
  return { content: json(codes), records: codes.length };
}

const DRUG_COLUMNS = ["code", "name", "generic", "strength", "form", "pack", "packPrice", "unitPrice", "status"];

async function parseDrugs(bytes: Uint8Array) {
  const sheets = await readWorkbook(bytes);
  const sheet = sheets.get("Drugs") ?? [...sheets.values()].find((s) => s.some((r) => r.includes("Drug Code")));
  if (!sheet) throw new Error("Drug sheet missing from the DOH drug list");
  const rows = recordsByHeader(sheet, "Drug Code")
    .filter((r) => r["Drug Code"] && r.Status !== "Deleted")
    .map((r) => [
      r["Drug Code"],
      r["Package Name"],
      r["Generic Name"],
      r.Strength,
      r["Dosage Form"],
      r["Package Size"],
      num(r["Package Price to Public"]),
      num(r["Unit Price to Public"]),
      r.Status,
    ])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  if (rows.length < 1000) throw new Error(`Only ${rows.length} drugs parsed; the layout may have changed`);
  return { content: tableJson({ columns: DRUG_COLUMNS, rows }), records: rows.length };
}

async function parseReferencePrices(bytes: Uint8Array) {
  const sheets = await readWorkbook(bytes);
  const sheet = sheets.get("Combined RPL") ?? [...sheets.values()].find((s) => s.some((r) => r.includes("Reference Price/Pack")));
  if (!sheet) throw new Error("Reference price sheet missing");
  const seen = new Set<string>();
  const rows = recordsByHeader(sheet, "Drug Code")
    .filter((r) => r["Drug Code"] && num(r["Reference Price/Pack"]) > 0)
    .filter((r) => !seen.has(r["Drug Code"]) && seen.add(r["Drug Code"]))
    .map((r) => [r["Drug Code"], num(r["Reference Price/Pack"])])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  if (rows.length < 500) throw new Error(`Only ${rows.length} reference prices parsed; the layout may have changed`);
  return { content: tableJson({ columns: ["code", "refPricePack"], rows }), records: rows.length };
}

const xsd = (name: string, path: string): Source => ({
  name: `xsd:${name}`,
  label: `${name} schema`,
  url: `${DOH}/${path}.ashx`,
  file: `xsd/${name}.xsd`,
  parse: async (bytes) => {
    const text = new TextDecoder().decode(bytes).replace(/^﻿/, "");
    if (!/<xs:schema\b/.test(text)) throw new Error(`${name} is not an XML schema`);
    return { content: text, records: (text.match(/<xs:(element|simpleType)\b/g) ?? []).length };
  },
});

export const SOURCES: Source[] = [
  { name: "denial-codes", label: "Denial codes", url: `${DOH}/dictionary/Codes.ashx`, file: "denial-codes.json", parse: parseDenialCodes },
  { name: "drugs", label: "Drug list and public prices", url: "https://shafafiyaportal.doh.gov.ae/dictionary/DrugCoding/Drugs.xlsx", file: "drugs.json", parse: parseDrugs },
  { name: "ref-prices", label: "Drug reference prices", url: `${DOH}/dictionary/Reference-Price-List-All-Phases.ashx`, file: "ref-prices.json", parse: parseReferencePrices },
  xsd("ClaimSubmission", "XSDs/ClaimSubmission"),
  xsd("RemittanceAdvice", "XSDs/RemittanceAdvice"),
  xsd("PriorRequest", "XSDs/PriorRequest"),
  xsd("PriorAuthorization", "XSDs/PriorAuthorization"),
  xsd("CommonTypes", "PTE/XSD/CommonTypes"),
];

export type Fetcher = (url: string) => Promise<Uint8Array>;

export const httpFetcher: Fetcher = async (url) => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    // The regulator's portal occasionally drops a connection; back off and retry.
    if (attempt) await new Promise((r) => setTimeout(r, attempt * 1500));
    try {
      const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Sanad reference import)" }, signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Download failed for ${url}: ${(lastError as Error).message}`);
};

export interface FetchedSource {
  source: Source;
  content: string;
  entry: ManifestEntry;
}

export async function fetchSource(source: Source, fetcher: Fetcher = httpFetcher): Promise<FetchedSource> {
  const bytes = await fetcher(source.url);
  const { content, records } = await source.parse(bytes);
  return {
    source,
    content,
    entry: {
      name: source.name,
      label: source.label,
      url: source.url,
      file: source.file,
      records,
      contentSha256: sha256(content),
      downloadedBytes: bytes.byteLength,
      fetchedAt: new Date().toISOString(),
    },
  };
}

export function readManifest(dir = REF_DIR): Manifest | null {
  try {
    return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
  } catch {
    return null;
  }
}

/** Writes snapshot files and merges their entries into the manifest. */
export async function saveSources(fetched: FetchedSource[], dir = REF_DIR): Promise<Manifest> {
  await mkdir(join(dir, "xsd"), { recursive: true });
  for (const f of fetched) await writeFile(join(dir, f.source.file), f.content);
  const previous = readManifest(dir);
  const byName = new Map((previous?.sources ?? []).map((s) => [s.name, s]));
  for (const f of fetched) byName.set(f.entry.name, f.entry);
  const manifest: Manifest = {
    publisher: "Department of Health Abu Dhabi (Shafafiya)",
    fetchedAt: new Date().toISOString(),
    sources: SOURCES.map((s) => byName.get(s.name)).filter((s): s is ManifestEntry => !!s),
  };
  await writeFile(join(dir, "manifest.json"), json(manifest));
  return manifest;
}

export async function readSnapshot(file: string, dir = REF_DIR): Promise<string | null> {
  return readFile(join(dir, file), "utf8").catch(() => null);
}
