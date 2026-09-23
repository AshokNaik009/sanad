import { type ReactNode, useEffect, useState } from "react";
import { api, currentUser, setCurrentUser, useApi } from "./api";
import { AuditPage } from "./pages/audit";
import { ClaimDetail, ClaimsPage } from "./pages/claims";
import { CodingQueue, EncounterPage } from "./pages/coding";
import { CopilotPanel } from "./pages/copilot";
import { Dashboard } from "./pages/dashboard";
import { DenialDetail, DenialsPage } from "./pages/denials";
import { FrontDesk } from "./pages/frontdesk";
import { Inbox } from "./pages/inbox";
import { Landing } from "./pages/landing";
import { Reconciliation } from "./pages/reconciliation";
import { SharePage } from "./pages/share";
import { cx, useToast } from "./ui";

export function useRoute() {
  const [hash, setHash] = useState(() => window.location.hash.slice(1) || "/");
  useEffect(() => {
    const on = () => {
      setHash(window.location.hash.slice(1) || "/");
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash.split("?")[0].split("/").filter(Boolean);
}
export const go = (path: string) => {
  window.location.hash = path;
};

export function Aurora({ quiet }: { quiet?: boolean }) {
  return (
    <div className={cx("aurora", quiet && "quiet")} aria-hidden>
      <div className="blade b1" />
      <div className="blade b2" />
      <div className="blade b3" />
      <div className="blade b4" />
      <div className="grain" />
      <div className="vignette" />
    </div>
  );
}

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffb347" />
          <stop offset=".5" stopColor="#ff6b4a" />
          <stop offset="1" stopColor="#ff2f3a" />
        </linearGradient>
      </defs>
      <path d="M12 1.5 22.5 12 12 22.5 1.5 12z" fill="url(#lg)" />
      <path d="M12 7 17 12 12 17 7 12z" fill="#07080a" opacity=".55" />
    </svg>
  );
}

const NAV: { key: string; label: string; icon: ReactNode; roles?: string[] }[] = [
  { key: "dashboard", label: "Overview", icon: <path d="M3 13h8V3H3zm0 8h8v-6H3zm10 0h8V11h-8zm0-18v6h8V3z" /> },
  { key: "coding", label: "Coding", icon: <path d="M9.4 16.6 4.8 12l4.6-4.6L8 6l-6 6 6 6zm5.2 0 4.6-4.6-4.6-4.6L16 6l6 6-6 6z" /> },
  { key: "claims", label: "Claims", icon: <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm-1 7V3.5L18.5 9zM8 13h8v2H8zm0 4h8v2H8z" /> },
  { key: "denials", label: "Denials", icon: <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m1 15h-2v-2h2zm0-4h-2V7h2z" /> },
  { key: "reconciliation", label: "Money", icon: <path d="M11.8 10.9c-2.3-.6-3-1.2-3-2.1 0-1.1 1-1.9 2.7-1.9 1.8 0 2.4.8 2.5 2.1h2.2c-.1-1.7-1.1-3.3-3.2-3.8V3h-3v2.2c-1.9.4-3.5 1.7-3.5 3.6 0 2.3 1.9 3.4 4.7 4.1 2.5.6 3 1.5 3 2.4 0 .7-.5 1.8-2.7 1.8-2.1 0-2.9-.9-3-2.1H5.2c.1 2.2 1.8 3.5 3.8 3.9V21h3v-2.1c1.9-.4 3.5-1.5 3.5-3.6 0-2.8-2.4-3.8-4.7-4.4" /> },
  { key: "frontdesk", label: "Front desk", icon: <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8m0 2c-2.7 0-8 1.3-8 4v2h16v-2c0-2.7-5.3-4-8-4" /> },
  { key: "inbox", label: "Inbox", icon: <path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2m0 12h-4a3 3 0 0 1-6 0H5V5h14z" /> },
  { key: "audit", label: "Audit", icon: <path d="M12 1 3 5v6c0 5.5 3.8 10.7 9 12 5.2-1.3 9-6.5 9-12V5zm-2 16-4-4 1.4-1.4 2.6 2.6 6.6-6.6L18 9z" />, roles: ["admin", "finance"] },
];

export function App() {
  const route = useRoute();
  if (route[0] === "share" && route[1]) return <SharePage token={route[1]} />;
  if (!route[0]) return <Landing />;
  return <Shell route={route} />;
}

function Shell({ route }: { route: string[] }) {
  const me = useApi<any>("/me");
  const notes = useApi<any[]>("/notifications");
  const [copilot, setCopilot] = useState(false);
  const [bell, setBell] = useState(false);
  const toast = useToast();
  const role = me.data?.user.role as string | undefined;
  useEffect(() => {
    const t = setInterval(() => void notes.reload(), 8000);
    return () => clearInterval(t);
  }, [notes.reload]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCopilot((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const switchUser = (id: string) => {
    setCurrentUser(id);
    window.location.reload();
  };
  const resetDemo = async () => {
    toast("Resetting demo data…");
    await api("/demo/reset", { method: "POST" });
    toast("Demo data restored", "good");
    setTimeout(() => window.location.reload(), 400);
  };

  const [section, id] = route;
  const page = (() => {
    switch (section) {
      case "dashboard":
        return <Dashboard onAsk={() => setCopilot(true)} />;
      case "coding":
        return id ? <EncounterPage id={id} /> : <CodingQueue />;
      case "claims":
        return id ? <ClaimDetail id={id} /> : <ClaimsPage />;
      case "denials":
        return id ? <DenialDetail id={id} /> : <DenialsPage />;
      case "reconciliation":
        return <Reconciliation onAsk={() => setCopilot(true)} />;
      case "frontdesk":
        return <FrontDesk />;
      case "inbox":
        return <Inbox />;
      case "audit":
        return <AuditPage />;
      default:
        return <p className="text-muted">Not found</p>;
    }
  })();
  const nav = NAV.filter((n) => !n.roles || (role && n.roles.includes(role)));
  const unread = notes.data?.filter((n) => !n.read).length ?? 0;

  const current = NAV.find((n) => n.key === section);
  const groups: [string, string[]][] = [
    ["Revenue cycle", ["dashboard", "coding", "claims", "denials"]],
    ["Finance", ["reconciliation"]],
    ["Operations", ["frontdesk", "inbox", "audit"]],
  ];

  return (
    <div className="relative min-h-screen">
      <Aurora quiet />

      {/* Sidebar (desktop) */}
      <aside className="glass fixed bottom-3 left-3 top-3 z-30 hidden w-[240px] flex-col rounded-2xl p-3 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.9)] lg:flex">
        <a href="#/" className="mb-5 flex items-center gap-2.5 px-2 pt-1" aria-label="Sanad home">
          <Logo size={26} />
          <span>
            <span className="block text-[16px] font-semibold leading-tight tracking-[-0.01em]">Sanad</span>
            <span className="block text-[11px] text-muted">Claims &amp; revenue cycle</span>
          </span>
        </a>
        <button type="button" onClick={() => setCopilot(true)} className="mb-4 flex items-center gap-2 rounded-xl border border-line bg-white/[0.03] px-3 py-2 text-left text-[13px] text-muted hover:border-white/20 hover:text-white" aria-label="Open command bar">
          <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden><path d="M7 2a5 5 0 1 0 3.1 8.9l3 3 1-1-3-3A5 5 0 0 0 7 2m0 1.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7" /></svg>
          Ask copilot
          <span className="kbd ml-auto">⌘K</span>
        </button>
        <nav className="flex-1 space-y-4 overflow-y-auto" aria-label="Main">
          {groups.map(([label, keys]) => {
            const items = nav.filter((n) => keys.includes(n.key));
            if (!items.length) return null;
            return (
              <div key={label}>
                <div className="mb-1 px-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted/80">{label}</div>
                <ul className="space-y-0.5">
                  {items.map((n) => {
                    const active = section === n.key;
                    return (
                      <li key={n.key}>
                        <a href={`#/${n.key}`} aria-current={active ? "page" : undefined} className={cx("relative flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-[13.5px] font-medium transition", active ? "active-row text-white" : "text-muted hover:bg-white/[0.04] hover:text-white")}>
                          <svg viewBox="0 0 24 24" className={cx("size-[17px]", active && "text-[#ffb347]")} fill="currentColor" aria-hidden>{n.icon}</svg>
                          {n.label}
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </nav>
        <div className="mt-3 space-y-2 border-t border-line pt-3">
          <div className="rounded-xl bg-white/[0.03] px-2.5 py-2">
            <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-ink-2">
              <span className={cx("size-1.5 rounded-full", me.data?.ai === "model" ? "warm-fill" : "bg-muted")} />
              AI {me.data?.ai === "model" ? "online" : "offline engine"}
            </div>
            <div className="mt-0.5 truncate font-mono text-[10.5px] text-muted" title={me.data?.aiLabel}>{me.data?.aiLabel}</div>
          </div>
          {role === "admin" && (
            <button type="button" onClick={resetDemo} className="keycap w-full px-3 py-1.5 text-[12.5px] font-semibold">Reset demo data</button>
          )}
          <p className="px-1 text-[10.5px] leading-snug text-muted">{me.data?.organization.name} · synthetic data · {me.data?.organization.regulator} test gateway</p>
        </div>
      </aside>

      <div className="lg:pl-[256px]">
        {/* Top bar */}
        <header className="sticky top-0 z-20 px-3 pt-[max(12px,env(safe-area-inset-top))] md:px-6">
          <div className="glass mx-auto flex max-w-[1280px] items-center gap-2 rounded-full py-1.5 pl-3 pr-1.5 shadow-[0_10px_40px_-12px_rgba(0,0,0,0.8)]">
            <a href="#/" className="flex items-center gap-2 lg:hidden" aria-label="Sanad home">
              <Logo />
              <span className="text-[15px] font-semibold">Sanad</span>
            </a>
            <div className="hidden items-center gap-2 text-[13px] lg:flex">
              <span className="text-muted">Sanad</span>
              <span className="text-muted/60">/</span>
              <a href={`#/${section}`} className="font-medium text-white">{current?.label ?? section}</a>
              {id && (
                <>
                  <span className="text-muted/60">/</span>
                  <span className="max-w-[260px] truncate font-mono text-[12px] text-ink-2">{id}</span>
                </>
              )}
            </div>
            <div className="ml-auto flex items-center gap-1.5">
              <button type="button" onClick={() => setCopilot(true)} className="grid size-9 place-items-center rounded-full text-muted hover:bg-white/[0.06] hover:text-white lg:hidden" aria-label="Ask copilot">
                <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden><path d="M8 1l1.6 4.4L14 7 9.6 8.6 8 13 6.4 8.6 2 7l4.4-1.6z" /></svg>
              </button>
              <div className="relative">
                <button type="button" aria-label={`Notifications (${unread})`} onClick={() => setBell((b) => !b)} className="relative grid size-9 place-items-center rounded-full text-muted hover:bg-white/[0.06] hover:text-white">
                  <svg viewBox="0 0 24 24" className="size-[18px]" fill="currentColor" aria-hidden><path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2m6-6V11c0-3.1-1.6-5.6-4.5-6.3V4a1.5 1.5 0 0 0-3 0v.7C7.6 5.4 6 7.9 6 11v5l-2 2v1h16v-1z" /></svg>
                  {unread > 0 && <span className="warm-fill absolute right-0.5 top-0.5 grid min-w-4 place-items-center rounded-full px-1 text-[10px] font-bold">{unread}</span>}
                </button>
                {bell && (
                  <div className="glass absolute right-0 top-11 z-40 w-[min(92vw,360px)] rounded-2xl p-2 shadow-2xl">
                    {(notes.data ?? []).slice(0, 10).map((n) => (
                      <div key={n.id} className="rounded-xl px-2.5 py-2 text-[12.5px] hover:bg-white/[0.04]">
                        <div className="text-ink">{n.message}</div>
                        <div className="font-mono text-[11px] text-muted">{new Date(n.createdAt).toLocaleString("en-GB")}</div>
                      </div>
                    ))}
                    {!notes.data?.length && <p className="p-3 text-[12.5px] text-muted">No notifications</p>}
                  </div>
                )}
              </div>
              <select aria-label="Signed in as" value={currentUser()} onChange={(e) => switchUser(e.target.value)} className="max-w-[160px] rounded-full border border-line bg-white/[0.03] px-3 py-1.5 text-[12.5px] text-ink">
                {(me.data?.users ?? []).map((u: any) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
            </div>
          </div>
        </header>

        <main className="relative z-10 mx-auto max-w-[1280px] px-4 pb-28 pt-7 md:px-8 lg:pb-12">{page}</main>
      </div>

      <nav className="glass fixed inset-x-3 bottom-3 z-30 flex justify-around rounded-2xl pb-[env(safe-area-inset-bottom)] lg:hidden">
        {nav.filter((n) => ["dashboard", "coding", "claims", "denials", "reconciliation"].includes(n.key)).map((n) => (
          <a key={n.key} href={`#/${n.key}`} className={cx("flex flex-1 flex-col items-center gap-0.5 py-2 text-[10.5px] font-medium", section === n.key ? "text-[#ff8f6b]" : "text-muted")}>
            <svg viewBox="0 0 24 24" className="size-5" fill="currentColor" aria-hidden>{n.icon}</svg>
            {n.label}
          </a>
        ))}
      </nav>
      <CopilotPanel open={copilot} onClose={() => setCopilot(false)} />
    </div>
  );
}
