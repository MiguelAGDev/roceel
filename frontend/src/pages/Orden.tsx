// Órdenes: lista de órdenes vivas y, por orden, el avance por línea (requerido · reservado · entregado · falta).
// Se refresca sola cada 5 s: el jurado aprueba en el simulador y la reserva y el faltante aparecen aquí.
import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  api, DEPARTMENT_LABEL, fmtDate, fmtQty, ORDER_CODE, stageLabel, useApi,
  type MaterialLine, type WorkOrderSummary,
} from "../api";
import { openAdvisor } from "../components/Advisor";
import { IconAdvisor, IconAlert, IconCheck, IconOut, IconSearch } from "../components/icons";
import { Async, Badge, ErrorBox, Loading, Tag } from "../components/ui";

export default function Orden() {
  const { code } = useParams();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Órdenes de trabajo</h1>
          <p className="muted">Materiales por línea de la inspección vigente</p>
        </div>
      </div>
      <div className="split">
        <OrderList selected={code} />
        <section className="panel" aria-label="Detalle de la orden">
          {code ? <OrderDetail code={code} /> : <div className="empty">Elige una orden de la lista o busca su código.</div>}
        </section>
      </div>
    </>
  );
}

function OrderList({ selected }: { selected?: string }) {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const orders = useApi((s) => api.workOrders(s), [], { pollMs: 15_000 });
  const filtered = useMemo(() => {
    const q = text.trim().toUpperCase();
    return (orders.data ?? []).filter((o) => !q || o.code.toUpperCase().includes(q));
  }, [orders.data, text]);

  function go(e: FormEvent) {
    e.preventDefault();
    const code = text.trim().toUpperCase();
    if (code) navigate(`/ordenes/${encodeURIComponent(code)}`);
  }

  return (
    <aside className="panel" aria-label="Lista de órdenes">
      <form onSubmit={go} className="panel-pad" style={{ borderBottom: "1px solid var(--line)" }}>
        <label className="field" htmlFor="order-search"><span>Buscar por código</span></label>
        <div className="row" style={{ flexWrap: "nowrap", marginTop: 4 }}>
          <input id="order-search" className="input input-mono" value={text} placeholder="R061026012"
            autoComplete="off" spellCheck={false} onChange={(e) => setText(e.target.value)} />
          <button type="submit" className="btn" aria-label="Abrir orden"><IconSearch /></button>
        </div>
        {text.trim() && !ORDER_CODE.test(text.trim().toUpperCase()) && (
          <div className="hint" style={{ marginTop: 4 }}>Formato usual: R + 9 dígitos</div>
        )}
      </form>
      <Async state={orders} empty="No hay órdenes abiertas">
        {() => (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: "70vh", overflowY: "auto" }}>
            {filtered.length === 0 && <li className="empty">Ninguna orden coincide</li>}
            {filtered.map((o) => <OrderItem key={o.work_order_id} order={o} selected={o.code === selected} />)}
          </ul>
        )}
      </Async>
    </aside>
  );
}

function OrderItem({ order, selected }: { order: WorkOrderSummary; selected: boolean }) {
  return (
    <li>
      <Link to={`/ordenes/${encodeURIComponent(order.code)}`} aria-current={selected ? "page" : undefined}
        style={{
          display: "flex", justifyContent: "space-between", gap: 8, padding: "10px 14px", textDecoration: "none",
          borderBottom: "1px solid var(--line)",
          background: selected ? "color-mix(in srgb, var(--safety) 18%, transparent)" : undefined,
          boxShadow: selected ? "inset 4px 0 0 var(--safety)" : undefined,
        }}>
        <span style={{ minWidth: 0 }}>
          <span className="tag">{order.code}</span>
          <div className="muted" style={{ fontSize: "0.82rem", marginTop: 2 }}>
            {stageLabel(order.stage)}{order.department ? ` · ${DEPARTMENT_LABEL[order.department] ?? order.department}` : ""} · {fmtDate(order.received_at)}
          </div>
        </span>
        <span style={{ alignSelf: "center" }}>
          {order.lines === 0 ? <Badge tone="neutral">Sin piezas</Badge>
            : order.lines_missing > 0 ? <Badge tone="danger">{order.lines_missing} con faltante</Badge>
              : <Badge tone="ok"><IconCheck />Cubierta</Badge>}
        </span>
      </Link>
    </li>
  );
}

function lineStatus(l: MaterialLine): "missing" | "done" | "reserved" {
  if (l.missing == null || l.missing > 0) return "missing";
  if (l.required != null && l.issued >= l.required) return "done";
  return "reserved";
}

/** Retirar en Piso con la orden, la pieza y lo reservado ya llenos: solo falta escanear la ubicación. */
export function issueLink(code: string, line: MaterialLine): string | null {
  if (line.part_id == null || line.reserved <= 0) return null;
  const qs = new URLSearchParams({ modo: "retirar", orden: code, pieza: String(line.part_id), cant: String(line.reserved) });
  return `/piso?${qs}`;
}

export function MaterialsTable({ code, lines }: { code: string; lines: MaterialLine[] }) {
  return (
    <div className="table-wrap">
      <table className="table stackable">
        <thead>
          <tr>
            <th scope="col">Pieza</th>
            <th scope="col" className="num">Requerido</th>
            <th scope="col" className="num">Reservado</th>
            <th scope="col" className="num">Entregado</th>
            <th scope="col" className="num">Falta</th>
            <th scope="col">Avance</th>
            <th scope="col"><span className="sr-only">Acción</span></th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const status = lineStatus(l);
            const total = Math.max(l.required ?? 0, l.issued + l.reserved + (l.missing ?? 0), 1);
            return (
              <tr key={l.bom_line_id} className={status === "missing" ? "row-danger" : undefined}>
                <td className="name" data-label="Pieza">
                  {/* materials no trae el SKU: se enlaza por nombre al kardex de la pieza */}
                  {l.part_id == null
                    ? <div>{l.name} <Badge tone="warn">Sin identificar</Badge></div>
                    : <Link to={`/kardex/${l.part_id}`}>{l.name}</Link>}
                </td>
                <td className="num" data-label="Requerido">{fmtQty(l.required)}</td>
                <td className="num" data-label="Reservado">{fmtQty(l.reserved)}</td>
                <td className="num" data-label="Entregado">{fmtQty(l.issued)}</td>
                <td className="num" data-label="Falta">
                  {l.missing == null
                    ? <Badge tone="danger"><IconAlert />Cantidad por definir</Badge>
                    : l.missing > 0 ? <strong style={{ color: "var(--danger)" }}>{fmtQty(l.missing)}</strong> : "0"}
                </td>
                <td data-label="Avance">
                  <div className="bar" role="img"
                    aria-label={`${l.issued} entregado, ${l.reserved} reservado, ${l.missing ?? "sin cantidad"} falta`}>
                    <span className="issued" style={{ width: `${(l.issued / total) * 100}%` }} />
                    <span className="reserved" style={{ width: `${(l.reserved / total) * 100}%` }} />
                    <span className="missing" style={{ width: `${l.missing == null ? 100 : ((l.missing ?? 0) / total) * 100}%` }} />
                  </div>
                </td>
                <td data-label="">
                  {(() => {
                    const to = issueLink(code, l);
                    return to ? (
                      <Link to={to} className="btn" aria-label={`Retirar ${l.name} para la orden ${code}`}><IconOut />Retirar</Link>
                    ) : null;
                  })()}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function OrderDetail({ code }: { code: string }) {
  const materials = useApi((s) => api.materials(code, s), [code], { pollMs: 5_000 });

  if (materials.data === undefined) {
    if (materials.error?.status === 404) {
      return (
        <div className="empty" role="alert">
          <h2>Orden no encontrada</h2>
          <p>No existe la orden <Tag>{code}</Tag>. Revisa el código o elige otra de la lista.</p>
        </div>
      );
    }
    if (materials.error) return <ErrorBox error={materials.error} onRetry={materials.reload} />;
    return <Loading />;
  }

  const lines = materials.data.lines;
  const missing = lines.filter((l) => lineStatus(l) === "missing").length;
  const done = lines.filter((l) => lineStatus(l) === "done").length;

  return (
    <div>
      <div className="panel-pad row" style={{ justifyContent: "space-between", borderBottom: "1px solid var(--line)" }}>
        <div className="row">
          <Tag large>{materials.data.code}</Tag>
          <span className="muted">{lines.length} línea{lines.length === 1 ? "" : "s"}</span>
        </div>
        <div className="row">
          {missing > 0 && <Badge tone="danger"><IconAlert />{missing} con faltante</Badge>}
          {done > 0 && <Badge tone="ok"><IconCheck />{done} entregada{done === 1 ? "" : "s"}</Badge>}
          <button className="btn" onClick={openAdvisor}><IconAdvisor />Preguntar al Consejero</button>
          <Link to={`/almacen?tab=faltantes&orden=${encodeURIComponent(code)}`} className="btn">Ver faltantes</Link>
        </div>
      </div>
      {materials.error && <div className="banner danger" role="alert" style={{ margin: 12 }}><IconAlert />No se pudo actualizar: {materials.error.detail}</div>}
      {lines.length === 0
        ? <div className="empty">Esta orden aún no tiene piezas pedidas por una inspección aprobada.</div>
        : <MaterialsTable code={materials.data.code} lines={lines} />}
      <div className="legend panel-pad" aria-hidden="true">
        <span><i style={{ background: "var(--ok)" }} />Entregado</span>
        <span><i style={{ background: "var(--info)" }} />Reservado</span>
        <span><i style={{ background: "var(--danger)" }} />Falta</span>
      </div>
    </div>
  );
}
