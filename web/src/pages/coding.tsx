import { useState } from "react";
import { go } from "../App";
import { api, date, useApi } from "../api";
import { AiTag, Badge, Button, Card, Dialog, Empty, ErrorBox, EvidenceNote, Field, Loading, PageHeader, StatusBadge, Table, cx, inputClass, useToast } from "../ui";

export function CodingQueue() {
  const [status, setStatus] = useState("to_code");
  const list = useApi<any[]>(`/encounters${status ? `?status=${status}` : ""}`);
  const [upload, setUpload] = useState(false);
  return (
    <div>
      <PageHeader
        title="Coding queue"
        sub="Encounters from the EMR waiting to become clean claims. AI suggests codes; a coder decides."
        actions={<Button variant="primary" onClick={() => setUpload(true)}>Add encounter note</Button>}
      />
      <div className="mb-4 flex flex-wrap gap-1">
        {[["to_code", "To code"], ["coded", "Coded"], ["claimed", "Claimed"], ["", "All"]].map(([k, l]) => (
          <Button key={k} variant={status === k ? "primary" : "ghost"} onClick={() => setStatus(k)}>{l}</Button>
        ))}
      </div>
      <ErrorBox error={list.error} />
      {!list.data ? (
        <Loading />
      ) : list.data.length === 0 ? (
        <Empty>Nothing in this queue.</Empty>
      ) : (
        <div className="grid gap-2">
          {list.data.slice(0, 80).map((e) => (
            <a key={e.id} href={`#/coding/${e.id}`} className="block glass rounded-2xl p-3.5 hover:border-brand">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{e.patient}</span>
                <span className="text-[12px] text-muted">{date(e.date)} · {e.specialty} · {e.clinician} · {e.payer}</span>
                <span className="ml-auto flex gap-1.5">
                  {e.gold && <Badge tone="brand">gold set</Badge>}
                  {e.gaps > 0 && <Badge tone="warn">{e.gaps} doc gap{e.gaps > 1 ? "s" : ""}</Badge>}
                  <StatusBadge status={e.status} />
                </span>
              </div>
              <p className="mt-1.5 line-clamp-2 text-[12.5px] text-ink-2">{e.preview}</p>
            </a>
          ))}
        </div>
      )}
      <UploadDialog open={upload} onClose={() => setUpload(false)} />
    </div>
  );
}

function UploadDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useApi<any>(open ? "/reference" : null);
  const patients = useApi<any[]>(open ? "/patients" : null);
  const [form, setForm] = useState({ patientId: "", clinicianId: "", date: new Date().toISOString().slice(0, 10), note: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readFile = async (file: File) => {
    const text = await file.text();
    setForm((f) => ({ ...f, note: text }));
  };
  const submit = async () => {
    setBusy(true);
    try {
      const enc = await api("/encounters", { json: { ...form, type: "outpatient" } });
      onClose();
      go(`/coding/${enc.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Add encounter" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={submit}>Create encounter</Button></>}>
      <div className="space-y-3">
        <ErrorBox error={error} />
        <Field label="Patient">
          <select className={inputClass} value={form.patientId} onChange={(e) => setForm({ ...form, patientId: e.target.value })}>
            <option value="">Select…</option>
            {patients.data?.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.memberId}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Clinician">
            <select className={inputClass} value={form.clinicianId} onChange={(e) => setForm({ ...form, clinicianId: e.target.value })}>
              <option value="">Select…</option>
              {ref.data?.clinicians.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Visit date"><input type="date" className={inputClass} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
        </div>
        <Field label="Clinical note" hint="Paste text or load a .txt export. Scanned notes go through OCR in the pilot build.">
          <textarea rows={8} className={inputClass} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="History, examination, assessment and plan…" />
        </Field>
        <input type="file" accept=".txt,text/plain" onChange={(e) => e.target.files?.[0] && void readFile(e.target.files[0])} className="text-[12.5px]" />
      </div>
    </Dialog>
  );
}

export function EncounterPage({ id }: { id: string }) {
  const enc = useApi<any>(`/encounters/${id}`);
  const me = useApi<any>("/me");
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ id: string; code: string } | null>(null);
  const [manual, setManual] = useState("");
  const e = enc.data;

  const run = async (key: string, fn: () => Promise<any>, ok?: string) => {
    setBusy(key);
    try {
      const res = await fn();
      if (res && res.id === id) enc.setData({ ...e, ...res });
      else await enc.reload();
      if (ok) toast(ok, "good");
      return res;
    } catch (err) {
      toast((err as Error).message, "crit");
    } finally {
      setBusy(null);
    }
  };

  if (enc.error) return <ErrorBox error={enc.error} />;
  if (!e) return <Loading />;
  const suggestions: any[] = e.suggestions ?? [];
  const spans = suggestions.filter((s) => s.decision !== "rejected").flatMap((s) => s.evidence.map((ev: any) => ({ start: ev.start, end: ev.end, key: s.id })));
  const pending = suggestions.filter((s) => s.decision === "pending").length;
  const decide = (s: any, decision: string, editedCode?: string) =>
    run(s.id, () => api(`/encounters/${id}/suggestions/${s.id}`, { json: { decision, editedCode } }));

  return (
    <div>
      <PageHeader
        title={`${e.patient.name} · ${e.specialty}`}
        sub={`${date(e.date)} · ${e.clinician.name} · ${e.payer} · member ${e.patient.memberId} · ${e.patient.gender === "F" ? "female" : "male"}, DOB ${e.patient.dob}`}
        actions={
          <>
            <Button onClick={() => go("/coding")}>Back to queue</Button>
            {e.claimId ? (
              <Button variant="primary" onClick={() => go(`/claims/${e.claimId}`)}>Open claim</Button>
            ) : (
              <Button variant="primary" disabled={!suggestions.length || pending > 0} busy={busy === "claim"} onClick={() => run("claim", () => api(`/encounters/${id}/claim`, { method: "POST" })).then((c) => c && go(`/claims/${c.id}`))}>
                {pending ? `Decide ${pending} suggestion${pending > 1 ? "s" : ""}` : "Create claim & scrub"}
              </Button>
            )}
          </>
        }
      />
      <div className="grid gap-5 lg:grid-cols-[1.1fr_1fr]">
        <Card title="Clinical note" action={<span className="text-[11.5px] text-muted">Highlighted text is the evidence for each code</span>}>
          <EvidenceNote note={e.note} spans={spans} active={active} />
        </Card>
        <div className="space-y-5">
          <Card
            title={<span className="flex items-center gap-2">Code suggestions <AiTag engine={me.data?.ai} /></span>}
            action={<Button variant="ai" busy={busy === "code"} onClick={() => run("code", () => api(`/encounters/${id}/code`, { method: "POST" }), "AI coding complete")}>{suggestions.length ? "Re-run AI coding" : "Suggest codes"}</Button>}
          >
            {!suggestions.length ? (
              <Empty>Run AI coding to get ICD-10-CM and CPT/HCPCS suggestions with evidence.</Empty>
            ) : (
              <ul className="space-y-2">
                {suggestions.map((s) => (
                  <li
                    key={s.id}
                    onMouseEnter={() => setActive(s.id)}
                    onMouseLeave={() => setActive(null)}
                    className={cx("rounded-lg border p-3", s.decision === "rejected" ? "border-line opacity-55" : s.decision === "pending" ? "border-ai/40 bg-ai-soft/40" : "border-line")}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[13.5px] font-semibold">{s.editedCode ?? s.code}</span>
                      {s.editedCode && <span className="font-mono text-[12px] text-muted line-through">{s.code}</span>}
                      <Badge tone={s.role === "principal" ? "brand" : "neutral"}>{s.role}</Badge>
                      <span className="num text-[12px] text-muted">{Math.round(s.confidence * 100)}% confidence</span>
                      <span className="ml-auto"><StatusBadge status={s.decision} /></span>
                    </div>
                    <p className="mt-1 text-[12.5px] text-ink-2">{s.description}</p>
                    {s.evidence.length > 0 && <p className="mt-1 text-[12px] italic text-muted">“{s.evidence[0].text}”</p>}
                    {s.decision === "pending" && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <Button variant="primary" className="min-h-8" busy={busy === s.id} onClick={() => decide(s, "accepted")}>Accept</Button>
                        <Button className="min-h-8" onClick={() => setEdit({ id: s.id, code: s.code })}>Edit</Button>
                        <Button variant="ghost" className="min-h-8" onClick={() => decide(s, "rejected")}>Reject</Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {suggestions.length > 0 && !e.claimId && (
              <div className="mt-3 flex gap-2">
                <input className={inputClass} placeholder="Add a code manually (e.g. M54.2)" value={manual} onChange={(ev) => setManual(ev.target.value.toUpperCase())} />
                <Button disabled={!manual} busy={busy === "manual"} onClick={() => run("manual", () => api(`/encounters/${id}/codes`, { json: { code: manual } })).then(() => setManual(""))}>Add</Button>
              </div>
            )}
          </Card>

          {(e.gaps?.length > 0 || e.queries?.length > 0) && (
            <Card title="Documentation gaps">
              <ul className="space-y-2">
                {e.gaps?.map((g: any) => {
                  const q = e.queries?.find((x: any) => x.question === g.question);
                  return (
                    <li key={g.id} className="rounded-lg border border-line p-3">
                      <p className="text-[13px] font-medium">{g.question}</p>
                      <p className="mt-0.5 text-[12px] text-muted">{g.reason}</p>
                      <div className="mt-2">
                        {q ? (
                          <span className="text-[12.5px]"><StatusBadge status={q.status} /> {q.answer && <>Answer: <b>{q.answer}</b></>}</span>
                        ) : (
                          <Button className="min-h-8" busy={busy === g.id} onClick={() => run(g.id, () => api(`/encounters/${id}/gaps/${g.id}/query`, { method: "POST" }), `Query sent to ${e.clinician.name}`)}>Query doctor</Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          {e.priorAuths?.length > 0 && (
            <Card title="Prior authorisations on file">
              <Table>
                <tbody>
                  {e.priorAuths.map((p: any) => (
                    <tr key={p.id}>
                      <td className="font-mono">{p.approvalNumber ?? "—"}</td>
                      <td>{p.services.map((s: any) => s.code).join(", ")}</td>
                      <td><StatusBadge status={p.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}
        </div>
      </div>
      <Dialog
        open={!!edit}
        onClose={() => setEdit(null)}
        title="Edit code"
        footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" onClick={async () => { const s = suggestions.find((x) => x.id === edit?.id); await decide(s, "edited", edit?.code); setEdit(null); }}>Save edit</Button></>}
      >
        <Field label="Replacement code" hint="Must be an active code in the loaded code set.">
          <input className={inputClass} value={edit?.code ?? ""} onChange={(ev) => setEdit((x) => (x ? { ...x, code: ev.target.value.toUpperCase() } : x))} />
        </Field>
      </Dialog>
    </div>
  );
}
