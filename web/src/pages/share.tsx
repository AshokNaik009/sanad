import { useEffect, useState } from "react";
import { Logo } from "../App";
import { aed, date } from "../api";

/** Public patient page: no login, minimal data, expiring link. */
export function SharePage({ token }: { token: string }) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/share/${encodeURIComponent(token)}`)
      .then(async (r) => (r.ok ? setData(await r.json()) : setError((await r.json()).error)))
      .catch(() => setError("Could not load this page"));
  }, [token]);
  return (
    <div className="min-h-screen bg-page px-4 py-8">
      <div className="mx-auto max-w-md">
        <div className="mb-6 flex items-center gap-2">
          <Logo size={28} />
          <span className="text-[15px] font-semibold">Your visit, explained</span>
        </div>
        {error && <div className="glass rounded-2xl p-5 text-[14px]">{error}</div>}
        {!data && !error && <div className="h-40 animate-pulse rounded-xl bg-surface-2" />}
        {data?.kind === "bill" && (
          <div className="space-y-4">
            <div className="glass rounded-2xl p-5">
              <p className="text-[15px]">Hello {data.firstName},</p>
              <p className="mt-1 text-[13.5px] text-ink-2">Here is your visit to {data.clinic} on {date(data.visitDate)}, billed to {data.insurer}.</p>
              <ul className="mt-4 space-y-2 text-[14px]">
                {data.services.map((s: any, i: number) => <li key={i} className="flex justify-between gap-3"><span>{s.service}</span><span className="num">{aed(s.amount, 2)}</span></li>)}
              </ul>
              <div className="mt-4 space-y-1 border-t border-line pt-3 text-[14px]">
                <div className="flex justify-between text-ink-2"><span>Total</span><span className="num">{aed(data.total, 2)}</span></div>
                <div className="flex justify-between text-ink-2"><span>Your insurer's share</span><span className="num">{aed(data.insurerShare, 2)}</span></div>
                <div className="flex justify-between text-[17px] font-semibold"><span>Your share</span><span className="num">{aed(data.yourShare, 2)}</span></div>
              </div>
            </div>
            <div className="glass rounded-2xl p-5">
              <h2 className="text-[14px] font-semibold">Claim status</h2>
              <p className="mt-1 text-[13.5px] text-ink-2">{data.status}</p>
              {data.whatWeAreDoing.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-5 text-[13px] text-ink-2">{data.whatWeAreDoing.map((w: string) => <li key={w}>{w}</li>)}</ul>}
            </div>
          </div>
        )}
        {data?.kind === "estimate" && (
          <div className="glass rounded-2xl p-5">
            <p className="text-[14px] font-semibold">Estimated cost · {data.estimate.plan} plan with {data.estimate.payer}</p>
            <ul className="mt-3 space-y-2 text-[14px]">{data.estimate.lines.map((l: any) => <li key={l.code} className="flex justify-between"><span>{l.service}</span><span className="num">{aed(l.price, 2)}</span></li>)}</ul>
            <div className="mt-3 flex justify-between border-t border-line pt-3 text-[17px] font-semibold"><span>You pay about</span><span className="num">{aed(data.estimate.patientShare, 2)}</span></div>
            <ul className="mt-3 list-disc space-y-0.5 pl-5 text-[12px] text-muted">{data.estimate.assumptions.map((a: string) => <li key={a}>{a}</li>)}</ul>
          </div>
        )}
        {data && <p className="mt-6 text-center text-[11.5px] text-muted">This link expires {date(data.expiresAt)}. It shows no medical advice. Questions? Contact the clinic front desk.</p>}
        <div className="mt-4 text-center">
          <a href="#/explain" className="text-[12px] text-muted hover:text-white">Explain another bill →</a>
        </div>
      </div>
    </div>
  );
}
