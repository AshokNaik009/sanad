// Payer memory: how each insurer has actually treated each service code, learned from adjudicated
// claims (every remittance adds to it). The scrubber attaches the pattern to new claims, so a biller
// sees "this insurer denied 14% of these, 1.8× its usual rate, mostly for missing approval" first.
import { lookupCode } from "../data/codeset.ts";
import { CATEGORY_LABEL, DENIAL_INDEX } from "../data/reference.ts";
import type { Claim, DenialCategory, PayerRisk } from "../domain/types.ts";
import { addDays, isoDate } from "../util.ts";
import type { Platform } from "./platform.ts";

interface Stat {
  total: number;
  denied: number;
  reasons: Map<string, number>;
}

interface Model {
  builtAt: number;
  byPayerCode: Map<string, Stat>;
  byPayer: Map<string, { total: number; denied: number }>;
}

const WINDOW_DAYS = 180;
const MIN_SAMPLE = 12;
/** Flag a service when its denial rate is material and well above the payer's usual rate. */
const MIN_RATE = 0.12;
const LIFT = 1.5;
const TTL_MS = 5 * 60_000;

export class PayerIntel {
  private model?: Model;

  constructor(private readonly platform: Platform) {}

  invalidate(): void {
    this.model = undefined;
  }

  private async build(): Promise<Model> {
    if (this.model && Date.now() - this.model.builtAt < TTL_MS) return this.model;
    const since = isoDate(addDays(this.platform.today(), -WINDOW_DAYS));
    const byPayerCode = new Map<string, Stat>();
    const byPayer = new Map<string, { total: number; denied: number }>();
    for (const claim of await this.platform.store.list<Claim>(this.platform.org, "claims")) {
      if (claim.serviceDate < since) continue;
      for (const a of claim.activities) {
        if (a.paid === undefined && !a.denialCode) continue;
        const key = `${claim.payerId}|${a.code}`;
        const stat = byPayerCode.get(key) ?? { total: 0, denied: 0, reasons: new Map() };
        const payer = byPayer.get(claim.payerId) ?? { total: 0, denied: 0 };
        stat.total++;
        payer.total++;
        if (a.denialCode) {
          stat.denied++;
          payer.denied++;
          stat.reasons.set(a.denialCode, (stat.reasons.get(a.denialCode) ?? 0) + 1);
        }
        byPayerCode.set(key, stat);
        byPayer.set(claim.payerId, payer);
      }
    }
    this.model = { builtAt: Date.now(), byPayerCode, byPayer };
    return this.model;
  }

  /** Overall denial rate for a payer over the window, or undefined without enough history. */
  async payerDenialRate(payerId: string): Promise<number | undefined> {
    const p = (await this.build()).byPayer.get(payerId);
    return p && p.total >= MIN_SAMPLE * 3 ? p.denied / p.total : undefined;
  }

  /** Denial patterns for the claim's services that are worth a biller's attention. */
  async risksFor(claim: Claim): Promise<PayerRisk[]> {
    const model = await this.build();
    const risks: PayerRisk[] = [];
    for (const a of claim.activities) {
      const stat = model.byPayerCode.get(`${claim.payerId}|${a.code}`);
      const payer = model.byPayer.get(claim.payerId);
      const usual = payer?.total ? payer.denied / payer.total : 0;
      if (!stat || stat.total < MIN_SAMPLE || stat.denied / stat.total < Math.max(MIN_RATE, usual * LIFT)) continue;
      const [topCode, topCount] = [...stat.reasons.entries()].sort((x, y) => y[1] - x[1])[0];
      const info = DENIAL_INDEX.get(topCode);
      const category: DenialCategory = info?.category ?? "documentation";
      const mitigated = category === "auth" && !!a.priorAuthNumber;
      const rate = stat.denied / stat.total;
      const service = lookupCode(a.code)?.plain ?? a.code;
      risks.push({
        activityId: a.id,
        code: a.code,
        denialRate: Number(rate.toFixed(2)),
        sample: stat.total,
        topReason: topCode,
        topReasonShare: Number((topCount / stat.denied).toFixed(2)),
        category,
        mitigated,
        message: `${claim.payerName} denied ${Math.round(rate * 100)}% of ${service} claims in the last 6 months (${stat.denied} of ${stat.total})${usual > 0 ? `, ${(rate / usual).toFixed(1)}× its usual rate` : ""}. Most often for ${CATEGORY_LABEL[category].toLowerCase()}${info ? `: ${info.plain.replace(/\.$/, "").replace(/^./, (ch) => ch.toLowerCase())}` : ""}.`,
        advice: mitigated ? "This claim already carries a prior approval number." : ADVICE[category],
      });
    }
    return risks;
  }
}

const ADVICE: Record<DenialCategory, string> = {
  auth: "Attach a prior approval number before submitting.",
  eligibility: "Re-check the patient's cover and network on the visit date.",
  coding: "Make sure the claim includes a diagnosis that supports this service.",
  medical_necessity: "Send the clinical justification with the claim (symptoms, failed treatments, findings).",
  pricing: "Bill at the contract price for this insurer.",
  duplicate: "Check this service was not already billed for the same date.",
  timeliness: "Submit well inside the insurer's filing window.",
  documentation: "Attach the supporting notes the insurer usually asks for.",
};
