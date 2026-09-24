// Natural-language copilot over claims data (PRD M8.2). Questions become SQL over read-only,
// tenant-scoped views; the answer cites the figures and always shows the query it ran.
import { z } from "zod";
import type { Store } from "../db.ts";
import { AppError } from "../util.ts";
import type { Llm } from "./llm.ts";

export const VIEW_DOCS = `v_claims(claim_id, payer_name, clinician_name, specialty, status, service_date date, submitted_at timestamptz, paid_at timestamptz, gross, patient_share, net, paid_amount, first_pass boolean, historical boolean)
  status in: draft, scrubbed, submitted, acknowledged, rejected, paid, partially_paid, denied, resubmitted, written_off
v_activities(claim_id, payer_name, activity_id, code, code_type, net, paid, denial_code)
v_denials(denial_id, claim_id, payer_name, clinician_name, specialty, denial_code, category, activity_code, amount, status, deadline date, denied_at date, recovered_amount)
  category in: auth, eligibility, coding, medical_necessity, pricing, duplicate, timeliness, documentation
  status in: open, resubmitted, written_off, recovered, lost
v_remittance_lines(line_id, claim_id, payer_name, activity_code, expected, paid, variance, status, settled_at date)
  status in: paid, underpaid, denied, unmatched; variance = expected - paid
payer_name values: 'Nahr Health Insurance', 'Saffron TPA', 'Gulf Crescent Assurance' (match with ILIKE '%nahr%' etc.)
specialty values: GP, Physiotherapy, Dermatology, Orthopaedics, Lab
"This month" means the last 30 days (denied_at > current_date - 30) compared with the 30 days before.`;

export interface CopilotAnswer {
  question: string;
  answer: string;
  sql?: string;
  fields: string[];
  rows: Record<string, unknown>[];
  engine: "sample" | "model";
}

const FORBIDDEN = /\b(records|pg_\w+|information_schema|set_config|current_setting|insert|update|delete|drop|alter|create|grant|copy|truncate|vacuum|call|do)\b|;|--|\/\*/i;

/** Only a single SELECT over the documented views may run, inside a read-only transaction. */
export function guardSql(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(trimmed)) throw new AppError("Copilot queries must be a single SELECT", 422);
  if (FORBIDDEN.test(trimmed)) throw new AppError("Copilot query uses a disallowed statement or table", 422);
  if (!/\bv_(claims|activities|denials|remittance_lines)\b/i.test(trimmed))
    throw new AppError("Copilot queries may only read the analytics views", 422);
  return /\blimit\s+\d+\s*$/i.test(trimmed) ? trimmed : `${trimmed}\nLIMIT 200`;
}

async function run(store: Store, org: string, sql: string) {
  const safe = guardSql(sql);
  const result = await store.readOnly(org, safe);
  const rows = result.rows.map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" && /^-?\d+\.\d+$/.test(v) ? Number(v) : v])),
  );
  return { sql: safe, fields: result.fields, rows };
}

const aed = (v: unknown) => `AED ${Number(v ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const pct = (v: unknown) => `${(Number(v ?? 0) * 100).toFixed(1)}%`;

function payerFilter(question: string): string {
  const m = /(nahr|saffron|gulf)/i.exec(question);
  return m ? ` AND payer_name ILIKE '%${m[1]}%'` : "";
}

interface Intent {
  test: RegExp;
  sql: (q: string) => string;
  answer: (rows: Record<string, any>[], q: string) => string;
}

const INTENTS: Intent[] = [
  {
    test: /underpa(y|id|ys)/i,
    sql: (q) => `SELECT payer_name, count(*) AS lines, sum(variance) AS underpaid_aed, round(avg(variance), 2) AS avg_variance
FROM v_remittance_lines WHERE status = 'underpaid'${payerFilter(q)}
GROUP BY payer_name ORDER BY underpaid_aed DESC`,
    answer: (rows) =>
      rows.length
        ? `${rows[0].payer_name} underpays you most: ${aed(rows[0].underpaid_aed)} across ${rows[0].lines} remittance lines (average ${aed(rows[0].avg_variance)} short per line). ${rows.slice(1).map((r) => `${r.payer_name}: ${aed(r.underpaid_aed)} (${r.lines} lines)`).join("; ")}.`
        : "No underpaid remittance lines found.",
  },
  {
    test: /why .*denial|denials? .*(rise|rising|increase|up|jump|spike)/i,
    sql: (q) => `SELECT category, specialty,
  count(*) FILTER (WHERE denied_at > current_date - 30) AS last_30_days,
  count(*) FILTER (WHERE denied_at <= current_date - 30 AND denied_at > current_date - 60) AS prior_30_days
FROM v_denials WHERE denied_at > current_date - 60${payerFilter(q)}
GROUP BY category, specialty ORDER BY last_30_days DESC`,
    answer: (rows, q) => {
      const total = rows.reduce((s, r) => s + Number(r.last_30_days), 0);
      const prior = rows.reduce((s, r) => s + Number(r.prior_30_days), 0);
      if (!total) return "No denials in the last 30 days.";
      const byCat = new Map<string, number>();
      for (const r of rows) byCat.set(r.category, (byCat.get(r.category) ?? 0) + Number(r.last_30_days));
      const [topCat, topN] = [...byCat.entries()].sort((a, b) => b[1] - a[1])[0];
      const inCat = rows.filter((r) => r.category === topCat).sort((a, b) => b.last_30_days - a.last_30_days);
      const topSpec = inCat[0];
      const who = /(nahr|saffron|gulf)/i.exec(q)?.[1];
      return `${who ? `${who[0].toUpperCase()}${who.slice(1)} denials` : "Denials"} went from ${prior} to ${total} in the last 30 days (${prior ? `${total >= prior ? "+" : ""}${Math.round(((total - prior) / prior) * 100)}%` : "new"}). ${Math.round((topN / total) * 100)}% are ${topCat.replace("_", " ")}-related, concentrated in ${topSpec.specialty} (${topSpec.last_30_days} of ${topN}).`;
    },
  },
  {
    test: /first.?pass|clean claim rate/i,
    sql: (q) => `SELECT payer_name, count(*) FILTER (WHERE first_pass) AS first_pass, count(*) AS submitted,
  round(avg(CASE WHEN first_pass THEN 1 ELSE 0 END), 3) AS first_pass_rate
FROM v_claims WHERE submitted_at IS NOT NULL${payerFilter(q)}
GROUP BY payer_name ORDER BY first_pass_rate ASC`,
    answer: (rows) => rows.map((r) => `${r.payer_name}: ${pct(r.first_pass_rate)} (${r.first_pass}/${r.submitted})`).join("; "),
  },
  {
    test: /denial rate|deny the most|most denials/i,
    sql: (q) => `SELECT payer_name, count(*) FILTER (WHERE status IN ('denied','partially_paid') OR first_pass = false) AS denied_or_partial,
  count(*) AS submitted, round(avg(CASE WHEN first_pass THEN 0 ELSE 1 END), 3) AS denial_rate
FROM v_claims WHERE submitted_at IS NOT NULL${payerFilter(q)}
GROUP BY payer_name ORDER BY denial_rate DESC`,
    answer: (rows) => `Highest denial rate: ${rows[0]?.payer_name} at ${pct(rows[0]?.denial_rate)}. ${rows.slice(1).map((r) => `${r.payer_name} ${pct(r.denial_rate)}`).join(", ")}.`,
  },
  {
    test: /(top|common|main) (denial )?reasons?|why .*denied/i,
    sql: (q) => `SELECT denial_code, category, count(*) AS denials, sum(amount) AS amount_aed
FROM v_denials WHERE denied_at > current_date - 90${payerFilter(q)}
GROUP BY denial_code, category ORDER BY amount_aed DESC LIMIT 5`,
    answer: (rows) => `Top denial reasons in the last 90 days by value: ${rows.map((r) => `${r.denial_code} (${r.category.replace("_", " ")}) ${aed(r.amount_aed)} over ${r.denials}`).join("; ")}.`,
  },
  {
    test: /doctor|clinician|physician/i,
    sql: (q) => `SELECT clinician_name, count(*) AS denials, sum(amount) AS amount_aed, mode() WITHIN GROUP (ORDER BY category) AS main_category
FROM v_denials WHERE denied_at > current_date - 90${payerFilter(q)}
GROUP BY clinician_name ORDER BY amount_aed DESC`,
    answer: (rows) => `By clinician (90 days): ${rows.slice(0, 4).map((r) => `${r.clinician_name} ${aed(r.amount_aed)} (${r.denials}, mostly ${String(r.main_category).replace("_", " ")})`).join("; ")}.`,
  },
  {
    test: /at risk|deadline|expir/i,
    sql: (q) => `SELECT payer_name, count(*) AS open_denials, sum(amount) AS amount_aed, min(deadline) AS earliest_deadline
FROM v_denials WHERE status = 'open' AND deadline <= current_date + 14${payerFilter(q)}
GROUP BY payer_name ORDER BY amount_aed DESC`,
    answer: (rows) =>
      rows.length
        ? `${aed(rows.reduce((s, r) => s + Number(r.amount_aed), 0))} in open denials hits its resubmission deadline within 14 days: ${rows.map((r) => `${r.payer_name} ${aed(r.amount_aed)} (${r.open_denials}, first ${String(r.earliest_deadline).slice(0, 10)})`).join("; ")}.`
        : "No open denials are within 14 days of their deadline.",
  },
  {
    test: /a\/r|receivable|outstanding|owed|aging|ageing/i,
    sql: (q) => `SELECT payer_name,
  sum(net) FILTER (WHERE current_date - submitted_at::date <= 30) AS d0_30,
  sum(net) FILTER (WHERE current_date - submitted_at::date BETWEEN 31 AND 60) AS d31_60,
  sum(net) FILTER (WHERE current_date - submitted_at::date BETWEEN 61 AND 90) AS d61_90,
  sum(net) FILTER (WHERE current_date - submitted_at::date > 90) AS d90_plus,
  sum(net) AS total
FROM v_claims WHERE status IN ('submitted','acknowledged','resubmitted')${payerFilter(q)}
GROUP BY payer_name ORDER BY total DESC`,
    answer: (rows) => `Outstanding A/R: ${aed(rows.reduce((s, r) => s + Number(r.total ?? 0), 0))}. ${rows.map((r) => `${r.payer_name} ${aed(r.total)} (90+ days: ${aed(r.d90_plus)})`).join("; ")}.`,
  },
];

export const EXAMPLE_QUESTIONS = [
  "Which payer underpays us most?",
  "Why did Nahr denials rise this month?",
  "What is our first-pass rate by payer?",
  "Which denials are at risk of missing the deadline?",
  "What are the top denial reasons?",
  "How much A/R is outstanding by payer?",
  "Which denials should I work first?",
  "Draft appeals for Nahr denials",
  "What does MNEC-003 mean?",
];

const SqlOutput = z.object({ sql: z.string(), purpose: z.string() });
const AnswerOutput = z.object({ answer: z.string() });

export async function askCopilot(llm: Llm, store: Store, org: string, question: string): Promise<CopilotAnswer> {
  if (llm.enabled) {
    try {
      const answer = await modelCopilot(llm, store, org, question);
      // An empty result usually means a mis-specified filter; the intent engine is a safer answer.
      if (answer.rows.length || !INTENTS.some((i) => i.test.test(question))) return answer;
    } catch (error) {
      console.warn(`[copilot] model path failed, using intent engine: ${(error as Error).message}`);
    }
  }
  {
    const intent = INTENTS.find((i) => i.test.test(question));
    if (!intent)
      return {
        question,
        answer: `I can answer questions about underpayments, denial trends, first-pass and denial rates, deadlines, clinicians and A/R. Try: ${EXAMPLE_QUESTIONS.slice(0, 3).map((q) => `"${q}"`).join(", ")}.`,
        fields: [],
        rows: [],
        engine: "sample",
      };
    const result = await run(store, org, intent.sql(question));
    return { question, answer: intent.answer(result.rows as Record<string, any>[], question), ...result, engine: "sample" };
  }
}

async function modelCopilot(llm: Llm, store: Store, org: string, question: string): Promise<CopilotAnswer> {
  const gen = await llm.structured({
    task: "copilot-sql",
    schema: SqlOutput,
    system: `You translate a clinic finance question into ONE PostgreSQL SELECT over these read-only views (no other tables exist):\n${VIEW_DOCS}\nUse current_date for relative dates. Aggregate; return at most 20 rows. Amounts are AED.`,
    user: question,
    effort: "low",
    maxTokens: 2048,
  });
  const result = await run(store, org, gen.sql);
  const answer = await llm.structured({
    task: "copilot-answer",
    schema: AnswerOutput,
    system:
      "Answer the clinic finance question in 1-3 sentences using ONLY the query result given. Quote the exact figures from the rows (AED, counts, percentages). If the result is empty or does not answer the question, say so.",
    user: `Question: ${question}\nSQL: ${result.sql}\nRows (JSON): ${JSON.stringify(result.rows.slice(0, 50))}`,
    effort: "low",
    maxTokens: 1024,
  });
  return { question, answer: answer.answer, ...result, engine: "model" };
}
