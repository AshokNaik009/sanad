import { useState } from "react";
import { aed, pct, useApi } from "../api";
import { AGE_RAMP, BarList, LineChart, PAYER_COLORS, StackedBars } from "../charts";
import { Badge, Button, Card, ErrorBox, Loading, PageHeader, Stat, Table, inputClass } from "../ui";
import { AutopilotCard, RulesCard } from "./agents";

const filterClass = inputClass.replace("w-full", "w-auto");

export function Dashboard({ onAsk }: { onAsk: () => void }) {
  const [filters, setFilters] = useState({ payerId: "", from: "", to: "" });
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  const summary = useApi<any>(`/analytics/summary${qs ? `?${qs}` : ""}`);
  const forecast = useApi<any>("/analytics/forecast");
  const ref = useApi<any>("/reference");
  const me = useApi<any>("/me");
  const d = summary.data;
  const [tab, setTab] = useState<"payer" | "doctor" | "code">("payer");

  return (
    <div>
      <PageHeader
        title="Revenue cycle"
        sub="What is owed, what is at risk, and when cash will land."
        actions={<Button variant="ai" onClick={onAsk}>Why are denials changing?</Button>}
      />
      <div className="mb-5 flex flex-wrap gap-2">
        <select aria-label="Payer" className={filterClass} value={filters.payerId} onChange={(e) => setFilters({ ...filters, payerId: e.target.value })}>
          <option value="">All payers</option>
          {ref.data?.payers.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input aria-label="From date" type="date" className={filterClass} value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
        <input aria-label="To date" type="date" className={filterClass} value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
        {qs && <Button variant="ghost" onClick={() => setFilters({ payerId: "", from: "", to: "" })}>Clear</Button>}
      </div>
      <ErrorBox error={summary.error} />
      {!d ? (
        <Loading />
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="AED at risk (deadline ≤ 14 days)" value={aed(d.kpis.aedAtRisk)} sub={`${d.kpis.openDenials} open denials · ${aed(d.kpis.openDenialAmount)}`} tone={d.kpis.aedAtRisk > 0 ? "crit" : undefined} />
            <Stat label="Outstanding A/R" value={aed(d.kpis.outstandingAr)} sub="Submitted, awaiting payment" />
            <Stat label="First-pass acceptance" value={pct(d.kpis.firstPassRate)} sub={`${d.kpis.claimsAdjudicated.toLocaleString()} claims adjudicated`} />
            <Stat label="Denial rate" value={pct(d.kpis.denialRate)} sub="Claims with ≥1 denied line" />
            <Stat label="AI acceptance" value={d.kpis.aiAcceptance == null ? "—" : pct(d.kpis.aiAcceptance, 0)} sub={d.kpis.aiAcceptance != null && d.kpis.aiAcceptance < 0.6 ? "Below 60% alert threshold" : "Suggestions accepted without edit"} />
          </div>

          <div className="grid gap-5 lg:grid-cols-5">
            <div className="lg:col-span-3"><AutopilotCard role={me.data?.user.role} /></div>
            <div className="lg:col-span-2"><RulesCard role={me.data?.user.role} /></div>
          </div>

          <div className="grid gap-5 lg:grid-cols-5">
            <Card title="A/R by payer and age" className="lg:col-span-3">
              <StackedBars
                rows={d.arAging.map((r: any) => ({ label: r.payer, values: ["0-30", "31-60", "61-90", "90+"].map((b) => r[b]) }))}
                series={["0-30 days", "31-60 days", "61-90 days", "90+ days"].map((label, i) => ({ label, color: AGE_RAMP[i] }))}
                format={(n) => aed(n)}
              />
            </Card>
            <Card title="Top denial reasons · last 90 days" className="lg:col-span-2">
              <BarList rows={d.topReasons.map((r: any) => ({ label: r.label, value: r.amount, sub: `${r.count}` }))} format={(n) => aed(n)} color="var(--s2)" />
            </Card>
          </div>

          <div className="grid gap-5 lg:grid-cols-5">
            <Card title="Denial rate by service month" className="lg:col-span-3">
              <LineChart points={d.trend.map((t: any) => ({ label: new Date(`${t.month}-01`).toLocaleDateString("en-GB", { month: "short" }), value: t.denialRate }))} format={(n) => pct(n, 0)} />
            </Card>
            <Card title="30/60/90-day cash forecast" className="lg:col-span-2" action={forecast.data && <Badge tone="brand">as of {forecast.data.asOf}</Badge>}>
              {!forecast.data ? (
                <Loading />
              ) : (
                <>
                  <div className="mb-4 grid grid-cols-3 gap-2 text-center">
                    {(["d30", "d60", "d90"] as const).map((k, i) => (
                      <div key={k} className="rounded-lg bg-surface-2 p-2">
                        <div className="text-[11px] text-muted">{["Next 30 days", "31-60 days", "61-90 days"][i]}</div>
                        <div className="num text-[15px] font-semibold">{aed(forecast.data.totals[k])}</div>
                      </div>
                    ))}
                  </div>
                  <StackedBars
                    rows={forecast.data.perPayer.map((p: any) => ({ label: p.payer, values: [p.d30, p.d60, p.d90] }))}
                    series={["0-30", "31-60", "61-90"].map((label, i) => ({ label: `${label} days`, color: AGE_RAMP[i] }))}
                    format={(n) => aed(n)}
                  />
                  <details className="mt-3 text-[12px] text-ink-2">
                    <summary className="cursor-pointer text-muted">Assumptions and financing readiness</summary>
                    <ul className="mt-2 list-disc space-y-1 pl-4">
                      {forecast.data.assumptions.map((a: string) => <li key={a}>{a}</li>)}
                    </ul>
                    <p className="mt-2">
                      Clean receivables eligible for financing: <b>{aed(forecast.data.financing.eligibleReceivables)}</b> across {forecast.data.financing.claimCount} claims; payer concentration (HHI) {forecast.data.financing.concentrationHhi} ({forecast.data.financing.diversified ? "diversified" : "concentrated"}).
                    </p>
                  </details>
                </>
              )}
            </Card>
          </div>

          <Card
            title="Where denials come from"
            action={
              <div className="flex gap-1" role="tablist">
                {(["payer", "doctor", "code"] as const).map((t) => (
                  <Button key={t} variant={tab === t ? "primary" : "ghost"} className="min-h-7 px-2.5 text-[12px]" onClick={() => setTab(t)} role="tab" aria-selected={tab === t}>
                    By {t}
                  </Button>
                ))}
              </div>
            }
          >
            <Table>
              <thead>
                <tr>
                  <th>{tab === "code" ? "Service code" : tab === "doctor" ? "Clinician" : "Payer"}</th>
                  {tab !== "code" && <th className="text-right">Adjudicated</th>}
                  <th className="text-right">{tab === "code" ? "Denied lines" : "Denied claims"}</th>
                  {tab !== "code" && <th className="w-[30%]">Denial rate</th>}
                  <th className="text-right">AED denied</th>
                </tr>
              </thead>
              <tbody>
                {(tab === "payer" ? d.denialByPayer : tab === "doctor" ? d.denialByDoctor : d.denialByCode).map((r: any) => (
                  <tr key={r.name ?? r.code}>
                    <td className="font-medium">{r.name ?? r.code}</td>
                    {tab !== "code" && <td className="num text-right">{r.submitted}</td>}
                    <td className="num text-right">{r.denied ?? r.denials}</td>
                    {tab !== "code" && (
                      <td>
                        <div className="flex items-center gap-2">
                          <div className="h-2 flex-1 rounded-[4px] bg-surface-2">
                            <div className="h-2 rounded-[4px]" style={{ width: `${Math.min(100, r.rate * 300)}%`, background: PAYER_COLORS[0] }} />
                          </div>
                          <span className="num w-12 text-right text-[12px]">{pct(r.rate)}</span>
                        </div>
                      </td>
                    )}
                    <td className="num text-right">{aed(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>

          {d.aiQuality.length > 0 && (
            <Card title="AI quality · human decisions on AI output">
              <div className="grid gap-3 sm:grid-cols-3">
                {d.aiQuality.map((q: any) => (
                  <div key={q.task} className="rounded-lg bg-surface-2 p-3">
                    <div className="text-[12px] capitalize text-ink-2">{q.task.replace("_", " ")}</div>
                    <div className="num text-[18px] font-semibold">{pct(q.rate, 0)}</div>
                    <div className="text-[11.5px] text-muted">{q.accepted} of {q.decided} accepted without edit</div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
