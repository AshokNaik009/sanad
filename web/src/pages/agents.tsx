// Agent surfaces: the approval queue (nothing leaves the clinic until a person approves it),
// the Denial Autopilot card, the regulator rules card, payer-memory notes and copilot result cards.
import { useEffect, useState } from "react";
import { go } from "../App";
import { aed, api, date, daysUntil, useApi } from "../api";
import { Badge, Button, Card, Empty, Loading, cx, inputClass, useToast } from "../ui";

const DECIDERS = ["biller", "admin"];

export interface Proposal {
  id: string;
  title: string;
  summary: string;
  amount: number;
  payerName: string;
  deadline?: string;
  source: "autopilot" | "copilot";
  status: "awaiting_review" | "approved" | "declined" | "failed" | "expired";
  contentHash: string;
  entityId: string;
  proposedAt: string;
  decidedAt?: string;
  outcome?: string;
  reason?: string;
  payload: { type: string; comment: string; fixes: { field: string; from?: string; to: string; reason: string }[] };
}

const STATUS: Record<Proposal["status"], { label: string; tone: "warn" | "good" | "neutral" | "crit" }> = {
  awaiting_review: { label: "Waiting for approval", tone: "warn" },
  approved: { label: "Sent", tone: "good" },
  declined: { label: "Declined", tone: "neutral" },
  failed: { label: "Not sent", tone: "crit" },
  expired: { label: "Closed", tone: "neutral" },
};

function ProposalItem({ p, canDecide, onDone }: { p: Proposal; canDecide: boolean; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const left = p.deadline ? daysUntil(p.deadline) : undefined;
  const decide = async (approve: boolean) => {
    setBusy(approve ? "approve" : "decline");
    try {
      const out = await api<Proposal>(`/proposals/${p.id}/decide`, { json: { hash: p.contentHash, approve, reason: reason || undefined } });
      toast(out.status === "approved" ? `Appeal sent to ${p.payerName}` : out.status === "declined" ? "Declined — nothing was sent" : out.outcome ?? "Not sent", out.status === "failed" ? "crit" : "good");
      onDone();
    } catch (e) {
      toast((e as Error).message, "crit");
      onDone();
    } finally {
      setBusy(null);
    }
  };
  return (
    <li className="rounded-xl border border-line bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-[14px] font-semibold">{p.title}</div>
          <div className="mt-0.5 text-[12.5px] text-muted">
            {p.source === "autopilot" ? "Drafted by Denial Autopilot" : "Drafted from the copilot"} · {date(p.proposedAt)}
            {left !== undefined && <> · <span className={cx(left <= 7 && "text-[#ff8a8f]")}>{left > 0 ? `${left} days left to appeal` : "appeal window closes today"}</span></>}
          </div>
        </div>
        <div className="text-right">
          <div className="num text-[16px] font-semibold">{aed(p.amount)}</div>
          <button type="button" className="text-[12px] text-muted hover:text-white" onClick={() => go(`/denials/${p.entityId}`)}>Open denial →</button>
        </div>
      </div>
      <p className="mt-2 text-[13px] text-ink-2">{p.summary}</p>
      {p.payload.fixes.length > 0 && (
        <ul className="mt-2 space-y-1 text-[12.5px]">
          {p.payload.fixes.map((f, i) => (
            <li key={i} className="flex flex-wrap gap-1.5"><Badge tone="brand">Fix</Badge> {f.field}: {f.from ? <><s className="text-muted">{f.from}</s> → </> : null}<b>{f.to}</b> <span className="text-muted">— {f.reason}</span></li>
          ))}
        </ul>
      )}
      <details className="mt-2 text-[12.5px]">
        <summary className="cursor-pointer text-ink-2">Letter to the insurer ({p.payload.type})</summary>
        <p className="mt-2 whitespace-pre-wrap rounded-lg bg-black/30 p-3 leading-relaxed text-ink-2">{p.payload.comment}</p>
      </details>
      {canDecide ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" busy={busy === "approve"} disabled={!!busy} onClick={() => decide(true)}>Approve &amp; send</Button>
          {declining ? (
            <>
              <input className={cx(inputClass, "max-w-xs")} placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
              <Button busy={busy === "decline"} disabled={!!busy} onClick={() => decide(false)}>Decline</Button>
            </>
          ) : (
            <Button variant="ghost" disabled={!!busy} onClick={() => setDeclining(true)}>Decline…</Button>
          )}
        </div>
      ) : (
        <p className="mt-3 text-[12.5px] text-muted">A biller approves or declines appeals.</p>
      )}
    </li>
  );
}

export function ApprovalQueue({ role }: { role?: string }) {
  const list = useApi<Proposal[]>("/proposals");
  // Closest appeal deadline first, then largest amount.
  const pending = (list.data ?? []).filter((p) => p.status === "awaiting_review").sort((a, b) => (a.deadline ?? "9").localeCompare(b.deadline ?? "9") || b.amount - a.amount);
  const recent = (list.data ?? []).filter((p) => p.status !== "awaiting_review").slice(0, 6);
  const total = pending.reduce((s, p) => s + p.amount, 0);
  return (
    <Card title="Waiting for your approval" action={pending.length > 0 && <Badge tone="warn">{pending.length} · {aed(total)}</Badge>}>
      {!list.data ? (
        <Loading />
      ) : (
        <>
          {!pending.length && <Empty>Nothing is waiting. Denial Autopilot and the copilot put their drafts here — nothing is sent until someone approves it.</Empty>}
          <ul className="space-y-3">
            {pending.map((p) => <ProposalItem key={p.id} p={p} canDecide={!!role && DECIDERS.includes(role)} onDone={() => void list.reload()} />)}
          </ul>
          {recent.length > 0 && (
            <div className="mt-4 border-t border-line pt-3">
              <div className="mb-2 text-[12px] font-medium text-muted">Recently decided</div>
              <ul className="space-y-1.5 text-[12.5px]">
                {recent.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-2">
                    <Badge tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Badge>
                    <span>{p.title}</span>
                    <span className="num text-muted">{aed(p.amount)}</span>
                    {(p.outcome || p.reason) && <span className="text-muted">— {p.reason ?? p.outcome}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

interface AutopilotState {
  job: null | { id: string; status: "running" | "done" | "failed"; total: number; processed: number; proposed: number; amount: number; current?: string; finishedAt?: string };
  ready: number;
  readyAmount: number;
}

export function AutopilotCard({ role }: { role?: string }) {
  const state = useApi<AutopilotState>("/autopilot");
  const toast = useToast();
  const [starting, setStarting] = useState(false);
  const job = state.data?.job;
  const running = job?.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void state.reload(), 1500);
    return () => clearInterval(t);
  }, [running, state.reload]);
  const start = async () => {
    setStarting(true);
    try {
      await api("/autopilot/start", { method: "POST" });
      await state.reload();
    } catch (e) {
      toast((e as Error).message, "crit");
    } finally {
      setStarting(false);
    }
  };
  const canStart = !!role && DECIDERS.includes(role);
  return (
    <Card title="Denial Autopilot" action={<Badge tone="ai">Drafts only · you approve</Badge>}>
      {!state.data ? (
        <Loading />
      ) : running && job ? (
        <div>
          <div className="flex justify-between text-[13px]"><span>Drafting appeals… {job.current && <span className="text-muted">{job.current}</span>}</span><span className="num">{job.processed}/{job.total}</span></div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/[0.06]"><div className="h-full rounded-full bg-[linear-gradient(90deg,#e0303a,#ff6b4a,#ffb347)] transition-all" style={{ width: `${job.total ? (job.processed / job.total) * 100 : 0}%` }} /></div>
          <p className="mt-2 text-[12.5px] text-muted">{job.proposed} ready so far · {aed(job.amount)}. You can leave this page; it keeps going.</p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-[13px]">
            {job?.status === "done" && job.proposed > 0 ? (
              <p>Drafted <b>{job.proposed}</b> appeal{job.proposed === 1 ? "" : "s"} worth <b>{aed(job.amount)}</b>. <button type="button" className="text-[#ff8f6b] hover:underline" onClick={() => go("/inbox")}>Review in inbox →</button></p>
            ) : state.data.ready > 0 ? (
              <p><b>{state.data.ready}</b> open denial{state.data.ready === 1 ? "" : "s"} worth <b>{aed(state.data.readyAmount)}</b> can be drafted now, each quoting the clinical note.</p>
            ) : (
              <p className="text-muted">Every open denial already has an appeal drafted or waiting for approval.</p>
            )}
          </div>
          {canStart && state.data.ready > 0 && <Button variant="ai" busy={starting} onClick={start}>Draft appeals for all</Button>}
        </div>
      )}
    </Card>
  );
}

interface RulesState {
  publisher: string;
  updatedAt?: string;
  denialCodes: number;
  drugs: number;
  lastCheck: null | { checkedAt: string; summary: string };
}

export function RulesCard({ role }: { role?: string }) {
  const rules = useApi<RulesState>("/rules");
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    try {
      const out = await api<{ summary: string }>("/rules/check", { method: "POST" });
      toast(out.summary, "good");
      await rules.reload();
    } catch (e) {
      toast((e as Error).message, "crit");
    } finally {
      setChecking(false);
    }
  };
  const r = rules.data;
  return (
    <Card title="Regulator rules" action={role === "admin" && <Button className="min-h-8" busy={checking} onClick={check}>Check now</Button>}>
      {!r ? (
        <Loading />
      ) : (
        <div className="text-[13px]">
          <p>Built on the official {r.publisher} lists: <b>{r.denialCodes}</b> denial codes and <b className="num">{r.drugs.toLocaleString("en")}</b> drugs with regulated prices, plus the official e-claim format.</p>
          <p className="mt-1.5 text-muted">
            Lists from {date(r.updatedAt)}. {r.lastCheck ? `Last checked ${date(r.lastCheck.checkedAt)}: ${r.lastCheck.summary}` : "Checked automatically every day."}
          </p>
        </div>
      )}
    </Card>
  );
}

export interface PayerRisk {
  code: string;
  denialRate: number;
  mitigated: boolean;
  message: string;
  advice: string;
}

export function PayerMemory({ risks }: { risks: PayerRisk[] }) {
  if (!risks?.length) return null;
  return (
    <Card title="What this insurer usually does" action={<Badge tone="ai">Learned from past payments</Badge>}>
      <ul className="space-y-2">
        {risks.map((r) => (
          <li key={r.code} className={cx("rounded-lg border p-3 text-[13px]", r.mitigated ? "border-good/30 bg-good-soft/40" : "border-warn/40 bg-warn-soft/40")}>
            <p>{r.message}</p>
            <p className="mt-1 text-[12.5px] text-ink-2">{r.mitigated ? "✓ " : "Tip: "}{r.advice}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Result cards for copilot tool answers. */
export function AgentCards({ cards }: { cards: any[] }) {
  if (!cards?.length) return null;
  return (
    <div className="mt-2.5 space-y-2">
      {cards.map((c, i) => {
        if (c.type === "denial_code")
          return (
            <div key={i} className="rounded-lg bg-black/30 p-3 text-[13px]">
              <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-[12px]">{c.code}</span><Badge>{c.category}</Badge></div>
              <p className="mt-1 text-ink-2">Official wording: “{c.text}”</p>
              {c.openCount > 0 && <p className="mt-1 text-muted">{c.openCount} open · {aed(c.openAmount)}</p>}
            </div>
          );
        if (c.type === "denial")
          return (
            <button key={i} type="button" onClick={() => go(`/denials/${c.id}`)} className="flex w-full items-center justify-between gap-3 rounded-lg bg-black/30 p-3 text-left text-[13px] hover:bg-black/40">
              <span><span className="font-mono text-[12px]">{c.code}</span> · {c.activityCode} · {c.payerName}<span className="block text-[12px] text-muted">{c.plain}</span></span>
              <span className="text-right"><span className="num block font-semibold">{aed(c.amount)}</span><span className="text-[11.5px] text-muted">{c.band} chance · due {date(c.deadline)}</span></span>
            </button>
          );
        if (c.type === "claim")
          return (
            <button key={i} type="button" onClick={() => go(`/claims/${c.id}`)} className="block w-full rounded-lg bg-black/30 p-3 text-left text-[13px] hover:bg-black/40">
              <div className="flex justify-between"><span className="font-mono text-[12px]">{c.id}</span>{c.score !== undefined && <span className="num">{c.score}/100</span>}</div>
              <ul className="mt-1 space-y-0.5 text-[12.5px] text-ink-2">{c.issues.map((x: any, j: number) => <li key={j}>{x.severity === "blocking" ? "✕" : "!"} {x.message}</li>)}</ul>
              {c.risks?.filter((r: PayerRisk) => !r.mitigated).map((r: PayerRisk) => <p key={r.code} className="mt-1 text-[12.5px] text-[#ffb347]">{r.message}</p>)}
            </button>
          );
        if (c.type === "proposal")
          return (
            <div key={i} className="flex items-center justify-between gap-3 rounded-lg bg-black/30 p-3 text-[13px]">
              <span>{c.title}<span className="block text-[12px] text-muted">{c.summary}</span></span>
              <span className="text-right"><span className="num block font-semibold">{aed(c.amount)}</span><button type="button" className="text-[12px] text-[#ff8f6b] hover:underline" onClick={() => go("/inbox")}>Review →</button></span>
            </div>
          );
        return null;
      })}
    </div>
  );
}
