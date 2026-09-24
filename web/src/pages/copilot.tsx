// The copilot as a command bar (⌘K): dark glass, warm caret, suggestions with shortcut chips.
// Data answers expose the read-only SQL and rows; tool answers render as cards, and drafted
// appeals go to the approval inbox instead of being sent.
import { useEffect, useRef, useState } from "react";
import { api, useApi } from "../api";
import { AiTag, cx } from "../ui";
import { AgentCards } from "./agents";

interface Turn {
  question: string;
  answer?: string;
  sql?: string;
  rows?: Record<string, unknown>[];
  fields?: string[];
  error?: string;
  engine?: string;
  cards?: any[];
}

export function CopilotPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useApi<any>(open ? "/reference" : null);
  const me = useApi<any>(open ? "/me" : null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const examples: string[] = ref.data?.examples ?? [];

  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 30);
  }, [open]);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [turns]);

  const ask = async (question: string) => {
    if (!question.trim() || busy) return;
    setQ("");
    setBusy(true);
    setTurns((t) => [...t, { question }]);
    try {
      const res = await api("/copilot/agent", { json: { question } });
      setTurns((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, ...res } : x)));
    } catch (e) {
      setTurns((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, error: (e as Error).message } : x)));
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    if (!q && examples.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % examples.length); }
      if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a + examples.length - 1) % examples.length); }
    }
    if (e.key === "Enter") {
      e.preventDefault();
      void ask(q || examples[active] || "");
    }
  };
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 px-3 pt-[12vh] backdrop-blur-[3px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Claims copilot" onKeyDown={onKey} className="flex max-h-[76vh] w-full max-w-[680px] flex-col overflow-hidden rounded-[14px] border border-white/10 bg-[rgba(14,15,18,0.88)] shadow-[0_40px_120px_-30px_rgba(255,60,50,0.45),0_20px_60px_-20px_rgba(0,0,0,0.9)] backdrop-blur-xl">
        <div className="flex items-center gap-3 border-b border-white/[0.07] px-4 py-3.5">
          <svg viewBox="0 0 16 16" className="size-4 text-muted" fill="currentColor" aria-hidden><path d="M7 2a5 5 0 1 0 3.1 8.9l3 3 1-1-3-3A5 5 0 0 0 7 2m0 1.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7" /></svg>
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Ask about money, or: draft appeals for Nahr denials…"
            aria-label="Ask the claims copilot"
            className="flex-1 bg-transparent text-[15px] text-white caret-[#ff6b4a] placeholder:text-muted focus:outline-none"
          />
          {busy ? <span className="size-3.5 animate-spin rounded-full border-2 border-[#ff6b4a] border-t-transparent" /> : <AiTag engine={me.data?.ai} />}
        </div>

        <div className="flex-1 overflow-y-auto p-1.5">
          {!turns.length && (
            <ul aria-label="Suggested questions">
              {examples.map((e, i) => (
                <li key={e}>
                  <button type="button" onMouseEnter={() => setActive(i)} onClick={() => ask(e)} className={cx("flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left text-[14px]", i === active ? "active-row text-white" : "text-ink-2")}>
                    <svg viewBox="0 0 16 16" className={cx("size-4 shrink-0", i === active ? "text-[#ffb347]" : "text-muted")} fill="currentColor" aria-hidden><path d="M2 2h12v9H6l-3 3v-3H2z" /></svg>
                    <span className="font-medium">{e}</span>
                    {i === active && <span className="kbd ml-auto">↵</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="space-y-4 px-2.5 py-2">
            {turns.map((t, i) => (
              <div key={i} className="space-y-2">
                <div className="font-mono text-[12px] text-muted">› {t.question}</div>
                {t.answer === undefined && !t.error ? (
                  <div className="h-12 animate-pulse rounded-xl bg-white/[0.04]" />
                ) : t.error ? (
                  <div className="rounded-xl bg-crit-soft px-3 py-2 text-[13px] text-[#ff8a8f]">{t.error}</div>
                ) : (
                  <div className="active-row rounded-xl px-3.5 py-3 text-[14px] leading-relaxed text-white">
                    {t.answer}
                    <AgentCards cards={t.cards ?? []} />
                    {t.sql && (
                      <details className="mt-2 text-[12px]">
                        <summary className="cursor-pointer text-muted">Read-only query · {t.rows?.length ?? 0} source row(s)</summary>
                        <pre className="mt-1.5 overflow-x-auto rounded-lg bg-black/40 p-2.5 font-mono text-[11px] text-ink-2">{t.sql}</pre>
                        {!!t.rows?.length && (
                          <div className="mt-1.5 overflow-x-auto">
                            <table className="font-mono text-[11px]">
                              <thead><tr>{t.fields?.map((f) => <th key={f} className="px-1.5 py-1 text-left font-medium text-muted">{f}</th>)}</tr></thead>
                              <tbody>{t.rows.slice(0, 10).map((r, j) => <tr key={j}>{t.fields?.map((f) => <td key={f} className="num px-1.5 py-0.5 text-ink-2">{String(r[f] ?? "")}</td>)}</tr>)}</tbody>
                            </table>
                          </div>
                        )}
                      </details>
                    )}
                  </div>
                )}
              </div>
            ))}
            <div ref={end} />
          </div>
        </div>

        <div className="flex items-center gap-3 border-t border-white/[0.07] px-4 py-2.5 font-mono text-[11px] text-muted">
          <span>↑↓ navigate</span>
          <span>↵ ask</span>
          <span>esc dismiss</span>
          <span className="ml-auto">nothing is sent without your approval</span>
        </div>
      </div>
    </div>
  );
}
