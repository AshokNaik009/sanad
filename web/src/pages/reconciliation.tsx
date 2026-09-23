import { useState } from "react";
import { aed, currentUser, date, pct, useApi } from "../api";
import { PAYER_COLORS } from "../charts";
import { Badge, Button, Card, Empty, ErrorBox, Loading, PageHeader, StatusBadge, Table, useToast } from "../ui";

export function Reconciliation({ onAsk }: { onAsk: () => void }) {
  const rec = useApi<any>("/reconciliation");
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const exportXlsx = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/reconciliation/export.xlsx", { headers: { "X-Sanad-User": currentUser() } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Export failed");
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement("a"), { href: url, download: `sanad-reconciliation-${new Date().toISOString().slice(0, 10)}.xlsx` });
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast((e as Error).message, "crit");
    } finally {
      setBusy(false);
    }
  };
  const d = rec.data;
  return (
    <div>
      <PageHeader
        title="Remittance reconciliation"
        sub="Every remittance line matched to its claim and checked against the contract price."
        actions={<><Button variant="ai" onClick={onAsk}>Which payer underpays most?</Button><Button variant="primary" busy={busy} onClick={exportXlsx}>Export Excel</Button></>}
      />
      <ErrorBox error={rec.error} />
      {!d ? <Loading /> : (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-3">
            {d.totals.map((t: any, i: number) => (
              <div key={t.payerId} className="glass rounded-2xl p-4">
                <div className="flex items-center gap-2 text-[13px] font-medium"><span className="size-2.5 rounded-[3px]" style={{ background: PAYER_COLORS[i] }} />{t.payer}</div>
                <dl className="mt-2 grid grid-cols-2 gap-y-1 text-[12.5px]">
                  <dt className="text-ink-2">Paid</dt><dd className="num text-right font-medium">{aed(t.paid)}</dd>
                  <dt className="text-ink-2">Denied</dt><dd className="num text-right">{aed(t.denied)}</dd>
                  <dt className="text-ink-2">Underpaid</dt><dd className="num text-right text-crit">{aed(t.underpaid)}</dd>
                  <dt className="text-ink-2">Pending</dt><dd className="num text-right">{aed(t.pending)}</dd>
                </dl>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 text-[12.5px]">
            <Badge tone="good">Match rate {pct(d.matchRate)}</Badge>
            <Badge>Last {d.windowDays} days</Badge>
            <Badge>Underpayment threshold AED {d.threshold}</Badge>
            {d.unmatched.length > 0 && <Badge tone="warn">{d.unmatched.length} unmatched line(s) queued</Badge>}
          </div>
          <Card title={`Underpayments (${d.underpayments.length})`}>
            {!d.underpayments.length ? <Empty>No underpaid lines.</Empty> : (
              <Table>
                <thead><tr><th>Claim</th><th>Payer</th><th>Code</th><th>Settled</th><th className="text-right">Expected</th><th className="text-right">Paid</th><th className="text-right">Short</th></tr></thead>
                <tbody>
                  {d.underpayments.slice(0, 40).map((l: any) => (
                    <tr key={l.id}>
                      <td><a className="font-mono text-[12px] text-brand underline-offset-2 hover:underline" href={`#/claims/${l.claimId}`}>{l.claimId}</a></td>
                      <td>{l.payerName}</td>
                      <td className="font-mono">{l.activityCode}</td>
                      <td>{date(l.settledAt)}</td>
                      <td className="num text-right">{l.expected.toFixed(2)}</td>
                      <td className="num text-right">{l.paid.toFixed(2)}</td>
                      <td className="num text-right font-medium text-crit">{l.variance.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card title="Recent remittance lines">
            <Table>
              <thead><tr><th>Claim</th><th>Payer</th><th>Code</th><th>Payment ref</th><th className="text-right">Paid</th><th>Status</th></tr></thead>
              <tbody>
                {d.recent.map((l: any) => (
                  <tr key={l.id}>
                    <td className="font-mono text-[12px]">{l.claimId}</td>
                    <td>{l.payerName}</td>
                    <td className="font-mono">{l.activityCode}</td>
                    <td className="font-mono text-[11.5px] text-muted">{l.paymentReference}</td>
                    <td className="num text-right">{l.paid.toFixed(2)}</td>
                    <td><StatusBadge status={l.status} />{l.denialCode && <span className="ml-1 font-mono text-[11px] text-muted">{l.denialCode}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </div>
      )}
    </div>
  );
}
