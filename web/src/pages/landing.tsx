import { type ReactNode, useEffect, useRef, useState } from "react";
import { Aurora, Logo, go } from "../App";
import { cx } from "../ui";

const QUERY = "resubmit MNEC-003 knee MRI";

const ROWS = [
  { label: "Draft resubmission", arg: "MNEC-003 · 73721 · AED 2,354", key: "⌘ ↵", href: "#/denials", icon: "spark" },
  { label: "Scrub claim", arg: "physio · Nahr Health", key: "⌘ B", href: "#/claims", icon: "shield" },
  { label: "Open denial worklist", arg: "15 open · sorted by priority", key: "⌘ O", href: "#/denials", icon: "list" },
  { label: "Ask copilot", arg: "why did Nahr denials rise?", key: "⌘ K", href: "#/dashboard", icon: "chat" },
] as const;

const NAV = [
  ["Problem", "problem"],
  ["How it works", "how"],
  ["Product", "product"],
  ["Outcomes", "outcomes"],
  ["Trust", "trust"],
] as const;

const PATHS: Record<string, string> = {
  spark: "M8 1l1.6 4.4L14 7 9.6 8.6 8 13 6.4 8.6 2 7l4.4-1.6z",
  shield: "M8 1 2 3.5v4C2 11 4.6 14.2 8 15c3.4-.8 6-4 6-7.5v-4zm-1 10L4.5 8.5l1-1L7 9l3.5-3.5 1 1z",
  list: "M2 3h2v2H2zm4 0h8v2H6zM2 7h2v2H2zm4 0h8v2H6zm-4 4h2v2H2zm4 0h8v2H6z",
  chat: "M2 2h12v9H6l-3 3v-3H2z",
  search: "M7 2a5 5 0 1 0 3.1 8.9l3 3 1-1-3-3A5 5 0 0 0 7 2m0 1.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7",
  doc: "M3 1h7l3 3v11H3zm1.5 1.5v11h7V5H9V2.5zM5.5 7h5v1.2h-5zm0 2.5h5v1.2h-5z",
  code: "M8.6 1.5H14v5.4L7.4 13.5 2.5 8.6zm2.9 1.6a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8",
  send: "M1.5 2 15 8 1.5 14l1.8-5.2L9 8 3.3 7.2z",
  undo: "M6 3 2 7l4 4V8h4a2.5 2.5 0 0 1 0 5H8v1.5h2a4 4 0 0 0 0-8H6z",
  coin: "M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1m.7 11v1H7.3v-1C6 11.8 5 11 5 9.8h1.4c0 .6.6 1 1.6 1s1.6-.4 1.6-1c0-.7-.6-.9-1.8-1.2C6.3 8.3 5.2 7.9 5.2 6.5c0-1 .8-1.8 2.1-2V3.5h1.4v1c1.2.2 2 1 2.1 2.1H9.4c0-.6-.6-1-1.4-1-.9 0-1.4.4-1.4.9 0 .6.6.8 1.8 1.1 1.5.4 2.6.8 2.6 2.3 0 1.1-.9 1.9-2.3 2.1",
  eye: "M8 3C4.4 3 1.7 5.4 1 8c.7 2.6 3.4 5 7 5s6.3-2.4 7-5c-.7-2.6-3.4-5-7-5m0 8.2A3.2 3.2 0 1 1 8 4.8a3.2 3.2 0 0 1 0 6.4M8 6.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2",
  lock: "M4 7V5a4 4 0 1 1 8 0v2h1v8H3V7zm1.5 0h5V5a2.5 2.5 0 0 0-5 0z",
  check: "M6.2 11.2 2.8 7.8l1-1 2.4 2.3 6-6 1 1z",
  clock: "M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1m.7 7.3 2.8 1.7-.7 1.2-3.5-2.1V4h1.4z",
  arrow: "M6 3l5 5-5 5-1-1 4-4-4-4z",
};

function Icon({ name, className = "size-4" }: { name: string; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cx(className, "shrink-0")} fill="currentColor" aria-hidden>
      <path d={PATHS[name]} />
    </svg>
  );
}

function Typed() {
  const [n, setN] = useState(QUERY.length);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let i = 0;
    setN(0);
    const t = setInterval(() => {
      i++;
      setN(i);
      if (i >= QUERY.length) clearInterval(t);
    }, 70);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="text-[15px] text-white">
      {QUERY.slice(0, n)}
      <span className="caret" />
    </span>
  );
}

/** Fades a block in the first time it scrolls into view. */
function Reveal({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !("IntersectionObserver" in window)) return setShown(true);
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className={cx("reveal", shown && "in", className)} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="mb-4 inline-flex items-center gap-2 font-mono text-[11.5px] uppercase tracking-[0.14em] text-[#ffb347]">
      <span className="warm-fill h-px w-6" />
      {children}
    </div>
  );
}

function SectionHead({ eyebrow, title, sub }: { eyebrow: string; title: ReactNode; sub?: string }) {
  return (
    <Reveal className="mx-auto mb-12 max-w-[720px] text-center">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className="text-[clamp(30px,4.2vw,44px)] font-semibold leading-[1.12] tracking-[-0.025em] text-white">{title}</h2>
      {sub && <p className="mx-auto mt-4 max-w-[600px] text-[16.5px] leading-relaxed text-white/60">{sub}</p>}
    </Reveal>
  );
}

// ------------------------------------------------------------------ Hero

function NavBar() {
  return (
    <header className="glass pointer-events-auto flex w-full max-w-[920px] items-center gap-2 rounded-full py-1.5 pl-4 pr-1.5 shadow-[0_10px_40px_-12px_rgba(0,0,0,0.8)]">
      <a href="#/" className="flex items-center gap-2">
        <Logo />
        <span className="text-[15px] font-semibold tracking-[-0.01em]">Sanad</span>
      </a>
      <nav className="mx-auto hidden items-center gap-6 md:flex">
        {NAV.map(([label, id]) => (
          <button key={id} type="button" onClick={() => scrollTo(id)} className="text-[14px] font-medium text-[#9c9c9d] transition hover:text-white">
            {label}
          </button>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-3 md:ml-0">
        <a href="#/login" className="hidden text-[14px] font-medium text-[#9c9c9d] hover:text-white sm:block">Log in</a>
        <button type="button" onClick={() => go("/dashboard")} className="flex items-center gap-1.5 rounded-full bg-[#f2f2f2] px-3.5 py-1.5 text-[13px] font-semibold text-[#2f3031] hover:bg-white">
          Open workspace
          <Icon name="arrow" className="size-3.5" />
        </button>
      </div>
    </header>
  );
}

function Hero() {
  const [active, setActive] = useState(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") setActive((a) => (a + 1) % ROWS.length);
      if (e.key === "ArrowUp") setActive((a) => (a + ROWS.length - 1) % ROWS.length);
      if (e.key === "Enter" && document.activeElement === document.body) window.location.hash = ROWS[active].href.slice(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  return (
    <section className="relative -mt-16 flex min-h-[100svh] flex-col items-center px-4 pb-16 pt-16">
      <div className="mt-[clamp(48px,10vh,110px)] flex max-w-[880px] flex-col items-center text-center">
        <button type="button" onClick={() => scrollTo("how")} className="glass hero-in mb-7 inline-flex items-center gap-2 rounded-full px-3 py-1 text-[12.5px] text-[#c9c9ca] hover:text-white">
          <span className="warm-fill size-1.5 rounded-full" />
          For UAE clinics on DHA eClaimLink &amp; DOH Shafafiya
          <span className="text-[#9c9c9d]">→</span>
        </button>
        <h1 className="hero-title hero-in" style={{ animationDelay: "80ms" }}>
          Every claim clean.
          <br />
          Every dirham <span className="warm-text">collected.</span>
        </h1>
        <p className="hero-in mt-6 max-w-[640px] text-[18px] leading-relaxed tracking-[0.2px] text-white/65" style={{ animationDelay: "160ms" }}>
          Sanad turns a doctor&apos;s note into a clean insurance claim, chases every denial with an appeal that cites the note, and shows you exactly when the money will land.
        </p>
        <div className="hero-in mt-10 flex w-full flex-col items-stretch justify-center gap-4 sm:w-auto sm:flex-row sm:items-center" style={{ animationDelay: "240ms" }}>
          <button type="button" onClick={() => go("/coding/enc_0001")} className="keycap flex items-center justify-center gap-2 px-5 py-3 text-[14px] font-medium">
            <Icon name="code" />
            Turn a note into billing codes
          </button>
          <button type="button" onClick={() => go("/denials")} className="keycap flex items-center justify-center gap-2 px-5 py-3 text-[14px] font-medium">
            <Icon name="undo" />
            Work the denial worklist
          </button>
        </div>
      </div>

      <div className="hero-in mt-14 w-full max-w-[680px] overflow-hidden rounded-[14px] border border-white/10 bg-[rgba(14,15,18,0.72)] shadow-[0_40px_120px_-30px_rgba(255,60,50,0.45),0_20px_60px_-20px_rgba(0,0,0,0.9)] backdrop-blur-xl" style={{ animationDelay: "320ms" }}>
        <div className="flex items-center gap-3 border-b border-white/[0.07] px-4 py-3.5">
          <span className="text-[#9c9c9d]"><Icon name="search" /></span>
          <Typed />
          <span className="ml-auto rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11.5px] font-medium text-[#c9c9ca]">Copilot</span>
        </div>
        <ul className="p-1.5" aria-label="Commands">
          {ROWS.map((r, i) => (
            <li key={r.label}>
              <a
                href={r.href}
                onMouseEnter={() => setActive(i)}
                className={cx("flex items-center gap-3 rounded-[10px] px-3 py-2.5 text-[14px]", i === active ? "active-row text-white" : "text-[#c9c9ca]")}
              >
                <span className={i === active ? "text-[#ffb347]" : "text-[#9c9c9d]"}><Icon name={r.icon} /></span>
                <span className="font-medium">{r.label}</span>
                <span className="hidden truncate font-mono text-[12px] text-[#9c9c9d] sm:inline">{r.arg}</span>
                <span className="kbd ml-auto">{r.key}</span>
              </a>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-3 border-t border-white/[0.07] px-4 py-2.5 font-mono text-[11px] text-[#9c9c9d]">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span className="hidden sm:inline">esc dismiss</span>
          <span className="ml-auto flex items-center gap-1.5 font-sans text-[12px] font-semibold text-[#c9c9ca]"><Logo size={14} /> Sanad</span>
        </div>
      </div>

      <button type="button" onClick={() => scrollTo("problem")} className="mt-12 flex flex-col items-center gap-2 text-[12px] text-[#9c9c9d] hover:text-white" aria-label="Scroll to learn more">
        <span className="scroll-cue" />
      </button>
    </section>
  );
}

// ------------------------------------------------------------------ Proof strip

const PROOF = [
  { value: "90%", label: "principal diagnosis correct", note: "18 of 20 gold notes" },
  { value: "30/30", label: "claim errors caught pre-submission", note: "0 false flags" },
  { value: "< 2 s", label: "to draft a cited appeal", note: "every sentence quotes the note" },
  { value: "100%", label: "remittance lines reconciled", note: "5/5 underpayments flagged" },
];

function Proof() {
  return (
    <div className="mx-auto grid max-w-[1080px] grid-cols-2 gap-px overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.06] lg:grid-cols-4">
      {PROOF.map((p, i) => (
        <Reveal key={p.label} delay={i * 70} className="bg-[#0b0c0f] px-5 py-6 sm:px-7">
          <div className="warm-text num text-[clamp(30px,4vw,42px)] font-semibold leading-none tracking-[-0.03em]">{p.value}</div>
          <div className="mt-3 text-[14px] font-medium text-white/85">{p.label}</div>
          <div className="mt-1 font-mono text-[11.5px] text-[#9c9c9d]">{p.note}</div>
        </Reveal>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ Problem

const LEAKS = [
  { icon: "shield", title: "Rejected for fixable reasons", body: "A missing prior approval, a code the note doesn't support, a price above contract. Each one is a denial, a delay, and rework." },
  { icon: "clock", title: "Denials that expire", body: "They arrive as cryptic insurer payment files, pile up in no order, and quietly pass the resubmission window." },
  { icon: "coin", title: "Underpayments nobody sees", body: "No one has time to check every paid line against the contract price, so the gap is simply lost." },
  { icon: "eye", title: "Cash you can't predict", body: "Finance can't see what's stuck, with which payer, or what will actually land this month." },
];

function Problem() {
  return (
    <section id="problem" className="scroll-mt-24 px-4 py-24 sm:py-28">
      <SectionHead
        eyebrow="The problem"
        title={<>Clinics do the work. <span className="text-white/45">The money leaks on the way to the bank.</span></>}
        sub="Getting paid by UAE insurers is a manual chain of hand-offs, and every hand-off loses revenue."
      />
      <div className="mx-auto grid max-w-[1080px] gap-4 sm:grid-cols-2">
        {LEAKS.map((l, i) => (
          <Reveal key={l.title} delay={i * 60}>
            <div className="lift group h-full rounded-2xl border border-white/[0.08] bg-white/[0.025] p-6">
              <div className="mb-4 grid size-10 place-items-center rounded-xl border border-[#ff6b4a]/25 bg-[#ff2f3a]/[0.08] text-[#ff6b4a]">
                <Icon name={l.icon} className="size-[18px]" />
              </div>
              <h3 className="text-[17px] font-semibold tracking-[-0.01em] text-white">{l.title}</h3>
              <p className="mt-2 text-[14.5px] leading-relaxed text-white/60">{l.body}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ How it works

const STEPS = [
  { icon: "doc", title: "Note in", body: "Typed, PDF, photo or scan, or pushed from your EMR." },
  { icon: "code", title: "Billing codes found", body: "AI picks the diagnosis and treatment codes insurers need, each tied to the sentence that supports it." },
  { icon: "shield", title: "Scrubbed", body: "10 rule families and a 0–100 clean-claim score, with one-click fixes." },
  { icon: "send", title: "Approved & sent", body: "A named person approves; regulator-format XML goes out." },
  { icon: "undo", title: "Denials worked", body: "Ranked by value and deadline, with an appeal drafted from the note." },
  { icon: "coin", title: "Cash reconciled", body: "Every line matched, underpayments flagged, 30/60/90-day forecast." },
];

function How() {
  return (
    <section id="how" className="scroll-mt-24 px-4 py-24 sm:py-28">
      <SectionHead
        eyebrow="How it works"
        title={<>From the doctor&apos;s note <span className="warm-text">to money in the bank.</span></>}
        sub="One flow, six steps. AI drafts, rules decide, and a person approves everything that leaves the clinic."
      />
      <ol className="relative mx-auto grid max-w-[1080px] gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {STEPS.map((s, i) => (
          <Reveal key={s.title} delay={i * 60}>
            <li className="lift relative h-full list-none overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0b0c0f]/80 p-6">
              <span className="pointer-events-none absolute -right-2 -top-5 font-mono text-[84px] font-semibold leading-none text-white/[0.035]">{String(i + 1).padStart(2, "0")}</span>
              <div className="flex items-center gap-3">
                <span className="warm-fill grid size-9 place-items-center rounded-lg"><Icon name={s.icon} /></span>
                <span className="font-mono text-[11.5px] text-[#9c9c9d]">Step {i + 1}</span>
              </div>
              <h3 className="mt-4 text-[17px] font-semibold text-white">{s.title}</h3>
              <p className="mt-1.5 text-[14.5px] leading-relaxed text-white/60">{s.body}</p>
            </li>
          </Reveal>
        ))}
      </ol>
    </section>
  );
}

// ------------------------------------------------------------------ Product bento

function Panel({ title, sub, children, className, href }: { title: string; sub: string; children: ReactNode; className?: string; href: string }) {
  return (
    <a href={href} className={cx("lift group flex flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0b0c0f]/85", className)}>
      <div className="relative flex-1 border-b border-white/[0.06] bg-[radial-gradient(ellipse_at_top,rgba(255,107,74,0.10),transparent_65%)] p-5">{children}</div>
      <div className="flex items-start gap-3 p-5">
        <div>
          <h3 className="text-[16px] font-semibold text-white">{title}</h3>
          <p className="mt-1 text-[14px] leading-relaxed text-white/55">{sub}</p>
        </div>
        <Icon name="arrow" className="ml-auto mt-1 size-4 text-[#9c9c9d] transition group-hover:translate-x-0.5 group-hover:text-white" />
      </div>
    </a>
  );
}

function EvidenceMock() {
  return (
    <div className="space-y-3 font-mono text-[12.5px] leading-relaxed text-white/70">
      <p>
        54F, known <mark className="evidence">type 2 diabetes mellitus</mark>, HbA1c 8.2% today. Reports{" "}
        <mark className="evidence active">right knee pain for 8 weeks</mark> despite physiotherapy…
      </p>
      <div className="flex flex-wrap gap-2 font-sans">
        {[
          ["E11.9", "Type 2 DM", "96%"],
          ["M25.561", "Pain, right knee", "91%"],
          ["73721", "MRI knee", "88%"],
        ].map(([c, d, p], i) => (
          <span key={c} className={cx("inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12px]", i === 1 ? "border-[#ff6b4a]/50 bg-[#ff6b4a]/10 text-white" : "border-white/10 bg-white/[0.03] text-white/75")}>
            <span className="font-mono font-semibold">{c}</span>
            <span className="text-white/50">{d}</span>
            <span className="font-mono text-[#ffb347]">{p}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function ScoreMock() {
  const r = 38;
  const c = 2 * Math.PI * r;
  return (
    <div className="flex items-center gap-5">
      <svg viewBox="0 0 100 100" className="size-[104px] shrink-0 -rotate-90" aria-hidden>
        <defs>
          <linearGradient id="score" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffb347" />
            <stop offset="1" stopColor="#ff2f3a" />
          </linearGradient>
        </defs>
        <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="9" />
        <circle cx="50" cy="50" r={r} fill="none" stroke="url(#score)" strokeWidth="9" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * 0.44} className="score-arc" />
      </svg>
      <div className="min-w-0 flex-1 space-y-2 text-[12.5px]">
        <div className="flex items-baseline gap-2"><span className="num text-[28px] font-semibold text-white">56</span><span className="text-white/45">/ 100 clean-claim score</span></div>
        {["Prior approval missing", "Price above contract"].map((t) => (
          <div key={t} className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5">
            <span className="size-1.5 rounded-full bg-[#ff4d55]" />
            <span className="truncate text-white/75">{t}</span>
            <span className="ml-auto rounded-md bg-white/[0.08] px-1.5 py-0.5 text-[11px] text-white">Fix</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function WorklistMock() {
  const rows = [
    ["MNEC-003", "Medical necessity", "AED 2,354", "3 d", 92],
    ["AUTH-001", "No prior approval", "AED 1,180", "9 d", 71],
    ["CODE-014", "Code mismatch", "AED 640", "21 d", 44],
  ] as const;
  return (
    <div className="space-y-2 text-[12.5px]">
      {rows.map(([code, why, amt, due, pri]) => (
        <div key={code} className="flex items-center gap-3 rounded-lg border border-white/[0.07] bg-white/[0.025] px-3 py-2">
          <span className="font-mono text-white/80">{code}</span>
          <span className="hidden truncate text-white/45 sm:inline">{why}</span>
          <span className="num ml-auto text-white">{amt}</span>
          <span className="w-9 text-right font-mono text-[11px] text-[#ffb347]">{due}</span>
          <span className="h-1.5 w-12 overflow-hidden rounded-full bg-white/[0.08]"><span className="warm-fill block h-full" style={{ width: `${pri}%` }} /></span>
        </div>
      ))}
    </div>
  );
}

function ForecastMock() {
  const bars = [
    ["30 d", 72],
    ["60 d", 48],
    ["90 d", 30],
  ] as const;
  return (
    <div className="flex h-full items-end gap-4">
      {bars.map(([l, h], i) => (
        <div key={l} className="flex flex-1 flex-col items-center gap-2">
          <div className="flex h-[112px] w-full items-end">
            <div className={cx("bar-grow w-full rounded-t-md", i === 0 ? "warm-fill" : "bg-white/[0.12]")} style={{ height: `${h}%`, transitionDelay: `${200 + i * 120}ms` }} />
          </div>
          <span className="font-mono text-[11px] text-[#9c9c9d]">{l}</span>
        </div>
      ))}
    </div>
  );
}

function Product() {
  return (
    <section id="product" className="scroll-mt-24 px-4 py-24 sm:py-28">
      <SectionHead
        eyebrow="Product"
        title={<>Evidence behind every code. <span className="text-white/45">A reason behind every dirham.</span></>}
        sub="Sanad (سند) means “supporting document”. Nothing it suggests is a black box: every code, flag and appeal points back to the note."
      />
      <div className="mx-auto grid max-w-[1080px] gap-4 lg:grid-cols-5">
        <Reveal className="lg:col-span-3">
          <Panel href="#/coding/enc_0001" title="Billing codes, with the reason shown" sub="Each suggested code highlights the exact sentence behind it. Vague notes become a one-click doctor query." className="h-full">
            <EvidenceMock />
          </Panel>
        </Reveal>
        <Reveal className="lg:col-span-2" delay={80}>
          <Panel href="#/claims" title="Scrubber with one-click fixes" sub="Catches rejections before the payer does." className="h-full">
            <ScoreMock />
          </Panel>
        </Reveal>
        <Reveal className="lg:col-span-2" delay={40}>
          <Panel href="#/dashboard" title="Cash forecast" sub="30/60/90-day view with its assumptions shown." className="h-full">
            <ForecastMock />
          </Panel>
        </Reveal>
        <Reveal className="lg:col-span-3" delay={120}>
          <Panel href="#/denials" title="Denial worklist, ranked" sub="Amount × recovery chance × deadline, so the team works the money that matters first." className="h-full">
            <WorklistMock />
          </Panel>
        </Reveal>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ Outcomes and roles

const OUTCOMES = [
  ["↑", "First-pass acceptance", "Claims paid on the first submission"],
  ["48 h", "Denials worked", "Every denial acted on within two days"],
  ["↑", "AED recovered", "Resubmissions and underpayments collected"],
  ["↓", "Days in A/R", "Cash lands sooner, forecast you can plan on"],
] as const;

const ROLES = [
  ["Claims coder", "Billing codes with the reason already highlighted"],
  ["Biller", "Scrubs, submits and works the ranked worklist"],
  ["Doctor", "Only asked when the note is missing something"],
  ["Finance", "Reconciliation, AED at risk and the forecast"],
  ["Front desk", "Eligibility, prior approval and cost estimates"],
  ["Patient", "A plain-language bill, no login needed"],
] as const;

function Outcomes() {
  return (
    <section id="outcomes" className="scroll-mt-24 px-4 py-24 sm:py-28">
      <SectionHead
        eyebrow="Outcomes"
        title={<>Measured on the numbers <span className="warm-text">your clinic already watches.</span></>}
        sub="Sanad's dashboard tracks each of these from day one, so a pilot is judged against your own baseline."
      />
      <div className="mx-auto grid max-w-[1080px] gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {OUTCOMES.map(([big, title, sub], i) => (
          <Reveal key={title} delay={i * 60}>
            <div className="lift h-full rounded-2xl border border-white/[0.08] bg-white/[0.025] p-6">
              <div className="warm-text text-[34px] font-semibold leading-none tracking-[-0.03em]">{big}</div>
              <div className="mt-4 text-[15.5px] font-semibold text-white">{title}</div>
              <div className="mt-1 text-[14px] leading-relaxed text-white/55">{sub}</div>
            </div>
          </Reveal>
        ))}
      </div>

      <Reveal className="mx-auto mt-16 max-w-[1080px]">
        <div className="rounded-2xl border border-white/[0.08] bg-[#0b0c0f]/80 p-6 sm:p-8">
          <div className="mb-6 flex flex-wrap items-end gap-3">
            <h3 className="text-[20px] font-semibold tracking-[-0.01em] text-white">Built for the whole clinic</h3>
            <span className="text-[14px] text-white/50">Six roles, each seeing only what they need.</span>
          </div>
          <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
            {ROLES.map(([role, what]) => (
              <div key={role} className="flex items-start gap-3">
                <span className="mt-0.5 grid size-5 place-items-center rounded-full bg-[#ff6b4a]/15 text-[#ff6b4a]"><Icon name="check" className="size-3" /></span>
                <div>
                  <div className="text-[14.5px] font-medium text-white">{role}</div>
                  <div className="text-[13.5px] text-white/50">{what}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </Reveal>
    </section>
  );
}

// ------------------------------------------------------------------ Trust

const TRUST = [
  ["check", "Human approval on every submission", "AI drafts. A named person approves before anything reaches a payer."],
  ["list", "Tamper-evident audit log", "Every AI suggestion and every decision is recorded and hash-chained."],
  ["lock", "Encrypted identifiers", "Emirates IDs are encrypted at rest; six roles with least-privilege access."],
  ["doc", "Regulator-format claims", "DHA eClaimLink and DOH Shafafiya-style XML, validated before it's sent."],
  ["eye", "Patient bill explainer", "Upload any bill photo and get a plain explanation plus questions to ask your insurer."],
] as const;

function Trust() {
  return (
    <section id="trust" className="scroll-mt-24 px-4 py-24 sm:py-28">
      <SectionHead eyebrow="Trust" title={<>AI drafts. Rules decide. <span className="text-white/45">People approve.</span></>} />
      <div className="mx-auto grid max-w-[1080px] gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {TRUST.map(([icon, title, body], i) => (
          <Reveal key={title} delay={i * 60}>
            <div className="lift flex h-full gap-4 rounded-2xl border border-white/[0.08] bg-white/[0.025] p-6">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.04] text-[#ffb347]"><Icon name={icon} className="size-[18px]" /></span>
              <div>
                <h3 className="text-[16px] font-semibold text-white">{title}</h3>
                <p className="mt-1.5 text-[14.5px] leading-relaxed text-white/55">{body}</p>
              </div>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ Closing CTA and footer

function Closing() {
  return (
    <section className="px-4 pb-10 pt-12 sm:pt-16">
      <Reveal className="relative mx-auto max-w-[1080px] overflow-hidden rounded-3xl border border-white/10 px-6 py-16 text-center sm:px-12 sm:py-20">
        <div className="cta-glow pointer-events-none absolute inset-0" aria-hidden />
        <div className="relative">
          <Logo size={40} />
          <h2 className="mx-auto mt-6 max-w-[640px] text-[clamp(30px,4.4vw,48px)] font-semibold leading-[1.1] tracking-[-0.025em] text-white">
            Get paid for the care <span className="warm-text">you already gave.</span>
          </h2>
          <p className="mx-auto mt-4 max-w-[520px] text-[16.5px] text-white/60">Open the workspace and follow one claim from the doctor&apos;s note all the way to cash.</p>
          <div className="mt-9 flex flex-col items-stretch justify-center gap-4 sm:flex-row sm:items-center">
            <button type="button" onClick={() => go("/dashboard")} className="keycap flex items-center justify-center gap-2 px-6 py-3 text-[14px] font-semibold">
              Open workspace
              <Icon name="arrow" className="size-3.5" />
            </button>
            <button type="button" onClick={() => go("/coding/enc_0001")} className="ghost-pill px-5 py-2.5 text-[14px] font-medium">
              Try it on a doctor's note
            </button>
          </div>
          <div className="mt-6">
            <button type="button" onClick={() => go("/explain")} className="text-[13px] text-white/50 hover:text-white">
              Explain a bill photo →
            </button>
          </div>
        </div>
      </Reveal>
      <footer className="mx-auto mt-12 flex max-w-[1080px] flex-col items-center justify-between gap-4 border-t border-white/[0.07] pt-6 text-[13px] text-[#9c9c9d] sm:flex-row">
        <div className="flex items-center gap-2">
          <Logo size={16} />
          <span className="font-semibold text-white/85">Sanad</span>
          <span>· سند · the supporting document</span>
        </div>
        <div className="flex items-center gap-5">
          {NAV.slice(1, 4).map(([label, id]) => (
            <button key={id} type="button" onClick={() => scrollTo(id)} className="hover:text-white">{label}</button>
          ))}
          <span>Hub71 Hackathon</span>
        </div>
      </footer>
    </section>
  );
}

export function Landing() {
  return (
    <div className="relative min-h-screen overflow-x-clip">
      <Aurora />
      <div className="relative z-10">
        <div className="pointer-events-none sticky top-[calc(env(safe-area-inset-top,0px)+12px)] z-30 flex justify-center px-4 pt-5">
          <NavBar />
        </div>
        <Hero />
        {/* Below the hero the aurora fades to the page colour so long-form content stays legible. */}
        <div className="landing-body">
          <div className="px-4">
            <Proof />
          </div>
          <Problem />
          <How />
          <Product />
          <Outcomes />
          <Trust />
          <Closing />
        </div>
      </div>
    </div>
  );
}
