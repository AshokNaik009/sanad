// Minimal .xlsx reader for regulator downloads. The DOH drug list is written by a generator that
// exceljs cannot open (absolute part paths, `x:`-prefixed markup, inline strings), so sheets are
// read straight from the package XML. Returns each sheet as rows of trimmed cell text.
import JSZip from "jszip";

export type Sheet = string[][];

const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

/** Text of every <t> run inside a fragment (shared strings and inline strings). */
const runs = (xml: string) => decode([...xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => m[1]).join(""));

/** "AB12" -> 27 (zero-based column index). */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function partPath(target: string): string {
  return target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
}

export async function readWorkbook(data: Uint8Array): Promise<Map<string, Sheet>> {
  const zip = await JSZip.loadAsync(data);
  const read = async (path: string) => {
    const file = zip.file(path);
    return file ? (await file.async("string")).replace(/^﻿/, "") : "";
  };
  const workbook = await read("xl/workbook.xml");
  const rels = await read("xl/_rels/workbook.xml.rels");
  const targets = new Map(
    [...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => [/\bId="([^"]+)"/.exec(m[1])?.[1] ?? "", /\bTarget="([^"]+)"/.exec(m[1])?.[1] ?? ""]),
  );
  const shared = [...(await read("xl/sharedStrings.xml")).matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((m) => runs(m[1]));

  const sheets = new Map<string, Sheet>();
  for (const m of workbook.matchAll(/<(?:\w+:)?sheet\b([^>]*)\/?>/g)) {
    const name = decode(/\bname="([^"]+)"/.exec(m[1])?.[1] ?? "");
    const rid = /\br:id="([^"]+)"/.exec(m[1])?.[1] ?? "";
    const target = targets.get(rid);
    if (!name || !target) continue;
    const xml = await read(partPath(target));
    const rows: Sheet = [];
    for (const row of xml.matchAll(/<(?:\w+:)?row\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
      const cells: string[] = [];
      let position = 0;
      for (const cell of (row[1] ?? "").matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        const attrs = cell[1];
        const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
        const index = ref ? columnIndex(ref) : position;
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
        const body = cell[2] ?? "";
        const raw = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1] ?? "";
        const value = type === "s" ? (shared[Number(raw)] ?? "") : type === "inlineStr" ? runs(body) : decode(raw);
        cells[index] = value.trim();
        position = index + 1;
      }
      rows.push(Array.from(cells, (c) => c ?? ""));
    }
    sheets.set(name, rows);
  }
  return sheets;
}

/** Rows as objects keyed by the header row; `headerRow` is found by a required column name. */
export function recordsByHeader(sheet: Sheet, requiredColumn: string): Record<string, string>[] {
  const headerAt = sheet.findIndex((row) => row.some((c) => c.toLowerCase() === requiredColumn.toLowerCase()));
  if (headerAt < 0) throw new Error(`Column "${requiredColumn}" not found`);
  const header = sheet[headerAt].map((h) => h.replace(/\s+/g, " ").trim());
  return sheet.slice(headerAt + 1).map((row) => Object.fromEntries(header.map((h, i) => [h, row[i] ?? ""])));
}
