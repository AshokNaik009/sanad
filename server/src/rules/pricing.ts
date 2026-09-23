import { lookupCode } from "../data/codeset.ts";
import { PRICE_OVERRIDES, payerById } from "../data/reference.ts";
import type { Activity, Claim, Patient } from "../domain/types.ts";
import { round2 } from "../util.ts";

/** Facility chargemaster price (what the PMS bills by default). */
export function chargemasterPrice(code: string): number {
  return lookupCode(code)?.tariff ?? 0;
}

/** Payer contract price: tariff x contract factor, with negotiated per-code overrides. */
export function contractPrice(payerId: string, code: string): number {
  const override = PRICE_OVERRIDES[payerId]?.[code];
  if (override !== undefined) return override;
  const tariff = lookupCode(code)?.tariff;
  if (tariff === undefined) return 0;
  return round2(tariff * payerById(payerId).priceFactor);
}

export function planFor(patient: Patient) {
  const payer = payerById(patient.payerId);
  return payer.plans.find((p) => p.name === patient.plan) ?? payer.plans[0];
}

/** Recompute patient share (plan co-pay, capped per visit) and totals. Mutates and returns claim. */
export function recalcTotals(claim: Claim, patient: Patient): Claim {
  const plan = planFor(patient);
  const gross = round2(claim.activities.reduce((sum, a) => sum + a.gross, 0));
  const share = Math.min(round2((gross * plan.copayPercent) / 100), plan.copayCapPerVisit);
  let allocated = 0;
  claim.activities.forEach((a: Activity, i) => {
    const part =
      i === claim.activities.length - 1
        ? round2(share - allocated)
        : gross > 0
          ? round2((share * a.gross) / gross)
          : 0;
    allocated = round2(allocated + part);
    a.patientShare = part;
    a.net = round2(a.gross - part);
  });
  claim.gross = gross;
  claim.patientShare = round2(share);
  claim.net = round2(gross - share);
  return claim;
}
