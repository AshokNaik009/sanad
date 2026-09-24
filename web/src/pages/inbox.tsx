import { useState } from "react";
import { api, date, useApi } from "../api";
import { Button, Card, Empty, ErrorBox, Loading, PageHeader, StatusBadge, inputClass, useToast } from "../ui";
import { ApprovalQueue } from "./agents";

export function Inbox() {
  const list = useApi<any[]>("/queries");
  const me = useApi<any>("/me");
  const toast = useToast();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const answer = async (q: any) => {
    setBusy(q.id);
    try {
      await api(`/queries/${q.id}/answer`, { json: { answer: answers[q.id] } });
      toast("Answer added to the note; coding re-ran", "good");
      await list.reload();
    } catch (e) {
      toast((e as Error).message, "crit");
    } finally {
      setBusy(null);
    }
  };
  const open = (list.data ?? []).filter((q) => q.status === "open");
  const done = (list.data ?? []).filter((q) => q.status !== "open");
  return (
    <div>
      <PageHeader title="Inbox" sub="Appeals waiting for approval, and questions from coders to doctors." />
      <div className="mb-6">
        <ApprovalQueue role={me.data?.user.role} />
      </div>
      <h2 className="mb-3 text-[15px] font-semibold">Documentation queries</h2>
      <ErrorBox error={list.error} />
      {!list.data ? <Loading /> : (
        <div className="space-y-3">
          {!open.length && <Empty>No open queries. Switch user to “Dr. Fatima” to answer queries addressed to her.</Empty>}
          {open.map((q) => (
            <Card key={q.id} title={q.question} action={<span className="text-[12px] text-muted">{q.clinician} · visit {date(q.date)}</span>}>
              <p className="mb-2 text-[12.5px] text-muted">{q.reason}</p>
              <details className="mb-3 text-[12.5px]"><summary className="cursor-pointer text-ink-2">Show note</summary><pre className="mt-2 whitespace-pre-wrap font-sans text-ink-2">{q.note}</pre></details>
              <div className="flex gap-2">
                <input className={inputClass} placeholder="e.g. Right knee" value={answers[q.id] ?? ""} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
                <Button variant="primary" disabled={!answers[q.id]?.trim()} busy={busy === q.id} onClick={() => answer(q)}>Answer</Button>
              </div>
            </Card>
          ))}
          {done.length > 0 && (
            <Card title="Answered">
              <ul className="space-y-2 text-[13px]">{done.map((q) => <li key={q.id} className="flex flex-wrap items-center gap-2"><StatusBadge status={q.status} /> {q.question} <b>{q.answer}</b></li>)}</ul>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
