// Dashboard (M8.1), reconciliation (M6), cash-flow forecast and financing readiness (M9).
import ExcelJS from "exceljs";
import { CATEGORY_LABEL, PAYERS } from "../data/reference.ts";
import type {
  AiSuggestionLog,
  Claim,
  Denial,
  DenialCategory,
  RemittanceLine,
} from "../domain/types.ts";
import { addDays, daysBetween, isoDate, round2 } from "../util.ts";
import type { Platform } from "./platform.ts";

export interface Filters {
  payerId?: string;
  clinicianId?: string;
  from?: string;
  to?: string;
}

const OUTSTANDING = new Set(["submitted", "acknowledged", "resubmitted"]);

function applyFilters<T extends { payerId: string; serviceDate?: string; clinicianId?: string }>(items: T[], f: Filters): T[] {
  return items.filter(
    (i) =>
      (!f.payerId || i.payerId === f.payerId) &&
      (!f.clinicianId || i.clinicianId === f.clinicianId) &&
      (!f.from || !i.serviceDate || i.serviceDate >= f.from) &&
      (!f.to || !i.serviceDate || i.serviceDate <= f.to),
  );
}

export async function dashboard(platform: Platform, f: Filters) {
  const { store, org } = platform;
  const today = platform.today();
  const claims = applyFilters(await store.list<Claim>(org, "claims"), f);
  const claimIds = new Set(claims.map((c) => c.id));
  const denials = (await store.list<Denial>(org, "denials")).filter((d) => claimIds.has(d.claimId));
  const submitted = claims.filter((c) => c.submittedAt);
  const adjudicated = submitted.filter((c) => c.firstPass !== undefined);
  const firstPassRate = adjudicated.length ? adjudicated.filter((c) => c.firstPass).length / adjudicated.length : 0;
  const deniedClaims = new Set(denials.map((d) => d.claimId));
  const denialRate = adjudicated.length ? adjudicated.filter((c) => deniedClaims.has(c.id)).length / adjudicated.length : 0;

  const outstanding = claims.filter((c) => OUTSTANDING.has(c.status));
  const buckets = ["0-30", "31-60", "61-90", "90+"] as const;
  const bucketOf = (c: Claim) => {
    const age = daysBetween(c.submittedAt ?? c.serviceDate, today);
    return age <= 30 ? "0-30" : age <= 60 ? "31-60" : age <= 90 ? "61-90" : "90+";
  };
  const arAging = PAYERS.map((p) => {
    const row: Record<string, number | string> = { payer: p.name, payerId: p.id };
    for (const b of buckets) row[b] = 0;
    for (const c of outstanding.filter((c) => c.payerId === p.id)) row[bucketOf(c)] = round2(Number(row[bucketOf(c)]) + c.net);
    row.total = round2(buckets.reduce((s, b) => s + Number(row[b]), 0));
    return row;
  });
  const openDenials = denials.filter((d) => d.status === "open");
  const atRisk = openDenials.filter((d) => daysBetween(today, d.deadline) <= 14 && daysBetween(today, d.deadline) >= 0);

  const groupRate = (key: (c: Claim) => string) => {
    const map = new Map<string, { submitted: number; denied: number; amount: number }>();
    for (const c of adjudicated) {
      const k = key(c);
      const row = map.get(k) ?? { submitted: 0, denied: 0, amount: 0 };
      row.submitted++;
      if (deniedClaims.has(c.id)) row.denied++;
      map.set(k, row);
    }
    for (const d of denials) {
      const c = claims.find((x) => x.id === d.claimId);
      if (!c) continue;
      const row = map.get(key(c));
      if (row) row.amount = round2(row.amount + d.amount);
    }
    return [...map.entries()]
      .map(([name, r]) => ({ name, ...r, rate: r.submitted ? r.denied / r.submitted : 0 }))
      .sort((a, b) => b.rate - a.rate);
  };
  const codeMap = new Map<string, { denials: number; amount: number }>();
  for (const d of denials) {
    const r = codeMap.get(d.activityCode) ?? { denials: 0, amount: 0 };
    r.denials++;
    r.amount = round2(r.amount + d.amount);
    codeMap.set(d.activityCode, r);
  }
  const reasons = new Map<DenialCategory, { count: number; amount: number }>();
  for (const d of denials.filter((d) => daysBetween(d.deniedAt, today) <= 90)) {
    const r = reasons.get(d.category) ?? { count: 0, amount: 0 };
    r.count++;
    r.amount = round2(r.amount + d.amount);
    reasons.set(d.category, r);
  }
  // Monthly trend (last 12 months): submitted value, paid value, denial rate.
  const months: { month: string; submitted: number; paid: number; denialRate: number; claims: number }[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - i);
    const key = d.toISOString().slice(0, 7);
    const inMonth = adjudicated.filter((c) => c.serviceDate.startsWith(key));
    months.push({
      month: key,
      submitted: round2(inMonth.reduce((s, c) => s + c.net, 0)),
      paid: round2(inMonth.reduce((s, c) => s + (c.paidAmount ?? 0), 0)),
      denialRate: inMonth.length ? inMonth.filter((c) => deniedClaims.has(c.id)).length / inMonth.length : 0,
      claims: inMonth.length,
    });
  }
  const ai = await store.list<AiSuggestionLog>(org, "ai_suggestions");
  const decided = ai.filter((a) => a.outcome !== "pending");
  const byTask = new Map<string, { decided: number; accepted: number }>();
  for (const a of decided) {
    const r = byTask.get(a.task) ?? { decided: 0, accepted: 0 };
    r.decided++;
    if (a.outcome === "accepted") r.accepted++;
    byTask.set(a.task, r);
  }
  return {
    kpis: {
      outstandingAr: round2(outstanding.reduce((s, c) => s + c.net, 0)),
      firstPassRate,
      denialRate,
      aedAtRisk: round2(atRisk.reduce((s, d) => s + d.amount, 0)),
      openDenials: openDenials.length,
      openDenialAmount: round2(openDenials.reduce((s, d) => s + d.amount, 0)),
      aiAcceptance: decided.length ? decided.filter((a) => a.outcome === "accepted").length / decided.length : null,
      claimsAdjudicated: adjudicated.length,
      draftClaims: claims.filter((c) => c.status === "draft" || c.status === "scrubbed").length,
    },
    arAging,
    denialByPayer: groupRate((c) => c.payerName),
    denialByDoctor: groupRate((c) => c.clinicianName),
    denialByCode: [...codeMap.entries()].map(([code, r]) => ({ code, ...r })).sort((a, b) => b.amount - a.amount).slice(0, 8),
    topReasons: [...reasons.entries()].map(([category, r]) => ({ category, label: CATEGORY_LABEL[category], ...r })).sort((a, b) => b.amount - a.amount),
    // Months with too few adjudicated claims (e.g. the current one) would show a misleading rate.
    trend: months.filter((m) => m.claims >= 20),
    aiQuality: [...byTask.entries()].map(([task, r]) => ({ task, ...r, rate: r.accepted / r.decided })),
  };
}

export async function reconciliation(platform: Platform) {
  const { store, org } = platform;
  const lines = (await store.list<RemittanceLine>(org, "remittance_lines")).filter(
    (l) => daysBetween(l.settledAt, platform.today()) <= 120,
  );
  const claims = await store.list<Claim>(org, "claims");
  const pending = claims.filter((c) => OUTSTANDING.has(c.status));
  const perPayer = PAYERS.map((p) => {
    const ls = lines.filter((l) => l.payerId === p.id);
    return {
      payerId: p.id,
      payer: p.name,
      paid: round2(ls.reduce((s, l) => s + l.paid, 0)),
      denied: round2(ls.filter((l) => l.status === "denied").reduce((s, l) => s + (l.expected - l.paid), 0)),
      underpaid: round2(ls.filter((l) => l.status === "underpaid").reduce((s, l) => s + l.variance, 0)),
      pending: round2(pending.filter((c) => c.payerId === p.id).reduce((s, c) => s + c.net, 0)),
      lines: ls.length,
    };
  });
  const matched = lines.filter((l) => l.matched).length;
  return {
    windowDays: 120,
    threshold: platform.config.underpaymentThreshold,
    matchRate: lines.length ? matched / lines.length : 1,
    totals: perPayer,
    underpayments: lines.filter((l) => l.status === "underpaid").sort((a, b) => b.variance - a.variance),
    unmatched: lines.filter((l) => !l.matched),
    recent: lines.sort((a, b) => b.settledAt.localeCompare(a.settledAt)).slice(0, 50),
  };
}

export async function reconciliationWorkbook(platform: Platform): Promise<Buffer> {
  const { store, org } = platform;
  const lines = await store.list<RemittanceLine>(org, "remittance_lines");
  const rec = await reconciliation(platform);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Sanad";
  wb.created = new Date();
  const columns = [
    { header: "Claim ID", key: "claimId", width: 22 },
    { header: "Activity", key: "activityCode", width: 12 },
    { header: "Payer", key: "payerName", width: 26 },
    { header: "Settled", key: "settledAt", width: 12 },
    { header: "Payment ref", key: "paymentReference", width: 30 },
    { header: "Expected (AED)", key: "expected", width: 15 },
    { header: "Paid (AED)", key: "paid", width: 13 },
    { header: "Variance (AED)", key: "variance", width: 15 },
    { header: "Denial code", key: "denialCode", width: 12 },
  ];
  const sheet = (name: string, rows: RemittanceLine[]) => {
    const ws = wb.addWorksheet(name);
    ws.columns = columns;
    ws.getRow(1).font = { bold: true };
    for (const l of rows) ws.addRow({ ...l, settledAt: l.settledAt.slice(0, 10) });
    for (const k of ["expected", "paid", "variance"]) ws.getColumn(k).numFmt = "#,##0.00";
    ws.views = [{ state: "frozen", ySplit: 1 }];
  };
  const summary = wb.addWorksheet("Summary");
  summary.columns = [
    { header: "Payer", key: "payer", width: 26 },
    { header: "Paid", key: "paid", width: 14 },
    { header: "Denied", key: "denied", width: 14 },
    { header: "Underpaid", key: "underpaid", width: 14 },
    { header: "Pending", key: "pending", width: 14 },
  ];
  summary.getRow(1).font = { bold: true };
  for (const t of rec.totals) summary.addRow(t);
  summary.addRow({});
  summary.addRow({ payer: `Match rate: ${(rec.matchRate * 100).toFixed(1)}%; underpayment threshold AED ${rec.threshold}` });
  sheet("Paid", lines.filter((l) => l.status === "paid"));
  sheet("Denied", lines.filter((l) => l.status === "denied"));
  sheet("Variance", lines.filter((l) => l.status === "underpaid" || l.status === "unmatched"));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** 30/60/90-day receipts forecast from historical payment lag and denial probability. */
export async function forecast(platform: Platform) {
  const { store, org } = platform;
  const today = platform.today();
  const claims = await store.list<Claim>(org, "claims");
  const assumptions: string[] = [];
  const perPayer = PAYERS.map((p) => {
    const hist = claims.filter((c) => c.payerId === p.id && c.paidAt && c.submittedAt);
    const lags = hist.map((c) => daysBetween(c.submittedAt as string, c.paidAt as string)).sort((a, b) => a - b);
    const medianLag = lags.length ? lags[Math.floor(lags.length / 2)] : p.paymentLagDays;
    const adjudicated = claims.filter((c) => c.payerId === p.id && c.firstPass !== undefined);
    const paidRatio = adjudicated.length
      ? adjudicated.reduce((s, c) => s + (c.paidAmount ?? 0), 0) / Math.max(1, adjudicated.reduce((s, c) => s + c.net, 0))
      : 0.9;
    assumptions.push(`${p.name}: median ${medianLag} days submission→payment (${lags.length} paid claims); historically pays ${(paidRatio * 100).toFixed(1)}% of billed net.`);
    const open = claims.filter((c) => c.payerId === p.id && OUTSTANDING.has(c.status));
    const bucket = { d30: 0, d60: 0, d90: 0, later: 0 };
    for (const c of open) {
      const expectedDate = addDays(c.submittedAt ?? c.serviceDate, medianLag);
      const inDays = Math.max(0, daysBetween(today, expectedDate));
      const amount = c.net * paidRatio;
      if (inDays <= 30) bucket.d30 += amount;
      else if (inDays <= 60) bucket.d60 += amount;
      else if (inDays <= 90) bucket.d90 += amount;
      else bucket.later += amount;
    }
    return { payerId: p.id, payer: p.name, medianLag, paidRatio: Number(paidRatio.toFixed(3)), d30: round2(bucket.d30), d60: round2(bucket.d60), d90: round2(bucket.d90), later: round2(bucket.later), outstanding: round2(open.reduce((s, c) => s + c.net, 0)) };
  });
  const denials = await store.find<Denial>(org, "denials", { status: "resubmitted" });
  const resubValue = round2(denials.reduce((s, d) => s + d.amount * d.recoveryProbability, 0));
  if (resubValue) assumptions.push(`Resubmitted denials add AED ${resubValue.toFixed(0)} (amount × recovery probability) to the 60-day bucket.`);
  const totals = {
    d30: round2(perPayer.reduce((s, p) => s + p.d30, 0)),
    d60: round2(perPayer.reduce((s, p) => s + p.d60, 0) + resubValue),
    d90: round2(perPayer.reduce((s, p) => s + p.d90, 0)),
  };
  assumptions.push("Claims still in draft are excluded until submitted.");

  // Financing readiness: clean (acknowledged, no open issues), aged < 90 days, payer-diversified.
  const eligible = claims.filter((c) => c.status === "acknowledged" && daysBetween(c.submittedAt ?? c.serviceDate, today) <= 90);
  const byPayer = PAYERS.map((p) => ({ payer: p.name, amount: round2(eligible.filter((c) => c.payerId === p.id).reduce((s, c) => s + c.net, 0)) }));
  const total = byPayer.reduce((s, p) => s + p.amount, 0);
  const hhi = total ? byPayer.reduce((s, p) => s + (p.amount / total) ** 2, 0) : 0;
  return {
    asOf: today,
    totals,
    perPayer,
    assumptions,
    financing: {
      eligibleReceivables: round2(total),
      claimCount: eligible.length,
      byPayer,
      concentrationHhi: Number(hhi.toFixed(3)),
      diversified: hhi < 0.5,
      note: "Eligible = acknowledged by the payer, no open scrub issues, submitted within 90 days.",
    },
  };
}

