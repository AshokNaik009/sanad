import { Aurora, Logo, go } from "../App";
import { setCurrentUser, useApi } from "../api";
import { ErrorBox, Loading, cx } from "../ui";

const ROLE_BLURB: Record<string, string> = {
  biller: "Scrub, approve and submit claims; work denials",
  coder: "Review AI code suggestions against the note",
  doctor: "Answer documentation queries",
  finance: "Reconciliation, underpayments and cash forecast",
  frontdesk: "Eligibility, prior approval and estimates",
  admin: "Everything, plus audit log and demo reset",
};

export function initials(name: string) {
  return name
    .replace(/\(.*\)/, "")
    .replace(/^Dr\.?\s*/, "")
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function Avatar({ name, size = "size-9" }: { name: string; size?: string }) {
  return <span className={cx("warm-fill grid shrink-0 place-items-center rounded-full text-[12px] font-bold", size)}>{initials(name)}</span>;
}

/** Demo sign-in: pick one of the seeded accounts. Replace with SSO before a pilot. */
export function LoginPage({ next }: { next: string }) {
  const accounts = useApi<{ users: { id: string; name: string; role: string }[]; organization: string }>("/accounts");
  const signIn = (id: string) => {
    setCurrentUser(id);
    // Signing in on the page that was asked for doesn't change the hash, so re-render by reloading.
    if (window.location.hash.slice(1) === next) window.location.reload();
    else go(next);
  };
  return (
    <div className="relative min-h-screen overflow-x-clip">
      <Aurora />
      <div className="relative z-10 flex min-h-screen flex-col items-center justify-center px-4 py-12">
        <a href="#/" className="mb-8 flex items-center gap-2.5" aria-label="Sanad home">
          <Logo size={30} />
          <span className="text-[20px] font-semibold tracking-[-0.01em]">Sanad</span>
        </a>
        <div className="glass w-full max-w-[460px] rounded-3xl p-6 shadow-[0_40px_120px_-30px_rgba(255,60,50,0.4),0_20px_60px_-20px_rgba(0,0,0,0.9)] sm:p-8">
          <h1 className="text-[24px] font-semibold tracking-[-0.02em] text-white">Sign in</h1>
          <p className="mt-1.5 text-[14px] text-white/55">
            Choose a demo account{accounts.data ? ` at ${accounts.data.organization}` : ""}. Each role sees only what it needs.
          </p>
          <div className="mt-6">
            <ErrorBox error={accounts.error} />
            {!accounts.data && !accounts.error ? (
              <Loading />
            ) : (
              <ul className="space-y-2">
                {accounts.data?.users.map((u) => (
                  <li key={u.id}>
                    <button
                      type="button"
                      onClick={() => signIn(u.id)}
                      className="lift group flex w-full items-center gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.03] px-3.5 py-3 text-left"
                    >
                      <Avatar name={u.name} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[14.5px] font-medium text-white">{u.name}</span>
                        <span className="block truncate text-[12.5px] text-white/50">{ROLE_BLURB[u.role] ?? u.role}</span>
                      </span>
                      <svg viewBox="0 0 16 16" className="size-4 shrink-0 text-muted transition group-hover:translate-x-0.5 group-hover:text-white" fill="currentColor" aria-hidden>
                        <path d="M6 3l5 5-5 5-1-1 4-4-4-4z" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <p className="mt-6 max-w-[460px] text-center text-[12.5px] text-white/40">Demo workspace with synthetic patients. No real patient data.</p>
        <a href="#/" className="mt-3 text-[13px] text-muted hover:text-white">← Back to home</a>
      </div>
    </div>
  );
}
