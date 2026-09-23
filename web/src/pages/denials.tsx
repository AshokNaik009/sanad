import { useEffect, useState } from "react";
import { go } from "../App";
import { aed, api, date, daysUntil, useApi } from "../api";
import { AiTag, Badge, Button, Card, Dialog, Empty, ErrorBox, EvidenceNote, Field, Loading, PageHeader, StatusBadge, Timeline, cx, inputClass, useToast } from "../ui";

const bandTone = (b: string) => (b === "High" ? "good" : b === "Medium" ? "warn" : "neutral") as "good" | "warn" | "neutral";

export function DenialsPage() {
  const [status, setStatus] = useState("open");
  const list = useApi<any[]>(`/denials${status ? `?status=${status}` : ""}`);
  const ref = useApi<any>("/reference");
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const release = async () => {
    setBusy(true);
    try {
      const r = await api("/demo/release-remittances", { method: "POST" });
      toast(r.ingested ? `Remittance landed: ${r.ingested} file(s) reconciled` : "No new remittances from payers", r.ingested ? "good" : "neutral");
      await list.reload();
    } catch (e) {
      toast((e as Error).message, "crit");
    } finally {
      setBusy(false);
    }
  };
  const rows = list.data ?? [];
  return (
    <div>
      <PageHeader
        title="Denials worklist"
        sub="Sorted by priority = amount × recovery probability × deadline urgency."
        actions={<Button busy={busy} onClick={release}>Fetch payer remittances</Button>}
      />
      <div className="mb-4 flex flex-wrap gap-1">
        {[["open", "Open"], ["resubmitted", "Resubmitted"], ["recovered", "Recovered"], ["written_off", "Written off"], ["", "All"]].map(([k, l]) => (
          <Button key={k} variant={status === k ? "primary" : "ghost"} onClick={() => setStatus(k)}>{l}</Button>
        ))}
      </div>
      <ErrorBox error={list.error} />
      {!list.data ? <Loading /> : rows.length === 0 ? (
        <Empty>{status === "open" ? "No open denials. Fetch payer remittances to pull the latest remittance advice." : "Nothing here."}</Empty>
      ) : (
        <ol className="grid gap-2">
          {rows.map((d, i) => {
            const left = daysUntil(d.deadline);
            return (
              <li key={d.id}>
                <a href={`#/denials/${d.id}`} className="grid gap-3 glass rounded-2xl p-3.5 hover:border-brand sm:grid-cols-[28px_1fr_auto]">
                  <span className="num hidden text-[13px] font-semibold text-muted sm:block">{status === "open" ? i + 1 : ""}</span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[12.5px] font-semibold">{d.code}</span>
                      <Badge>{ref.data?.categories[d.category] ?? d.category}</Badge>
                      <span className="text-[12.5px] text-ink-2">{d.payerName} · {d.activityCode} · {d.specialty}</span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-[12.5px] text-ink-2">{d.plainReason}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 sm:flex-col sm:items-end sm:gap-1">
                    <span className="num text-[15px] font-semibold">{aed(d.amount)}</span>
                    <div className="flex gap-1.5">
                      <Badge tone={bandTone(d.recoveryBand)}>{d.recoveryBand} recovery</Badge>
                      {d.status === "open" ? <Badge tone={left <= 7 ? "crit" : left <= 14 ? "warn" : "neutral"}>{left < 0 ? "window closed" : `${left}d left`}</Badge> : <StatusBadge status={d.status} />}
                    </div>
                  </div>
                </a>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

export function DenialDetail({ id }: { id: string }) {
  const res = useApi<any>(`/denials/${id}`);
  const me = useApi<any>("/me");
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [type, setType] = useState<"correction" | "internal complaint">("correction");
  const [applyFixes, setApplyFixes] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [writeOff, setWriteOff] = useState(false);
  const [reason, setReason] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const draft = res.data?.denial.draft;
  useEffect(() => {
    if (!draft) return;
    setType(draft.type);
    setComment([draft.summary, ...draft.justification.map((j: any) => `${j.sentence} Note: "${j.citations[0]?.quote}".`)].join(" ").slice(0, 2000));
  }, [draft?.generatedAt]);

  if (res.error) return <ErrorBox error={res.error} />;
  if (!res.data) return <Loading />;
  const { denial, claim, note, denialInfo } = res.data;
  const activity = claim.activities.find((a: any) => a.id === denial.activityId);
  const left = daysUntil(denial.deadline);
  const open = denial.status === "open";
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
  const spans = (draft?.justification ?? []).flatMap((j: any, i: number) => j.citations.map((c: any) => ({ start: c.start, end: c.end, key: `j${i}` })));

  return (
    <div>
      <PageHeader
        title={`${denial.code} · ${activity?.description ?? denial.activityCode}`}
        sub={`${denial.payerName} · claim ${claim.id} · ${claim.clinicianName} · denied ${date(denial.deniedAt)}`}
        actions={<><Button onClick={() => go("/denials")}>Worklist</Button><Button onClick={() => go(`/claims/${claim.id}`)}>Claim</Button></>}
      />
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="glass rounded-2xl p-3"><div className="text-[12px] text-ink-2">Amount denied</div><div className="num text-[20px] font-semibold">{aed(denial.amount, 2)}</div></div>
        <div className="glass rounded-2xl p-3"><div className="text-[12px] text-ink-2">Recovery</div><div className="text-[20px] font-semibold">{denial.recoveryBand}</div><div className="text-[11.5px] text-muted">heuristic band, not a guarantee</div></div>
        <div className="glass rounded-2xl p-3"><div className="text-[12px] text-ink-2">Deadline</div><div className={cx("text-[20px] font-semibold", left <= 7 && "text-crit")}>{left < 0 ? "Closed" : `${left} days`}</div><div className="text-[11.5px] text-muted">{date(denial.deadline)}</div></div>
        <div className="glass rounded-2xl p-3"><div className="text-[12px] text-ink-2">Status</div><div className="mt-1"><StatusBadge status={denial.status} /></div></div>
      </div>
      <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
        <div className="space-y-5">
          <Card title="Why it was denied">
            <p className="text-[14px]">{denial.plainReason}</p>
            <p className="mt-2 text-[12px] text-muted">Payer text: {denialInfo?.text}{denial.payerComment && <> · Comment: “{denial.payerComment}”</>}</p>
            <div className="mt-2 flex gap-2"><Badge>Root cause: {denial.category.replace("_", " ")}</Badge>{denial.classifiedBy === "ai" && <AiTag engine={me.data?.ai} />}</div>
          </Card>
          <Card title="Clinical note" action={draft && <span className="text-[11.5px] text-muted">Highlighted: sentences cited in the draft</span>}>
            {note ? <EvidenceNote note={note} spans={spans} active={active} /> : <Empty>No clinical note linked to this claim.</Empty>}
          </Card>
        </div>
        <div className="space-y-5">
          <Card
            title={<span className="flex items-center gap-2">Resubmission draft <AiTag engine={me.data?.ai} /></span>}
            action={open && <Button variant="ai" busy={busy === "draft"} onClick={() => act("draft", () => api(`/denials/${id}/draft`, { method: "POST" }), "Draft ready")}>{draft ? "Redraft" : "Draft with AI"}</Button>}
          >
            {!draft ? (
              <Empty>{open ? "AI explains the denial, proposes field fixes and drafts a justification that cites the note." : "No draft was generated."}</Empty>
            ) : (
              <div className="space-y-4">
                <p className="text-[13.5px] font-medium">{draft.summary}</p>
                {draft.fieldFixes.length > 0 && (
                  <div>
                    <div className="mb-1 text-[11.5px] font-medium uppercase tracking-wider text-muted">Field fixes</div>
                    <ul className="space-y-1.5">
                      {draft.fieldFixes.map((f: any, i: number) => (
                        <li key={i} className="rounded-lg bg-surface-2 p-2 text-[12.5px]"><span className="font-mono">{f.field}</span>: <s className="text-muted">{f.from}</s> → <b className="font-mono">{f.to}</b><div className="text-ink-2">{f.reason}</div></li>
                      ))}
                    </ul>
                  </div>
                )}
                {draft.justification.length > 0 && (
                  <div>
                    <div className="mb-1 text-[11.5px] font-medium uppercase tracking-wider text-muted">Justification (every sentence cites the note)</div>
                    <ol className="space-y-1.5">
                      {draft.justification.map((j: any, i: number) => (
                        <li key={i} onMouseEnter={() => setActive(`j${i}`)} onMouseLeave={() => setActive(null)} className="rounded-lg border border-line p-2 text-[12.5px]">
                          {j.sentence}
                          <div className="mt-1 text-[11.5px] italic text-muted">[{i + 1}] “{j.citations[0]?.quote}”</div>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
                {draft.blockedSentences.length > 0 && <p className="text-[12px] text-crit">{draft.blockedSentences.length} AI sentence(s) blocked because they could not be traced to the note.</p>}
                <div className="text-[12px] text-ink-2">Attach: {draft.attachments.join(" · ")}</div>
                <div className="text-[11.5px] text-muted">Generated in {(draft.ms / 1000).toFixed(1)}s</div>
              </div>
            )}
          </Card>
          {open && (
            <Card title="Resubmit or write off">
              <div className="space-y-3">
                <Field label="Resubmission type">
                  <select className={inputClass} value={type} onChange={(e) => setType(e.target.value as typeof type)}>
                    <option value="correction">Correction</option>
                    <option value="internal complaint">Internal complaint</option>
                  </select>
                </Field>
                <Field label="Comment to payer" hint={`${comment.length}/2000 characters`}>
                  <textarea rows={7} className={inputClass} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Draft with AI or write the justification…" />
                </Field>
                {draft?.fieldFixes.length > 0 && (
                  <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={applyFixes} onChange={(e) => setApplyFixes(e.target.checked)} /> Apply the {draft.fieldFixes.length} field fix(es) to the claim</label>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" disabled={comment.trim().length < 10 || left < 0} onClick={() => setConfirm(true)}>Approve & resubmit</Button>
                  <Button variant="ghost" onClick={() => setWriteOff(true)}>Write off</Button>
                </div>
              </div>
            </Card>
          )}
          {denial.writeOffReason && <Card title="Write-off"><p className="text-[13px]">{denial.writeOffReason}</p></Card>}
          <Card title="Claim timeline"><Timeline items={claim.timeline.slice(-6)} /></Card>
        </div>
      </div>
      <Dialog open={confirm} onClose={() => setConfirm(false)} title="Approve resubmission" footer={<><Button onClick={() => setConfirm(false)}>Cancel</Button><Button variant="primary" busy={busy === "resubmit"} onClick={() => act("resubmit", async () => { await api(`/denials/${id}/resubmit`, { json: { type, comment, applyFixes, confirm: true } }); setConfirm(false); }, "Resubmitted to the gateway")}>Approve & resubmit</Button></>}>
        <p className="text-[13.5px] text-ink-2">Send a <b>{type}</b> for {denial.activityCode} ({aed(denial.amount, 2)}) to {denial.payerName}. Your approval is recorded in the audit log.</p>
      </Dialog>
      <Dialog open={writeOff} onClose={() => setWriteOff(false)} title="Write off denial" footer={<><Button onClick={() => setWriteOff(false)}>Cancel</Button><Button variant="danger" disabled={reason.trim().length < 5} busy={busy === "wo"} onClick={() => act("wo", async () => { await api(`/denials/${id}/write-off`, { json: { reason } }); setWriteOff(false); }, "Written off")}>Write off {aed(denial.amount)}</Button></>}>
        <Field label="Reason (required)"><textarea rows={3} className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Coverage confirmed lapsed; balance transferred to patient" /></Field>
      </Dialog>
    </div>
  );
}
