import { type ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export function Card({ title, action, children, className, pad = true }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={cx("glass rounded-2xl", className)}>
      {(title || action) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
          {action}
        </header>
      )}
      <div className={pad ? "p-4" : ""}>{children}</div>
    </section>
  );
}

type Variant = "primary" | "secondary" | "ghost" | "danger" | "ai";
export function Button({ variant = "secondary", busy, className, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  const styles: Record<Variant, string> = {
    primary: "keycap border-transparent font-semibold",
    secondary: "bg-white/[0.04] text-ink border-line hover:bg-white/[0.08] hover:border-white/20",
    ghost: "bg-transparent text-muted border-transparent hover:bg-white/[0.05] hover:text-ink",
    danger: "bg-crit/90 text-white border-transparent hover:bg-crit",
    ai: "warm-fill border-transparent font-semibold hover:brightness-110",
  };
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      className={cx("inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40", styles[variant], className)}
    >
      {busy && <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
      {children}
    </button>
  );
}

type Tone = "neutral" | "good" | "warn" | "crit" | "brand" | "ai";
export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  const tones: Record<Tone, string> = {
    neutral: "bg-white/[0.06] text-ink-2 ring-1 ring-inset ring-white/[0.06]",
    good: "bg-good-soft text-good-ink",
    warn: "bg-warn-soft text-warn-ink",
    crit: "bg-crit-soft text-crit",
    brand: "bg-brand-soft text-[#ff8f6b]",
    ai: "bg-ai-soft text-ai",
  };
  return <span className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-medium", tones[tone], className)}>{children}</span>;
}

export function AiTag({ engine }: { engine?: string }) {
  return (
    <Badge tone="ai" className="font-mono uppercase tracking-wider">
      <svg viewBox="0 0 16 16" className="size-3" aria-hidden><path fill="currentColor" d="M8 1l1.6 4.4L14 7 9.6 8.6 8 13 6.4 8.6 2 7l4.4-1.6z" /></svg>
      AI{engine === "sample" ? " · offline" : ""}
    </Badge>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  draft: "neutral",
  scrubbed: "brand",
  submitted: "brand",
  acknowledged: "brand",
  rejected: "crit",
  paid: "good",
  partially_paid: "warn",
  denied: "crit",
  resubmitted: "ai",
  written_off: "neutral",
  open: "crit",
  recovered: "good",
  lost: "neutral",
  approved: "good",
  pending: "warn",
  info_requested: "warn",
  to_code: "warn",
  coded: "brand",
  claimed: "good",
  answered: "good",
};
export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{status.replaceAll("_", " ")}</Badge>;
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "crit" | "good" }) {
  return (
    <div className="glass rounded-2xl p-4">
      <div className="text-[12px] font-medium text-muted">{label}</div>
      <div className={cx("mt-1.5 text-[26px] font-semibold leading-tight tracking-[-0.02em]", tone === "crit" && "warm-text", tone === "good" && "text-good-ink")}>{value}</div>
      {sub && <div className="mt-1 text-[12px] text-muted">{sub}</div>}
    </div>
  );
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[28px] font-semibold tracking-[-0.02em]">{title}</h1>
        {sub && <p className="mt-1 text-[14px] text-muted">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return <div role="alert" className="rounded-lg border border-crit/30 bg-crit-soft px-3 py-2 text-[13px] text-[#ff8a8f]">{error}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-[13px] text-muted">{children}</div>;
}

export function Loading() {
  return (
    <div className="space-y-2" aria-busy>
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-10 animate-pulse rounded-xl bg-white/[0.04]" />
      ))}
    </div>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="w-full min-w-[560px] border-collapse text-left text-[13px] [&_td]:border-b [&_td]:border-line [&_td]:px-2 [&_td]:py-2.5 [&_th]:border-b [&_th]:border-line [&_th]:px-2 [&_th]:py-2 [&_th]:text-[11.5px] [&_th]:font-medium [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted">
        {children}
      </table>
    </div>
  );
}

/** Clinical note with highlighted evidence spans. */
export function EvidenceNote({ note, spans, active }: { note: string; spans: { start: number; end: number; key: string }[]; active?: string | null }) {
  const sorted = [...spans].sort((a, b) => a.start - b.start).filter((s, i, arr) => i === 0 || s.start >= arr[i - 1].end);
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const s of sorted) {
    if (s.start > cursor) parts.push(note.slice(cursor, s.start));
    parts.push(
      <mark key={`${s.key}-${s.start}`} data-key={s.key} className={cx("evidence", active && s.key.split(" ").includes(active) && "active")}>
        {note.slice(s.start, s.end)}
      </mark>,
    );
    cursor = s.end;
  }
  parts.push(note.slice(cursor));
  return <pre className="whitespace-pre-wrap break-words font-sans text-[13.5px] leading-relaxed text-ink">{parts}</pre>;
}

export function ScoreGauge({ score, risk }: { score: number; risk?: number }) {
  const tone = score >= 90 ? "var(--good)" : score >= 60 ? "var(--warn)" : "var(--crit)";
  const r = 34;
  const c = 2 * Math.PI * r;
  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 84 84" className="size-[84px] -rotate-90" role="img" aria-label={`Clean-claim score ${score} of 100`}>
        <circle cx="42" cy="42" r={r} fill="none" stroke="var(--line)" strokeWidth="8" />
        <circle cx="42" cy="42" r={r} fill="none" stroke={tone} strokeWidth="8" strokeLinecap="round" strokeDasharray={`${(score / 100) * c} ${c}`} style={{ transition: "stroke-dasharray .5s ease" }} />
      </svg>
      <div>
        <div className="text-[30px] font-semibold leading-none tracking-tight">{score}<span className="text-[14px] font-normal text-muted"> / 100</span></div>
        <div className="mt-1 text-[12px] text-ink-2">Clean-claim score</div>
        {risk !== undefined && <div className="text-[12px] text-muted">Predicted denial risk {(risk * 100).toFixed(0)}%</div>}
      </div>
    </div>
  );
}

export function Timeline({ items }: { items: { status: string; at: string; by?: string; note?: string }[] }) {
  return (
    <ol className="relative space-y-3 border-l border-line pl-4">
      {items.map((t, i) => (
        <li key={`${t.at}-${i}`} className="relative">
          <span className="warm-fill absolute -left-[21px] top-1 size-2.5 rounded-full ring-2 ring-[#07080a]" />
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={t.status} />
            <span className="text-[12px] text-muted">{new Date(t.at).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
            {t.by && <span className="text-[12px] text-muted">by {t.by}</span>}
          </div>
          {t.note && <p className="mt-0.5 text-[12.5px] text-ink-2">{t.note}</p>}
        </li>
      ))}
    </ol>
  );
}

// ------------------------------------------------------------------ Toasts and dialogs
type Toast = { id: number; text: string; tone: "good" | "crit" | "neutral" };
const ToastCtx = createContext<(text: string, tone?: Toast["tone"]) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast["tone"] = "neutral") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4 md:bottom-6" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={cx("glass pointer-events-auto max-w-md rounded-xl px-4 py-2.5 text-[13px] shadow-2xl", t.tone === "crit" ? "text-[#ff8a8f]" : t.tone === "good" ? "text-good-ink" : "text-ink")}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function Dialog({ open, title, children, onClose, footer }: { open: boolean; title: string; children: ReactNode; onClose: () => void; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal aria-label={title} className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-line bg-[#0f1013] p-5 shadow-[0_30px_80px_-20px_rgba(255,60,50,0.25)] outline-none sm:rounded-2xl">
        <h3 className="mb-3 text-[16px] font-semibold">{title}</h3>
        {children}
        {footer && <div className="mt-4 flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] text-muted">{hint}</span>}
    </label>
  );
}
export const inputClass = "w-full rounded-lg border border-line bg-white/[0.03] px-3 py-2 text-[13.5px] text-ink placeholder:text-muted/70 focus:border-[#ff6b4a]/60 focus:outline-none";
