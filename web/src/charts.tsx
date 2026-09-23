// Small, dependency-free charts following the dataviz method: fixed categorical order,
// one-hue ordinal ramps, thin marks with 2px surface gaps, recessive axes, hover tooltips,
// legends for >= 2 series and text in ink tokens (never series colors).
import { type ReactNode, useState } from "react";

export const PAYER_COLORS = ["var(--s1)", "var(--s2)", "var(--s3)"]; // categorical slots 1-3
// Warm ordinal ramp (amber → crimson): older and riskier buckets read hotter.
export const AGE_RAMP = ["#ffd9a0", "#ffb347", "#ff6b4a", "#ff2f3a"];

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px]" style={{ background: i.color }} aria-hidden />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

function Tip({ tip }: { tip: { x: number; y: number; content: ReactNode } | null }) {
  if (!tip) return null;
  return (
    <div className="glass pointer-events-none fixed z-50 rounded-lg px-3 py-2 text-[12px] shadow-lg" style={{ left: tip.x + 14, top: tip.y + 14 }}>
      {tip.content}
    </div>
  );
}

/** Horizontal stacked bars: one row per category, segments in a fixed series order. */
export function StackedBars({ rows, series, format }: { rows: { label: string; values: number[] }[]; series: { label: string; color: string }[]; format: (n: number) => string }) {
  const [tip, setTip] = useState<{ x: number; y: number; content: ReactNode } | null>(null);
  const max = Math.max(1, ...rows.map((r) => r.values.reduce((s, v) => s + v, 0)));
  return (
    <div>
      <div className="mb-3">
        <Legend items={series} />
      </div>
      <div className="space-y-3">
        {rows.map((r) => {
          const total = r.values.reduce((s, v) => s + v, 0);
          return (
            <div key={r.label}>
              <div className="mb-1 flex justify-between text-[12.5px]">
                <span className="text-ink-2">{r.label}</span>
                <span className="num font-medium text-ink">{format(total)}</span>
              </div>
              <div className="flex h-3.5 gap-[2px] overflow-hidden rounded-[4px] bg-white/[0.05]" style={{ width: `${Math.max(2, (total / max) * 100)}%` }}>
                {r.values.map((v, i) =>
                  v > 0 ? (
                    <div
                      key={series[i].label}
                      className="h-full first:rounded-l-[4px] last:rounded-r-[4px]"
                      style={{ flexGrow: v, background: series[i].color }}
                      onMouseMove={(e) => setTip({ x: e.clientX, y: e.clientY, content: <><b>{r.label}</b> · {series[i].label}<br /><span className="num">{format(v)}</span> ({((v / total) * 100).toFixed(0)}%)</> })}
                      onMouseLeave={() => setTip(null)}
                    />
                  ) : null,
                )}
              </div>
            </div>
          );
        })}
      </div>
      <Tip tip={tip} />
    </div>
  );
}

/** Single-series horizontal bars (magnitude) with values labelled in ink. */
export function BarList({ rows, format, color = "var(--s1)" }: { rows: { label: string; value: number; sub?: string }[]; format: (n: number) => string; color?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="mb-1 flex justify-between gap-2 text-[12.5px]">
            <span className="truncate text-ink-2">{r.label}{r.sub && <span className="text-muted"> · {r.sub}</span>}</span>
            <span className="num font-medium">{format(r.value)}</span>
          </div>
          <div className="h-2 rounded-[4px] bg-surface-2">
            <div className="h-2 rounded-[4px]" style={{ width: `${(r.value / max) * 100}%`, background: color }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Single-series line with crosshair tooltip. */
export function LineChart({ points, format, height = 160 }: { points: { label: string; value: number }[]; format: (n: number) => string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const w = 600;
  const h = height;
  const pad = { l: 36, r: 8, t: 10, b: 22 };
  const max = Math.max(...points.map((p) => p.value), 0.0001) * 1.15;
  const x = (i: number) => pad.l + (i * (w - pad.l - pad.r)) / Math.max(1, points.length - 1);
  const y = (v: number) => pad.t + (1 - v / max) * (h - pad.t - pad.b);
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.value)}`).join(" ");
  const ticks = [0, max / 2, max];
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label="Line chart" onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth="1" />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" fontSize="10.5" fill="var(--muted)" className="num">{format(t)}</text>
          </g>
        ))}
        {points.map((p, i) => (i % 2 === 0 || i === points.length - 1 ? <text key={p.label} x={x(i)} y={h - 5} textAnchor="middle" fontSize="10.5" fill="var(--muted)">{p.label}</text> : null))}
        <path d={path} fill="none" stroke="var(--s1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {hover !== null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={h - pad.b} stroke="var(--axis)" strokeWidth="1" />
            <circle cx={x(hover)} cy={y(points[hover].value)} r="4.5" fill="var(--s1)" stroke="var(--surface)" strokeWidth="2" />
          </>
        )}
        {points.map((p, i) => (
          <rect key={`hit-${p.label}`} x={x(i) - (w - pad.l) / points.length / 2} y={0} width={(w - pad.l) / points.length} height={h} fill="transparent" onMouseEnter={() => setHover(i)} />
        ))}
      </svg>
      {hover !== null && (
        <div className="pointer-events-none glass absolute top-0 rounded-lg px-2.5 py-1.5 text-[12px] shadow" style={{ left: `min(calc(${(x(hover) / w) * 100}% + 8px), calc(100% - 120px))` }}>
          <div className="text-muted">{points[hover].label}</div>
          <div className="num font-medium">{format(points[hover].value)}</div>
        </div>
      )}
    </div>
  );
}
