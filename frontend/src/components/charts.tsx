// Gráficas SVG propias (sin librería): KPI, líneas y barras horizontales (simples o apiladas).
// Cada una trae su tabla oculta para lector de pantalla y su estado vacío.
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { fmtQty } from "../api";

export function Kpi({ label, value, sub, tone = "neutral", to }: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "danger" | "warn" | "info" | "ok" | "neutral";
  to?: string;
}) {
  const body = (
    <>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </>
  );
  return to ? <Link to={to} className={`kpi ${tone}`}>{body}</Link> : <div className={`kpi ${tone}`}>{body}</div>;
}

export interface Series {
  name: string;
  color: string;
  values: (number | null)[];
  dashed?: boolean;
}

function niceMax(n: number): number {
  if (n <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(n));
  const f = n / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

function Legend({ series }: { series: { name: string; color: string; dashed?: boolean }[] }) {
  return (
    <div className="legend" aria-hidden="true">
      {series.map((s) => (
        <span key={s.name}>
          <i style={{ background: s.dashed ? `repeating-linear-gradient(90deg, ${s.color} 0 3px, transparent 3px 5px)` : s.color }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}

function DataTable({ caption, head, rows }: { caption: string; head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead><tr>{head.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
    </table>
  );
}

export function LineChart({ title, labels, series, height = 220 }: {
  title: string;
  labels: string[];
  series: Series[];
  height?: number;
}) {
  const hasData = series.some((s) => s.values.some((v) => v != null && v > 0));
  if (!labels.length || !hasData) return <div className="empty">Sin datos todavía</div>;

  const W = 640;
  const H = height;
  const pad = { l: 40, r: 28, t: 12, b: 26 };
  const max = niceMax(Math.max(...series.flatMap((s) => s.values.map((v) => v ?? 0))));
  const x = (i: number) => pad.l + (labels.length === 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (labels.length - 1));
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const ticks = [0, max / 2, max];
  const every = Math.ceil(labels.length / 8);

  return (
    <figure style={{ margin: 0 }}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
        <title>{title}</title>
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end">{fmtQty(t)}</text>
          </g>
        ))}
        {labels.map((l, i) => i % every === 0 && (
          <text key={l + i} x={x(i)} y={H - 8} textAnchor="middle">{l}</text>
        ))}
        {series.map((s) => {
          // Una línea por tramo continuo (los null cortan la línea).
          const segments: string[] = [];
          let cur = "";
          s.values.forEach((v, i) => {
            if (v == null) {
              if (cur) segments.push(cur);
              cur = "";
            } else {
              cur += `${cur ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
            }
          });
          if (cur) segments.push(cur);
          return (
            <g key={s.name}>
              {segments.map((d, i) => (
                <path key={i} d={d} fill="none" stroke={s.color} strokeWidth={2.5} strokeDasharray={s.dashed ? "6 4" : undefined} />
              ))}
              {s.values.map((v, i) => v != null && <circle key={i} cx={x(i)} cy={y(v)} r={2.5} fill={s.color} />)}
            </g>
          );
        })}
      </svg>
      <Legend series={series} />
      <DataTable caption={title} head={["Semana", ...series.map((s) => s.name)]}
        rows={labels.map((l, i) => [l, ...series.map((s) => (s.values[i] == null ? "—" : String(s.values[i])))])} />
    </figure>
  );
}

export interface BarRow {
  label: ReactNode;
  key: string | number;
  values: number[];
}

/** Barras horizontales; con varias series se apilan. */
export function BarChart({ title, rows, series }: { title: string; rows: BarRow[]; series: { name: string; color: string }[] }) {
  if (!rows.length) return <div className="empty">Sin datos todavía</div>;
  const max = Math.max(1, ...rows.map((r) => r.values.reduce((a, b) => a + b, 0)));
  return (
    <figure style={{ margin: 0 }} aria-label={title}>
      <div className="stack" style={{ gap: 8 }} aria-hidden="true">
        {rows.map((r) => {
          const total = r.values.reduce((a, b) => a + b, 0);
          return (
            <div key={r.key} style={{ display: "grid", gridTemplateColumns: "minmax(110px, 38%) 1fr 56px", gap: 10, alignItems: "center" }}>
              <div style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}</div>
              <div style={{ display: "flex", height: 14, background: "var(--concrete-1)", borderRadius: 3, overflow: "hidden" }}>
                {r.values.map((v, i) => v > 0 && (
                  <span key={i} style={{ width: `${(v / max) * 100}%`, background: series[i].color }} />
                ))}
              </div>
              <div className="num">{fmtQty(total)}</div>
            </div>
          );
        })}
      </div>
      {series.length > 1 && <Legend series={series} />}
      <DataTable caption={title} head={["Pieza", ...series.map((s) => s.name)]}
        rows={rows.map((r) => [String(r.key), ...r.values])} />
    </figure>
  );
}
