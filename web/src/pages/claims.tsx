import { useState } from "react";
import { go } from "../App";
import { aed, api, date, useApi } from "../api";
import { Badge, Button, Card, Dialog, Empty, ErrorBox, EvidenceNote, Loading, PageHeader, ScoreGauge, StatusBadge, Table, Timeline, cx, useToast } from "../ui";

const FILTERS: [string, string][] = [["draft", "Needs fixes"], ["scrubbed", "Ready to submit"], ["acknowledged", "With payer"], ["partially_paid", "Partially paid"], ["denied", "Denied"], ["paid", "Paid"], ["", "All"]];

export function ClaimsPage() {
  const [status, setStatus] = useState("scrubbed");
  const list = useApi<any[]>(`/claims${status ? `?status=${status}` : ""}`);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const rows = list.data ?? [];
  const selectable = rows.filter((c) => c.status === "scrubbed" && c.blocking === 0);
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const submit = async () => {
    setBusy(true);
    try {
      const res = await api("/claims/submit", { json: { claimIds: [...selected], confirm: true } });
      toast(`${res.submitted.length} claim(s) acknowledged by the gateway${res.rejected.length ? `, ${res.rejected.length} rejected` : ""}`, res.rejected.length ? "crit" : "good");
      setSelected(new Set());
      setConfirm(false);
      await list.reload();
    } catch (e) {
      toast((e as Error).message, "crit");
    } finally {
      setBusy(false);
    }
  };
  const total = rows.filter((r) => selected.has(r.id)).reduce((s, r) => s + r.net, 0);
  return (
    <div>
      <PageHeader
        title="Claims"
        sub="Scrubbed before submission; nothing leaves without a named approver."
        actions={<Button variant="primary" disabled={!selected.size} onClick={() => setConfirm(true)}>Approve & submit {selected.size ? `(${selected.size})` : ""}</Button>}
      />
      <div className="mb-4 flex flex-wrap gap-1">
        {FILTERS.map(([k, l]) => <Button key={k} variant={status === k ? "primary" : "ghost"} onClick={() => { setStatus(k); setSelected(new Set()); }}>{l}</Button>)}
      </div>
      <ErrorBox error={list.error} />
      {!list.data ? <Loading /> : rows.length === 0 ? <Empty>No claims here.</Empty> : (
        <Card pad={false}>
          <div className="p-4">
            <Table>
              <thead>
                <tr>
                  <th className="w-8">
                    {selectable.length > 0 && <input type="checkbox" aria-label="Select all ready claims" checked={selected.size === selectable.length} onChange={(e) => setSelected(e.target.checked ? new Set(selectable.map((c) => c.id)) : new Set())} />}
                  </th>
                  <th>Claim</th>
                  <th>Patient</th>
                  <th>Payer</th>
                  <th>Codes</th>
                  <th className="text-right">Net</th>
                  <th>Score</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 150).map((c) => (
                  <tr key={c.id} className="cursor-pointer hover:bg-surface-2" onClick={() => go(`/claims/${c.id}`)}>
                    <td onClick={(e) => e.stopPropagation()}>
                      {c.status === "scrubbed" && c.blocking === 0 && <input type="checkbox" aria-label={`Select ${c.id}`} checked={selected.has(c.id)} onChange={() => toggle(c.id)} />}
                    </td>
                    <td><div className="font-mono text-[12px]">{c.id}</div><div className="text-[11.5px] text-muted">{date(c.serviceDate)}</div></td>
                    <td>{c.patientName}</td>
                    <td>{c.payerName}</td>
                    <td className="font-mono text-[12px]">{c.principal} · {c.codes}</td>
                    <td className="num text-right">{aed(c.net, 2)}</td>
                    <td>{c.cleanClaimScore != null ? <span className={cx("num font-medium", c.cleanClaimScore >= 90 ? "text-good-ink" : c.cleanClaimScore >= 60 ? "text-warn-ink" : "text-crit")}>{c.cleanClaimScore}</span> : "—"}{c.blocking > 0 && <span className="ml-1 text-[11.5px] text-crit">{c.blocking} blocking</span>}</td>
                    <td><StatusBadge status={c.status} /></td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </Card>
      )}
      <Dialog open={confirm} onClose={() => setConfirm(false)} title="Approve and submit" footer={<><Button onClick={() => setConfirm(false)}>Cancel</Button><Button variant="primary" busy={busy} onClick={submit}>Approve & submit {selected.size}</Button></>}>
        <p className="text-[13.5px] text-ink-2">
          You are approving <b>{selected.size}</b> claim(s) worth <b>{aed(total, 2)}</b> for submission to the DHA gateway. Your name and the time are recorded against each claim in the audit log.
        </p>
      </Dialog>
    </div>
  );
}

export function ClaimDetail({ id }: { id: string }) {
  const res = useApi<any>(`/claims/${id}`);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [tab, setTab] = useState<"note" | "xml" | "audit">("note");
  const [share, setShare] = useState<string | null>(null);
  if (res.error) return <ErrorBox error={res.error} />;
  if (!res.data) return <Loading />;
  const { claim, patient, note, denials, audit, xml } = res.data;
  const editable = claim.status === "draft" || claim.status === "scrubbed";
  const blocking = (claim.issues ?? []).filter((i: any) => i.severity === "blocking");
  const act = async (key: string, fn: () => Promise<any>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      await res.reload();
      if (ok) toast(ok, "good");
    } catch (e) {
      toast((e as Error).message, "crit");
    } finally {
      setBusy(null);
    }
  };
  return (
    <div>
      <PageHeader
        title={`Claim ${claim.id}`}
        sub={`${patient.name} · ${claim.payerName} · ${claim.clinicianName} · service ${date(claim.serviceDate)}`}
        actions={
          <>
            {claim.encounterId && <Button onClick={() => go(`/coding/${claim.encounterId}`)}>Encounter</Button>}
            <Button busy={busy === "share"} onClick={() => act("share", async () => { const l = await api("/share", { json: { claimId: claim.id } }); setShare(`${window.location.origin}${window.location.pathname}#/share/${l.id}`); })}>Patient link</Button>
            {editable && <Button busy={busy === "scrub"} onClick={() => act("scrub", () => api(`/claims/${id}/scrub`, { method: "POST" }), "Re-scrubbed")}>Re-scrub</Button>}
            {editable && <Button variant="primary" disabled={blocking.length > 0} onClick={() => setConfirm(true)}>Approve & submit</Button>}
          </>
        }
      />
      <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
        <div className="space-y-5">
          <Card title="Scrubber" action={<StatusBadge status={claim.status} />}>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <ScoreGauge score={claim.cleanClaimScore ?? 0} risk={claim.denialRisk} />
              <div className="flex gap-2 text-[12.5px]">
                <Badge tone={blocking.length ? "crit" : "good"}>{blocking.length} blocking</Badge>
                <Badge tone="warn">{(claim.issues ?? []).length - blocking.length} warnings</Badge>
              </div>
            </div>
            {(claim.issues ?? []).length > 0 ? (
              <ul className="mt-4 space-y-2">
                {claim.issues.map((i: any) => (
                  <li key={i.id} className={cx("rounded-lg border p-3", i.severity === "blocking" ? "border-crit/30 bg-crit-soft/50" : "border-warn/40 bg-warn-soft/50")}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={i.severity === "blocking" ? "crit" : "warn"}>{i.severity}</Badge>
                      <span className="font-mono text-[11.5px] text-muted">{i.rule} · {i.field}</span>
                    </div>
                    <p className="mt-1 text-[13px]">{i.message}</p>
                    <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[12.5px] text-ink-2">Fix: {i.fix}</p>
                      {i.autoFix && editable && <Button variant="primary" className="min-h-8" busy={busy === i.id} onClick={() => act(i.id, () => api(`/claims/${id}/fix/${i.id}`, { method: "POST" }), "Fix applied and logged")}>Apply fix</Button>}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-[13px] text-good-ink">No issues: this claim passes all ten rule families.</p>
            )}
          </Card>

          <Card title="Claim lines">
            <div className="mb-3 flex flex-wrap gap-2">
              {claim.diagnoses.map((d: any) => <Badge key={d.code} tone={d.type === "principal" ? "brand" : "neutral"}><span className="font-mono">{d.code}</span> {d.description}</Badge>)}
            </div>
            <Table>
              <thead><tr><th>Code</th><th>Description</th><th>Prior auth</th><th className="text-right">Gross</th><th className="text-right">Patient</th><th className="text-right">Net</th>{claim.activities.some((a: any) => a.paid !== undefined) && <th className="text-right">Paid</th>}</tr></thead>
              <tbody>
                {claim.activities.map((a: any) => (
                  <tr key={a.id}>
                    <td className="font-mono">{a.code}<div className="text-[10.5px] text-muted">{a.codeType}</div></td>
                    <td>{a.description}{a.denialCode && <div><Badge tone="crit">{a.denialCode}</Badge></div>}</td>
                    <td className="font-mono text-[12px]">{a.priorAuthNumber ?? "—"}</td>
                    <td className="num text-right">{a.gross.toFixed(2)}</td>
                    <td className="num text-right">{a.patientShare.toFixed(2)}</td>
                    <td className="num text-right">{a.net.toFixed(2)}</td>
                    {claim.activities.some((x: any) => x.paid !== undefined) && <td className="num text-right">{(a.paid ?? 0).toFixed(2)}</td>}
                  </tr>
                ))}
                <tr className="font-semibold"><td colSpan={3}>Total</td><td className="num text-right">{claim.gross.toFixed(2)}</td><td className="num text-right">{claim.patientShare.toFixed(2)}</td><td className="num text-right">{claim.net.toFixed(2)}</td>{claim.paidAmount !== undefined && <td className="num text-right">{claim.paidAmount.toFixed(2)}</td>}</tr>
              </tbody>
            </Table>
          </Card>

          <Card
            title={<div className="flex gap-1">{(["note", "xml", "audit"] as const).map((t) => <Button key={t} variant={tab === t ? "primary" : "ghost"} className="min-h-7 px-2.5 text-[12px]" onClick={() => setTab(t)}>{t === "xml" ? "Claim XML" : t === "note" ? "Clinical note" : "Audit trail"}</Button>)}</div>}
          >
            {tab === "note" && (note ? <EvidenceNote note={note} spans={[]} /> : <Empty>No encounter note on this claim.</Empty>)}
            {tab === "xml" && <pre className="max-h-[420px] overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-[11.5px] leading-relaxed">{xml}</pre>}
            {tab === "audit" && (
              <ul className="space-y-2 text-[12.5px]">
                {audit.map((a: any) => (
                  <li key={a.id} className="rounded-lg bg-surface-2 p-2">
                    <span className="font-mono text-[11px] text-muted">#{a.seq} {new Date(a.at).toLocaleString("en-GB")}</span> · <b>{a.action}</b> by {a.actor} ({a.role})
                  </li>
                ))}
                {!audit.length && <Empty>No audit events yet.</Empty>}
              </ul>
            )}
          </Card>
        </div>
        <div className="space-y-5">
          <Card title="Status timeline"><Timeline items={claim.timeline} /></Card>
          {denials.length > 0 && (
            <Card title="Denials on this claim">
              <ul className="space-y-2">
                {denials.map((d: any) => (
                  <li key={d.id}><a href={`#/denials/${d.id}`} className="flex items-center justify-between gap-2 rounded-lg border border-line p-2.5 hover:border-brand"><span><span className="font-mono text-[12px]">{d.code}</span> on {d.activityCode}</span><StatusBadge status={d.status} /></a></li>
                ))}
              </ul>
            </Card>
          )}
          {claim.approvedBy && <Card title="Approval"><p className="text-[13px]">Approved by <b>{claim.approvedBy}</b> on {new Date(claim.approvedAt).toLocaleString("en-GB")}</p></Card>}
        </div>
      </div>
      <Dialog open={confirm} onClose={() => setConfirm(false)} title="Approve and submit this claim" footer={<><Button onClick={() => setConfirm(false)}>Cancel</Button><Button variant="primary" busy={busy === "submit"} onClick={() => act("submit", async () => { const r = await api("/claims/submit", { json: { claimIds: [id], confirm: true } }); setConfirm(false); if (r.rejected.length) throw new Error(`Gateway rejected: ${r.rejected[0].errors.join("; ")}`); }, "Submitted and acknowledged by the gateway")}>Approve & submit</Button></>}>
        <p className="text-[13.5px] text-ink-2">Submit <b>{aed(claim.net, 2)}</b> to <b>{claim.payerName}</b> via the DHA gateway. Your approval is recorded with a timestamp.</p>
      </Dialog>
      <Dialog open={!!share} onClose={() => setShare(null)} title="Patient bill link" footer={<Button variant="primary" onClick={() => setShare(null)}>Done</Button>}>
        <p className="mb-2 text-[13px] text-ink-2">Plain-language bill and claim status. No login needed; expires in 7 days; shows first name only.</p>
        <input readOnly className="w-full rounded-lg border border-line bg-surface-2 p-2 font-mono text-[12px]" value={share ?? ""} onFocus={(e) => e.target.select()} />
        <a className="mt-2 inline-block text-[13px] text-brand underline" href={share ?? "#"} target="_blank" rel="noreferrer">Open patient view</a>
      </Dialog>
    </div>
  );
}
