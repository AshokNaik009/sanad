import { useEffect, useState } from "react";
import { Aurora, Logo, go } from "../App";
import { cx } from "../ui";

const QUERY = "resubmit MNEC-003 knee MRI";

const ROWS = [
  { label: "Draft resubmission", arg: "MNEC-003 · 73721 · AED 2,354", key: "⌘ ↵", href: "#/denials", icon: "spark" },
  { label: "Scrub claim", arg: "physio · Nahr Health", key: "⌘ B", href: "#/claims", icon: "shield" },
  { label: "Open denial worklist", arg: "15 open · sorted by priority", key: "⌘ O", href: "#/denials", icon: "list" },
  { label: "Ask copilot", arg: "why did Nahr denials rise?", key: "⌘ K", href: "#/dashboard", icon: "chat" },
] as const;

function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    spark: "M8 1l1.6 4.4L14 7 9.6 8.6 8 13 6.4 8.6 2 7l4.4-1.6z",
    shield: "M8 1 2 3.5v4C2 11 4.6 14.2 8 15c3.4-.8 6-4 6-7.5v-4zm-1 10L4.5 8.5l1-1L7 9l3.5-3.5 1 1z",
    list: "M2 3h2v2H2zm4 0h8v2H6zM2 7h2v2H2zm4 0h8v2H6zm-4 4h2v2H2zm4 0h8v2H6z",
    chat: "M2 2h12v9H6l-3 3v-3H2z",
    search: "M7 2a5 5 0 1 0 3.1 8.9l3 3 1-1-3-3A5 5 0 0 0 7 2m0 1.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7",
  };
  return (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0" fill="currentColor" aria-hidden>
      <path d={paths[name]} />
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

export function Landing() {
  const [active, setActive] = useState(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") setActive((a) => (a + 1) % ROWS.length);
      if (e.key === "ArrowUp") setActive((a) => (a + ROWS.length - 1) % ROWS.length);
      if (e.key === "Enter") window.location.hash = ROWS[active].href.slice(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  return (
    <div className="relative min-h-screen overflow-hidden">
      <Aurora />
      <div className="relative z-10 flex min-h-screen flex-col items-center px-4 pb-10 pt-5">
        {/* Floating pill nav */}
        <header className="glass flex w-full max-w-[880px] items-center gap-2 rounded-full py-1.5 pl-4 pr-1.5 shadow-[0_10px_40px_-12px_rgba(0,0,0,0.8)]">
          <a href="#/" className="flex items-center gap-2">
            <Logo />
            <span className="text-[15px] font-semibold tracking-[-0.01em]">Sanad</span>
          </a>
          <nav className="mx-auto hidden items-center gap-6 md:flex">
            {[["Product", "#/dashboard"], ["Coding", "#/coding"], ["Denials", "#/denials"], ["Compliance", "#/audit"], ["Changelog", "#/claims"]].map(([l, h]) => (
              <a key={l} href={h} className="text-[14px] font-medium text-[#9c9c9d] transition hover:text-white">{l}</a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 md:ml-0">
            <a href="#/dashboard" className="hidden text-[14px] font-medium text-[#9c9c9d] hover:text-white sm:block">Log in</a>
            <button type="button" onClick={() => go("/dashboard")} className="flex items-center gap-1.5 rounded-full bg-[#f2f2f2] px-3.5 py-1.5 text-[13px] font-semibold text-[#2f3031] hover:bg-white">
              Open workspace
              <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden><path d="M6 3l5 5-5 5-1-1 4-4-4-4z" /></svg>
            </button>
          </div>
        </header>

        {/* Hero copy */}
        <div className="mt-[clamp(40px,9vh,96px)] flex max-w-[860px] flex-col items-center text-center">
          <a href="#/dashboard" className="glass mb-6 inline-flex items-center gap-2 rounded-full px-3 py-1 text-[12.5px] text-[#c9c9ca]">
            <span className="warm-fill size-1.5 rounded-full" />
            v2.0 · now with an AI claims copilot
            <span className="text-[#9c9c9d]">→</span>
          </a>
          <h1 className="hero-title">
            Every claim clean.
            <br />
            Every dirham <span className="warm-text">collected.</span>
          </h1>
          <p className="mt-5 max-w-[640px] text-[18px] font-normal leading-relaxed tracking-[0.2px] text-white/65">
            AI coding with evidence, a ten-rule scrubber, and denial resubmissions drafted in seconds, for UAE clinics on DHA eClaimLink and DOH Shafafiya.
          </p>
          <div className="mt-9 flex w-full flex-col items-stretch justify-center gap-4 sm:w-auto sm:flex-row sm:items-center">
            <button type="button" onClick={() => go("/coding/enc_0001")} className="keycap flex items-center justify-center gap-2 px-5 py-3 text-[14px] font-medium">
              <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden><path d="M5.5 1.5v2H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1h-2.5v-2zm1.5 0h2v2H7zM7 7h2v2h2v2H9v2H7v-2H5V9h2z" /></svg>
              Code a clinical note
            </button>
            <button type="button" onClick={() => go("/denials")} className="keycap flex items-center justify-center gap-2 px-5 py-3 text-[14px] font-medium">
              <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1m.8 10.5H7.2V10h1.6zm0-3H7.2v-4h1.6z" /></svg>
              Work the denial worklist
            </button>
          </div>
          <p className="mt-5 font-mono text-[12px] text-[#9c9c9d]">npm run dev · synthetic data · mock DHA gateway · human approval on every submission</p>
        </div>

        {/* Command-bar launcher mockup */}
        <div className="mt-12 w-full max-w-[680px] overflow-hidden rounded-[14px] border border-white/10 bg-[rgba(14,15,18,0.72)] shadow-[0_40px_120px_-30px_rgba(255,60,50,0.45),0_20px_60px_-20px_rgba(0,0,0,0.9)] backdrop-blur-xl">
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
            <span>esc dismiss</span>
            <span className="ml-auto flex items-center gap-1.5 font-sans text-[12px] font-semibold text-[#c9c9ca]"><Logo size={14} /> Sanad</span>
          </div>
        </div>

        <a href="#/dashboard" className="ghost-pill mt-8 inline-flex items-center gap-1.5 px-4 py-1.5 text-[13px]">
          See the revenue dashboard <span aria-hidden>→</span>
        </a>
      </div>

      {/* Floating badge */}
      <div className="glass fixed bottom-5 right-5 z-20 hidden items-center gap-3 rounded-xl px-3.5 py-2.5 shadow-2xl lg:flex">
        <span className="grid size-8 place-items-center rounded-lg bg-white/[0.06]"><Logo size={16} /></span>
        <div className="leading-tight">
          <div className="text-[10.5px] uppercase tracking-wider text-[#9c9c9d]">Built at</div>
          <div className="text-[13px] font-semibold">Hub71 Hackathon · MVP</div>
        </div>
      </div>
    </div>
  );
}
