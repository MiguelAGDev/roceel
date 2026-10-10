// Piezas de presentación que comparten todas las pantallas: etiqueta, insignias y estados de carga.
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ApiError, partLabel, type PartSummary } from "../api";
import { IconAlert, IconRefresh } from "./icons";

/** Un código físico (U-101, SKU, P-24, R061026012) se ve como la etiqueta que se escanea. */
export function Tag({ children, to, large, title }: { children: ReactNode; to?: string; large?: boolean; title?: string }) {
  const cls = large ? "tag tag-lg" : "tag";
  if (to) return <Link to={to} className={cls} title={title}>{children}</Link>;
  return <span className={cls} title={title}>{children}</span>;
}

export function PartTag({ part, link = true }: { part: { part_id: number; sku?: string | null }; link?: boolean }) {
  const label = partLabel(part);
  return <Tag to={link ? `/kardex/${part.part_id}` : undefined} title={part.sku ? "SKU" : "Pieza sin SKU"}>{label}</Tag>;
}

export function Badge({ tone, children }: { tone: "danger" | "warn" | "ok" | "info" | "neutral"; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

/** Alertas por reglas (no IA): sin stock, bajo mínimo, faltante abierto. */
export function StockBadges({ part }: { part: Pick<PartSummary, "available" | "min_qty" | "open_shortages" | "family"> }) {
  return (
    <span className="row">
      {part.available <= 0 && <Badge tone="danger"><IconAlert />Sin stock</Badge>}
      {part.available > 0 && part.min_qty != null && part.available < part.min_qty && <Badge tone="warn">Bajo mínimo</Badge>}
      {part.open_shortages > 0 && <Badge tone="danger">{part.open_shortages} faltante{part.open_shortages === 1 ? "" : "s"}</Badge>}
      {part.family === "SERVICIO" && <Badge tone="neutral">Servicio</Badge>}
    </span>
  );
}

export function Loading({ rows = 4, label = "Cargando…" }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-live="polite" className="panel-pad">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton" style={{ width: `${90 - i * 12}%` }} />)}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorBox({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  return (
    <div className="error-box" role="alert">
      <IconAlert />
      <div>{error.detail}</div>
      {onRetry && (
        <button className="btn" style={{ marginTop: 10 }} onClick={onRetry}>
          <IconRefresh />Reintentar
        </button>
      )}
    </div>
  );
}

/** Pinta carga, error o vacío según el estado de un useApi; si hay datos, llama a `children`. */
export function Async<T>({ state, empty, children, isEmpty }: {
  state: { data: T | undefined; error: ApiError | undefined; loading: boolean; reload: () => void };
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  children: (data: T) => ReactNode;
}) {
  if (state.data === undefined) {
    if (state.error) return <ErrorBox error={state.error} onRetry={state.reload} />;
    return <Loading />;
  }
  const blank = isEmpty ? isEmpty(state.data) : Array.isArray(state.data) && state.data.length === 0;
  return (
    <>
      {state.error && (
        <div className="banner danger" role="alert" style={{ margin: 12 }}>
          <IconAlert />No se pudo actualizar: {state.error.detail}
        </div>
      )}
      {blank && empty ? <Empty>{empty}</Empty> : children(state.data)}
    </>
  );
}
