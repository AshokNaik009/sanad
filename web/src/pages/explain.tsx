import { useState } from "react";
import { Logo } from "../App";
import { aed } from "../api";
import { readImageFile } from "../scan";

interface Explanation {
  lines: { desc: string; code?: string; amount: number; plain?: string }[];
  insurerPaid: number;
  youPay: number;
  flags: string[];
  questionsToAsk: string[];
  denials: { code: string; plain: string }[];
  readByAssistant: boolean;
}

/** Public bill explainer: no login; a patient uploads a bill photo and gets it in plain language. */
export function ExplainPage() {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState<Explanation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (file: File) => {
    setError(null);
    setBusy(true);
    try {
      const scan = await readImageFile(file, setProgress, 3);
      setProgress("Reading your bill…");
      const response = await fetch("/api/public/explain-bill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pages: scan.pages }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "We couldn't read that bill. Please try another photo.");
      setResult(data as Explanation);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setProgress("");
    }
  };
  const reset = () => {
    setResult(null);
    setError(null);
  };

  return (
    <div className="min-h-screen bg-page px-4 py-8">
      <div className="mx-auto max-w-md">
        <div className="mb-6 flex items-center gap-2">
          <Logo size={28} />
          <span className="text-[15px] font-semibold">Your bill, explained</span>
        </div>

        {!result && !error && (
          <div className="glass rounded-2xl p-5">
            <p className="text-[14px]">Take a photo of your medical bill or insurance statement (or upload a PDF). We'll explain each line in plain language and suggest what to ask your insurer.</p>
            <label className="mt-4 flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-white/15 px-4 py-6 text-center hover:border-white/30">
              <span className="text-[14px] font-semibold">{busy ? progress || "Working…" : "Choose a photo or PDF"}</span>
              <span className="text-[12px] text-muted">Up to 3 pages · PNG, JPEG, WebP or PDF</span>
              <input type="file" accept=".pdf,application/pdf,image/png,image/jpeg,image/webp" capture="environment" className="sr-only" disabled={busy} onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
            </label>
            <p className="mt-3 text-[12px] text-muted">Your photo is used only to explain this bill.</p>
          </div>
        )}

        {error && (
          <div className="glass rounded-2xl p-5 text-[14px]">
            <p className="text-[#ff8a8f]">{error}</p>
            <button type="button" onClick={reset} className="mt-3 rounded-lg bg-white/10 px-3 py-2 text-[13px] font-semibold text-white hover:bg-white/20">
              Try again
            </button>
          </div>
        )}

        {result && (
          <div className="space-y-4">
            <div className="glass rounded-2xl p-5">
              <h2 className="text-[14px] font-semibold">What you were billed for</h2>
              {!result.lines.length && <p className="mt-3 text-[13px] text-muted">We couldn't pick out individual lines on this bill.</p>}
              <ul className="mt-3 space-y-3 text-[14px]">
                {result.lines.map((line, i) => (
                  <li key={i} className="flex justify-between gap-3">
                    <span>
                      {line.plain ?? line.desc}
                      {line.plain && <span className="block text-[12px] text-muted">{line.desc}{line.code ? ` · ${line.code}` : ""}</span>}
                    </span>
                    <span className="num shrink-0">{line.amount > 0 ? aed(line.amount, 2) : ""}</span>
                  </li>
                ))}
              </ul>
              {(result.insurerPaid > 0 || result.youPay > 0) && (
                <div className="mt-4 space-y-1 border-t border-line pt-3 text-[14px]">
                  <div className="flex justify-between text-ink-2"><span>Insurer paid</span><span className="num">{aed(result.insurerPaid, 2)}</span></div>
                  <div className="flex justify-between text-[17px] font-semibold"><span>Your share</span><span className="num">{aed(result.youPay, 2)}</span></div>
                </div>
              )}
            </div>

            {result.denials.length > 0 && (
              <div className="glass rounded-2xl p-5">
                <h2 className="text-[14px] font-semibold">Why something wasn't paid</h2>
                <ul className="mt-3 space-y-2 text-[13px]">
                  {result.denials.map((d) => <li key={d.code}><span className="font-mono text-[12px] text-muted">{d.code}</span> — {d.plain}</li>)}
                </ul>
              </div>
            )}

            {result.flags.length > 0 && (
              <div className="glass rounded-2xl p-5">
                <h2 className="text-[14px] font-semibold">Worth knowing</h2>
                <ul className="mt-3 list-disc space-y-1 pl-5 text-[13px] text-ink-2">
                  {result.flags.map((flag, i) => <li key={i}>{flag}</li>)}
                </ul>
              </div>
            )}

            {result.questionsToAsk.length > 0 && (
              <div className="glass rounded-2xl p-5">
                <h2 className="text-[14px] font-semibold">Questions to ask your insurer</h2>
                <ul className="mt-3 list-disc space-y-1 pl-5 text-[13px] text-ink-2">
                  {result.questionsToAsk.map((q, i) => <li key={i}>{q}</li>)}
                </ul>
              </div>
            )}

            <button type="button" onClick={reset} className="w-full rounded-xl bg-white/10 px-4 py-2.5 text-[13px] font-semibold text-white hover:bg-white/20">
              Explain another bill
            </button>
          </div>
        )}

        <p className="mt-6 text-center text-[11.5px] text-muted">
          This explains bills in plain language. It is not medical advice. For questions about your cover, contact your insurer.
        </p>
      </div>
    </div>
  );
}
