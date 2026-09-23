// Record store adapted from OpenMuse apps/server/src/db.ts: one JSONB table keyed by
// (owner, kind, id). Here `owner` is the organization, which gives every query a tenant filter.
import { mkdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

type Row = Record<string, unknown>;
const SCHEMA = "sanad";
interface Database {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>;
  /** Runs statements in one read-only transaction on one connection. */
  readOnly: (org: string, sql: string) => Promise<{ rows: Row[]; fields: string[] }>;
  close: () => Promise<void>;
}

export class Store {
  /** list() results per org+kind; every write to that kind invalidates it (single-writer process). */
  private readonly listCache = new Map<string, unknown[]>();
  constructor(private readonly db: Database) {}
  private invalidate(org: string, kind?: string) {
    for (const key of this.listCache.keys())
      if (key.startsWith(`${org}|`) && (!kind || key === `${org}|${kind}`)) this.listCache.delete(key);
  }

  async get<T>(org: string, kind: string, id: string): Promise<T | null> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 AND id=$3",
      [org, kind, id],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async list<T>(org: string, kind: string): Promise<T[]> {
    const key = `${org}|${kind}`;
    const hit = this.listCache.get(key);
    // Callers may mutate what they get back, so hand out copies.
    if (hit) return structuredClone(hit) as T[];
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 ORDER BY updated_at DESC,id",
      [org, kind],
    );
    const rows = result.rows.map((row) => row.data as T);
    this.listCache.set(key, structuredClone(rows));
    return rows;
  }
  async getMany<T>(org: string, kind: string, ids: string[]): Promise<T[]> {
    if (!ids.length) return [];
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 AND id = ANY($3::text[])",
      [org, kind, ids],
    );
    return result.rows.map((row) => row.data as T);
  }
  /** Filter by top-level JSON fields using containment, e.g. { status: "denied" }. */
  async find<T>(org: string, kind: string, match: Record<string, unknown>): Promise<T[]> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 AND data @> $3::jsonb ORDER BY updated_at DESC,id",
      [org, kind, JSON.stringify(match)],
    );
    return result.rows.map((row) => row.data as T);
  }
  async put<T extends { id: string }>(org: string, kind: string, value: T): Promise<T> {
    this.invalidate(org, kind);
    await this.db.query(
      "INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(owner,kind,id) DO UPDATE SET data=excluded.data,updated_at=now()",
      [org, kind, value.id, JSON.stringify(value)],
    );
    // Invalidate again after the write so a read racing the write cannot re-cache stale rows.
    this.invalidate(org, kind);
    return value;
  }
  /** Bulk upsert used by the seed script; one statement per chunk. */
  async putMany<T extends { id: string }>(org: string, kind: string, values: T[]): Promise<void> {
    this.invalidate(org, kind);
    for (let i = 0; i < values.length; i += 500) {
      const chunk = values.slice(i, i + 500);
      await this.db.query(
        `INSERT INTO records(owner,kind,id,data)
         SELECT $1,$2,v->>'id',v FROM jsonb_array_elements($3::jsonb) v
         ON CONFLICT(owner,kind,id) DO UPDATE SET data=excluded.data,updated_at=now()`,
        [org, kind, JSON.stringify(chunk)],
      );
    }
    this.invalidate(org, kind);
  }
  /** Insert-only write; returns false when the id already exists (idempotent intake, audit). */
  async insert<T extends { id: string }>(org: string, kind: string, value: T): Promise<boolean> {
    this.invalidate(org, kind);
    const result = await this.db.query(
      "INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING id",
      [org, kind, value.id, JSON.stringify(value)],
    );
    this.invalidate(org, kind);
    return result.rows.length === 1;
  }
  async remove(org: string, kind: string, id: string): Promise<void> {
    this.invalidate(org, kind);
    await this.db.query("DELETE FROM records WHERE owner=$1 AND kind=$2 AND id=$3", [org, kind, id]);
  }
  async clear(org: string): Promise<void> {
    this.invalidate(org);
    await this.db.query("DELETE FROM records WHERE owner=$1", [org]);
  }
  async count(org: string, kind: string): Promise<number> {
    const result = await this.db.query(
      "SELECT count(*)::int AS n FROM records WHERE owner=$1 AND kind=$2",
      [org, kind],
    );
    return Number(result.rows[0]?.n ?? 0);
  }
  /** Tenant-scoped read-only SQL over the analytics views (copilot text-to-SQL). */
  readOnly(org: string, sql: string) {
    return this.db.readOnly(org, sql);
  }
  close(): Promise<void> {
    return this.db.close();
  }
}

// Analytics views read the tenant from a transaction-local setting, so a copilot query
// can only ever see the current organization's rows.
const VIEWS = `
CREATE OR REPLACE VIEW ${SCHEMA}.v_claims AS SELECT
  data->>'id' AS claim_id, data->>'payerId' AS payer_id, data->>'payerName' AS payer_name,
  data->>'clinicianId' AS clinician_id, data->>'clinicianName' AS clinician_name,
  data->>'specialty' AS specialty, data->>'status' AS status,
  (data->>'serviceDate')::date AS service_date, (data->>'submittedAt')::timestamptz AS submitted_at,
  (data->>'paidAt')::timestamptz AS paid_at, (data->>'gross')::numeric AS gross,
  (data->>'patientShare')::numeric AS patient_share, (data->>'net')::numeric AS net,
  (data->>'paidAmount')::numeric AS paid_amount, (data->>'firstPass')::boolean AS first_pass,
  (data->>'historical')::boolean AS historical
FROM ${SCHEMA}.records WHERE kind='claims' AND owner=current_setting('sanad.org', true);
CREATE OR REPLACE VIEW ${SCHEMA}.v_activities AS SELECT
  c.data->>'id' AS claim_id, c.data->>'payerName' AS payer_name, a->>'id' AS activity_id,
  a->>'code' AS code, a->>'codeType' AS code_type, (a->>'net')::numeric AS net,
  (a->>'paid')::numeric AS paid, a->>'denialCode' AS denial_code
FROM ${SCHEMA}.records c, jsonb_array_elements(c.data->'activities') a
WHERE c.kind='claims' AND c.owner=current_setting('sanad.org', true);
CREATE OR REPLACE VIEW ${SCHEMA}.v_denials AS SELECT
  data->>'id' AS denial_id, data->>'claimId' AS claim_id, data->>'payerId' AS payer_id,
  data->>'payerName' AS payer_name,
  data->>'clinicianName' AS clinician_name, data->>'specialty' AS specialty,
  data->>'code' AS denial_code, data->>'category' AS category, data->>'activityCode' AS activity_code,
  (data->>'amount')::numeric AS amount, data->>'status' AS status,
  (data->>'deadline')::date AS deadline, (data->>'deniedAt')::date AS denied_at,
  (data->>'recoveredAmount')::numeric AS recovered_amount
FROM ${SCHEMA}.records WHERE kind='denials' AND owner=current_setting('sanad.org', true);
CREATE OR REPLACE VIEW ${SCHEMA}.v_remittance_lines AS SELECT
  data->>'id' AS line_id, data->>'claimId' AS claim_id, data->>'payerName' AS payer_name,
  data->>'activityCode' AS activity_code, (data->>'expected')::numeric AS expected,
  (data->>'paid')::numeric AS paid, (data->>'variance')::numeric AS variance,
  data->>'status' AS status, (data->>'settledAt')::date AS settled_at
FROM ${SCHEMA}.records WHERE kind='remittance_lines' AND owner=current_setting('sanad.org', true);
`;

export async function createStore(
  options: { dataDir?: string; databaseUrl?: string } = {},
): Promise<Store> {
  let database: Database;
  if (options.databaseUrl) {
    const url = new URL(options.databaseUrl);
    // Managed Postgres (Supabase, RDS, Azure) requires TLS; local Postgres usually does not.
    const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    const pool = new pg.Pool({
      connectionString: options.databaseUrl,
      max: 5,
      ssl: local || url.searchParams.get("sslmode") === "disable" ? undefined : { rejectUnauthorized: false },
      // Keep Sanad tables in their own schema: Supabase exposes `public` through its REST API.
      options: `-c search_path=${SCHEMA}`,
    });
    database = {
      query: async (sql, params) => pool.query(sql, params),
      readOnly: async (org, sql) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN READ ONLY");
          await client.query(`SET LOCAL search_path TO ${SCHEMA}`);
          await client.query("SELECT set_config('sanad.org',$1,true)", [org]);
          await client.query("SET LOCAL statement_timeout = 3000");
          const result = await client.query(sql);
          return { rows: result.rows, fields: result.fields.map((f) => f.name) };
        } finally {
          await client.query("ROLLBACK").catch(() => undefined);
          client.release();
        }
      },
      close: () => pool.end(),
    };
  } else {
    if (options.dataDir) await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    const embedded = new PGlite(options.dataDir);
    await embedded.waitReady;
    await embedded.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await embedded.query(`SET search_path TO ${SCHEMA}`);
    database = {
      query: (sql, params) => embedded.query<Row>(sql, params),
      readOnly: (org, sql) =>
        embedded.transaction(async (tx) => {
          await tx.query("SET TRANSACTION READ ONLY");
          await tx.query("SELECT set_config('sanad.org',$1,true)", [org]);
          const result = await tx.query<Row>(sql);
          await tx.rollback();
          return { rows: result.rows, fields: result.fields.map((f) => f.name) };
        }),
      close: () => embedded.close(),
    };
  }
  await database.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await database.query(
    `CREATE TABLE IF NOT EXISTS ${SCHEMA}.records(owner text NOT NULL,kind text NOT NULL,id text NOT NULL,data jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner,kind,id))`,
  );
  await database.query(
    `CREATE INDEX IF NOT EXISTS records_kind_data ON ${SCHEMA}.records USING gin (data jsonb_path_ops)`,
  );
  // Not reachable through Supabase's Data API (non-exposed schema); RLS on as defence in depth.
  await database.query(`ALTER TABLE ${SCHEMA}.records ENABLE ROW LEVEL SECURITY`);
  // Drop and recreate so view column changes apply on real Postgres, not only on fresh databases.
  await database.query(
    `DROP VIEW IF EXISTS ${SCHEMA}.v_claims, ${SCHEMA}.v_activities, ${SCHEMA}.v_denials, ${SCHEMA}.v_remittance_lines`,
  );
  for (const statement of VIEWS.split(";").map((s) => s.trim()).filter(Boolean))
    await database.query(statement);
  return new Store(database);
}
