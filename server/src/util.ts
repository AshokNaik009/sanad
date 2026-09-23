import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";

export class AppError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503 = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const newId = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

export const round2 = (n: number) => Math.round(n * 100) / 100;

export const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(date: string | Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

export function daysBetween(from: string | Date, to: string | Date): number {
  return Math.floor((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000);
}

export function ageOn(dob: string, on: string): number {
  const b = new Date(dob);
  const d = new Date(on);
  let age = d.getUTCFullYear() - b.getUTCFullYear();
  if (
    d.getUTCMonth() < b.getUTCMonth() ||
    (d.getUTCMonth() === b.getUTCMonth() && d.getUTCDate() < b.getUTCDate())
  )
    age--;
  return age;
}

/** DHA transaction date format: dd/MM/yyyy HH:mm. */
export function dhaDate(value: string | Date): string {
  const d = new Date(value);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function parseDhaDate(value: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) throw new AppError(`Invalid DHA date ${value}`, 422);
  return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5])).toISOString();
}

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Deterministic PRNG (mulberry32) so the synthetic dataset is identical on every reset. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
    chance: (p: number) => next() < p,
  };
}

/** AES-256-GCM for identifiers at rest (Emirates ID). Output: iv.tag.ciphertext (base64url). */
export function encrypt(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

export function decrypt(key: Buffer, value: string): string {
  const [iv, tag, data] = value.split(".").map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export const maskEmiratesId = (id: string) => `${id.slice(0, 4)}-****-*******-${id.slice(-1)}`;

/** Split text into sentences/lines while keeping character offsets. */
export function sentences(text: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  // Boundaries: newlines, and a period followed by whitespace and a capital letter.
  const boundary = /\n|(?<=\.)[ \t]+(?=[A-Z])/g;
  let cursor = 0;
  const push = (from: number, to: number) => {
    const raw = text.slice(from, to);
    const trimmed = raw.trim();
    if (!trimmed) return;
    const start = from + (raw.length - raw.trimStart().length);
    out.push({ start, end: start + trimmed.length, text: trimmed });
  };
  for (const m of text.matchAll(boundary)) {
    push(cursor, m.index);
    cursor = m.index + m[0].length;
  }
  push(cursor, text.length);
  return out;
}

export const normalizeWs = (s: string) => s.replace(/\s+/g, " ").trim();

/** Find a quote in a note tolerant of whitespace differences; returns offsets or null. */
export function locateQuote(note: string, quote: string): { start: number; end: number } | null {
  const q = normalizeWs(quote).replace(/[.;,]$/, "");
  if (q.length < 8) return null;
  const direct = note.indexOf(q);
  if (direct >= 0) return { start: direct, end: direct + q.length };
  const pattern = q
    .split(" ")
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  const m = new RegExp(pattern, "i").exec(note);
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

/** Deterministic JSON (sorted keys, undefined dropped) so hashes survive a JSONB round trip. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v === undefined ? null : v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
