import { useState } from "react";
import { aed, api, date, useApi } from "../api";
import { AiTag, Badge, Button, Card, Dialog, ErrorBox, Field, PageHeader, StatusBadge, Table, inputClass, useToast } from "../ui";

export function FrontDesk() {
  const patients = useApi<any[]>("/patients");
  const ref = useApi<any>("/reference");
  const auths = useApi<any[]>("/prior-auths");
  const me = useApi<any>("/me");
  const toast = useToast();
  const [elig, setElig] = useState({ memberId: "", emiratesId: "", date: new Date().toISOString().slice(0, 10) });
  const [eligResult, setEligResult] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pa, setPa] = useState({ patientId: "", diagnosis: "", codes: "", note: "" });
  const [draft, setDraft] = useState<any>(null);
  const [justification, setJustification] = useState("");
  const [est, setEst] = useState({ patientId: "", codes: "99213" });
  const [estimate, setEstimate] = useState<any>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  const run = async <T,>(key: string, fn: () => Promise<T>) => {
    setBusy(key);
    try {
      return await fn();
    } catch (e) {
      toast((e as Error).message, "crit");
    } finally {
      setBusy(null);
    }
  };
  const pickPatient = (id: string) => patients.data?.find((p) => p.id === id);

  return (
    <div>
      <PageHeader title="Front desk" sub="Eligibility, prior authorisation and patient cost estimates before the visit." />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Eligibility check">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Member ID"><input className={inputClass} value={elig.memberId} onChange={(e) => setElig({ ...elig, memberId: e.target.value })} placeholder="e.g. A001-020000" list="members" /></Field>
            <Field label="or Emirates ID"><input className={inputClass} value={elig.emiratesId} onChange={(e) => setElig({ ...elig, emiratesId: e.target.value })} placeholder="784-0000-0000000-0" /></Field>
            <Field label="Date of service"><input type="date" className={inputClass} value={elig.date} onChange={(e) => setElig({ ...elig, date: e.target.value })} /></Field>
            <div className="flex items-end"><Button variant="primary" busy={busy === "elig"} onClick={() => run("elig", async () => setEligResult(await api("/eligibility", { json: elig })))}>Check eligibility</Button></div>
          </div>
          <datalist id="members">{patients.data?.map((p) => <option key={p.id} value={p.memberId}>{p.name}</option>)}</datalist>
          {eligResult && (
            <div className={`mt-4 rounded-lg border p-3 text-[13px] ${eligResult.eligible ? "border-good/40 bg-good-soft" : "border-crit/30 bg-crit-soft"}`}>
              <div className="font-semibold">{eligResult.eligible ? "✓ Eligible" : "✕ Not eligible"} {eligResult.reason && <span className="font-normal">· {eligResult.reason}</span>}</div>
              {eligResult.plan && (
                <div className="mt-1 text-ink-2">
                  {ref.data?.payers.find((p: any) => p.id === eligResult.payerId)?.name} · {eligResult.plan} plan · {eligResult.network} network · co-pay {eligResult.copayPercent}% (cap AED {eligResult.copayCapPerVisit}) · valid {eligResult.coverageStart} → {eligResult.coverageEnd}
                </div>
              )}
            </div>
          )}
        </Card>

        <Card title={<span className="flex items-center gap-2">Prior authorisation request <AiTag engine={me.data?.ai} /></span>}>
          <div className="space-y-3">
            <Field label="Patient">
              <select className={inputClass} value={pa.patientId} onChange={(e) => setPa({ ...pa, patientId: e.target.value })}>
                <option value="">Select…</option>
                {patients.data?.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.memberId}</option>)}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Diagnosis (ICD-10)"><input className={inputClass} value={pa.diagnosis} onChange={(e) => setPa({ ...pa, diagnosis: e.target.value.toUpperCase() })} placeholder="M17.11" /></Field>
              <Field label="Services (comma separated)"><input className={inputClass} value={pa.codes} onChange={(e) => setPa({ ...pa, codes: e.target.value.toUpperCase() })} placeholder="97110, 97140" /></Field>
            </div>
            {pa.patientId && pa.codes && (
              <p className="text-[12px] text-ink-2">
                {pa.codes.split(",").map((c) => c.trim()).filter(Boolean).map((c) => {
                  const payer = ref.data?.payers.find((x: any) => x.id === pickPatient(pa.patientId)?.payerId);
                  const needs = payer?.authRequired.some((r: string) => (r.endsWith("*") ? c.startsWith(r.slice(0, -1)) : r === c));
                  return <Badge key={c} tone={needs ? "warn" : "good"} className="mr-1">{c}: {needs ? "approval required" : "no approval needed"}</Badge>;
                })}
              </p>
            )}
            <Field label="Referral note"><textarea rows={4} className={inputClass} value={pa.note} onChange={(e) => setPa({ ...pa, note: e.target.value })} placeholder="History, findings and prior treatment from the referral…" /></Field>
            <Button variant="ai" busy={busy === "pa"} disabled={!pa.patientId || !pa.diagnosis || !pa.codes || pa.note.length < 20} onClick={() => run("pa", async () => { const d = await api("/prior-auths/draft", { json: { ...pa, codes: pa.codes.split(",").map((c) => c.trim()).filter(Boolean) } }); setDraft(d); setJustification(d.justification); })}>
              Draft justification
            </Button>
          </div>
        </Card>

        <Card title="Prior authorisations" className="lg:col-span-2">
          <Table>
            <thead><tr><th>Patient</th><th>Payer</th><th>Services</th><th>Approval</th><th>Valid until</th><th>Status</th><th /></tr></thead>
            <tbody>
              {(auths.data ?? []).slice(0, 25).map((p) => (
                <tr key={p.id}>
                  <td>{p.patientName}</td>
                  <td>{p.payerName}</td>
                  <td className="font-mono text-[12px]">{p.services.map((s: any) => s.code).join(", ")}</td>
                  <td className="font-mono text-[12px]">{p.approvalNumber ?? "—"}</td>
                  <td>{p.validUntil ? date(p.validUntil) : "—"}</td>
                  <td><StatusBadge status={p.status} /></td>
                  <td>{(p.status === "draft" || p.status === "info_requested") && <Button className="min-h-7" onClick={() => { setDraft(p); setJustification(p.justification); }}>Review</Button>}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <Card title="Patient cost estimate" className="lg:col-span-2">
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <Field label="Patient">
              <select className={inputClass} value={est.patientId} onChange={(e) => setEst({ ...est, patientId: e.target.value })}>
                <option value="">Select…</option>
                {patients.data?.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.plan}</option>)}
              </select>
            </Field>
            <Field label="Planned services"><input className={inputClass} value={est.codes} onChange={(e) => setEst({ ...est, codes: e.target.value.toUpperCase() })} /></Field>
            <div className="flex items-end"><Button variant="primary" disabled={!est.patientId} busy={busy === "est"} onClick={() => run("est", async () => setEstimate(await api(`/patients/${est.patientId}/estimate`, { json: { codes: est.codes.split(",").map((c) => c.trim()).filter(Boolean) } })))}>Estimate</Button></div>
          </div>
          {estimate && (
            <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_260px]">
              <div>
                <Table>
                  <tbody>{estimate.lines.map((l: any) => <tr key={l.code}><td>{l.service}</td><td className="font-mono text-[12px] text-muted">{l.code}</td><td className="num text-right">{aed(l.price, 2)}</td></tr>)}</tbody>
                </Table>
                <ul className="mt-3 list-disc space-y-0.5 pl-4 text-[12px] text-muted">{estimate.assumptions.map((a: string) => <li key={a}>{a}</li>)}</ul>
              </div>
              <div className="rounded-xl bg-surface-2 p-4 text-[13px]">
                <div className="flex justify-between"><span>Total</span><span className="num">{aed(estimate.total, 2)}</span></div>
                <div className="flex justify-between"><span>{estimate.payer} pays</span><span className="num">{aed(estimate.insurerShare, 2)}</span></div>
                <div className="mt-2 flex justify-between border-t border-line pt-2 text-[16px] font-semibold"><span>You pay</span><span className="num">{aed(estimate.patientShare, 2)}</span></div>
                <Button className="mt-3 w-full" busy={busy === "share"} onClick={() => run("share", async () => { const l = await api("/share", { json: { estimate } }); setShareUrl(`${window.location.origin}${window.location.pathname}#/share/${l.id}`); })}>Share with patient</Button>
              </div>
            </div>
          )}
        </Card>
      </div>

      <Dialog open={!!draft} onClose={() => setDraft(null)} title="Review and send prior authorisation" footer={<><Button onClick={() => setDraft(null)}>Cancel</Button><Button variant="primary" busy={busy === "send"} onClick={() => run("send", async () => { await api(`/prior-auths/${draft.id}/submit`, { json: { justification, confirm: true } }); setDraft(null); toast("Sent to payer; status updates automatically", "good"); await auths.reload(); })}>Approve & send</Button></>}>
        {draft && (
          <div className="space-y-3 text-[13px]">
            <p className="text-ink-2">{draft.services.map((s: any) => `${s.code} ${s.description}`).join("; ")} · diagnosis {draft.diagnosis}</p>
            <Field label="Clinical justification (edit before sending)"><textarea rows={7} className={inputClass} value={justification} onChange={(e) => setJustification(e.target.value)} /></Field>
          </div>
        )}
      </Dialog>
      <Dialog open={!!shareUrl} onClose={() => setShareUrl(null)} title="Estimate link" footer={<Button variant="primary" onClick={() => setShareUrl(null)}>Done</Button>}>
        <input readOnly className="w-full rounded-lg border border-line bg-surface-2 p-2 font-mono text-[12px]" value={shareUrl ?? ""} onFocus={(e) => e.target.select()} />
        <p className="mt-2 text-[12px] text-muted">Expires in 7 days. No login needed.</p>
      </Dialog>
      <ErrorBox error={patients.error} />
    </div>
  );
}
