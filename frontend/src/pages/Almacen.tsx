// Almacén: Faltantes · Compras sugeridas · Existencias · Sin relacionar. Pestañas y filtros en la URL.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  api, ApiError, catalog, errorMessage, fmtDate, fmtDateTime, fmtMoney, fmtQty, partLabel, UNMATCHED_REASON_LABEL, useApi,
  type Movement, type PartSummary, type UnmatchedReceipt,
} from "../api";
import { IconAlert, IconCheck, IconLink, IconX } from "../components/icons";
import PartSearch from "../components/PartSearch";
import { Async, Badge, PartTag, StockBadges, Tag } from "../components/ui";

const TABS = [
  { key: "faltantes", label: "Faltantes", kpi: "open_shortages" },
  { key: "compras", label: "Compras sugeridas", kpi: "open_suggestions" },
  { key: "existencias", label: "Existencias", kpi: null },
  { key: "sin-relacionar", label: "Sin relacionar", kpi: "unmatched_receipts" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export default function Almacen() {
  const [params, setParams] = useSearchParams();
  const tab: TabKey = TABS.some((t) => t.key === params.get("tab")) ? (params.get("tab") as TabKey) : "faltantes";
  const counts = useApi((s) => api.dashboard(s).then((d) => d.kpis), [tab], { pollMs: 30_000 });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Almacén</h1>
          <p className="muted">Lo que falta, lo que hay que comprar y lo que hay en existencia</p>
        </div>
      </div>
      <div className="tabs" role="tablist" aria-label="Secciones del almacén">
        {TABS.map((t) => {
          const n = t.kpi && counts.data ? counts.data[t.kpi] : null;
          return (
            <a key={t.key} role="tab" href={`#/almacen?tab=${t.key}`} aria-selected={t.key === tab}
              onClick={(e) => { e.preventDefault(); setParams({ tab: t.key }); }}>
              {t.label}{n != null && <span className="count">{fmtQty(n)}</span>}
            </a>
          );
        })}
      </div>
      <section className="panel" role="tabpanel" aria-label={TABS.find((t) => t.key === tab)!.label}>
        {tab === "faltantes" && <Shortages />}
        {tab === "compras" && <Suggestions />}
        {tab === "existencias" && <Stock />}
        {tab === "sin-relacionar" && <Unmatched />}
      </section>
    </>
  );
}

// ------------------------------------------------------------------ Faltantes

function Shortages() {
  const [params, setParams] = useSearchParams();
  const orden = params.get("orden") ?? "";
  const pieza = params.get("pieza") ? Number(params.get("pieza")) : undefined;
  const [orderText, setOrderText] = useState(orden);
  const shortages = useApi((s) => api.shortages({ work_order_code: orden || undefined, part_id: pieza }, s), [orden, pieza], { pollMs: 5_000 });

  function setFilter(key: "orden" | "pieza", value: string | null) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  }

  return (
    <>
      <div className="panel-pad row" style={{ alignItems: "flex-end", borderBottom: "1px solid var(--line)", gap: 12 }}>
        <form className="field" style={{ width: 220 }} onSubmit={(e) => { e.preventDefault(); setFilter("orden", orderText.trim().toUpperCase() || null); }}>
          <label htmlFor="f-order" className="field"><span>Orden</span></label>
          <input id="f-order" className="input input-mono" value={orderText} placeholder="R061026012"
            onChange={(e) => setOrderText(e.target.value)} onBlur={() => setFilter("orden", orderText.trim().toUpperCase() || null)} />
        </form>
        <div style={{ width: 300 }}>
          {pieza ? (
            <div className="field">
              <span className="field"><span>Pieza</span></span>
              <div className="row"><Tag>Pieza {pieza}</Tag><button className="btn btn-quiet" onClick={() => setFilter("pieza", null)} aria-label="Quitar filtro de pieza"><IconX /></button></div>
            </div>
          ) : (
            <PartSearch label="Pieza" onPick={(p) => setFilter("pieza", String(p.part_id))} />
          )}
        </div>
        {(orden || pieza) && (
          <button className="btn" onClick={() => { setOrderText(""); setParams({ tab: "faltantes" }); }}>Quitar filtros</button>
        )}
      </div>
      <Async state={shortages} empty={<><IconCheck /><div>Sin faltantes abiertos{orden || pieza ? " con estos filtros" : ""}</div></>}>
        {(items) => (
          <div className="table-wrap">
            <table className="table stackable">
              <thead>
                <tr>
                  <th scope="col">Orden</th>
                  <th scope="col">Pieza</th>
                  <th scope="col" className="num">Falta</th>
                  <th scope="col">Desde</th>
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <tr key={`${s.work_order_id}-${s.inspection_item_id}`}>
                    <td data-label="Orden"><Tag to={`/ordenes/${encodeURIComponent(s.work_order_code)}`}>{s.work_order_code}</Tag></td>
                    <td className="name" data-label="Pieza">
                      {s.part_id == null
                        ? <>{s.name} <Badge tone="warn">Sin identificar</Badge></>
                        : <Link to={`/kardex/${s.part_id}`}>{s.name}</Link>}
                    </td>
                    <td className="num" data-label="Falta">
                      {s.missing_quantity == null ? <Badge tone="warn">Cantidad por definir</Badge> : <strong style={{ color: "var(--danger)" }}>{fmtQty(s.missing_quantity)}</strong>}
                    </td>
                    <td data-label="Desde">{fmtDateTime(s.opened_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Async>
    </>
  );
}

// ------------------------------------------------------------------ Compras sugeridas

function Suggestions() {
  const suggestions = useApi((s) => api.suggestions(s), [], { pollMs: 10_000 });
  // El contrato da work_order_ids; la pantalla muestra y enlaza códigos (lista de órdenes en caché).
  const orders = useApi(() => catalog.workOrders(), []);
  const codeOf = useMemo(() => new Map((orders.data ?? []).map((o) => [o.work_order_id, o.code])), [orders.data]);

  return (
    <Async state={suggestions} empty={<><IconCheck /><div>No hay compras sugeridas</div></>}>
      {(items) => (
        <div className="table-wrap">
          <table className="table stackable">
            <thead>
              <tr>
                <th scope="col">Pieza</th>
                <th scope="col">SKU</th>
                <th scope="col" className="num">Comprar</th>
                <th scope="col">Órdenes que la piden</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.part_id}>
                  <td className="name" data-label="Pieza"><Link to={`/kardex/${s.part_id}`}>{s.name ?? `Pieza ${s.part_id}`}</Link></td>
                  <td data-label="SKU"><Tag>{partLabel(s)}</Tag></td>
                  <td className="num" data-label="Comprar"><strong>{fmtQty(s.suggested_quantity)}</strong></td>
                  <td data-label="Órdenes">
                    <span className="row" style={{ justifyContent: "flex-end" }}>
                      {s.work_order_ids.length === 0 && <span className="muted">Reposición por mínimo</span>}
                      {s.work_order_ids.map((id) => {
                        const code = codeOf.get(id);
                        return code
                          ? <Tag key={id} to={`/ordenes/${encodeURIComponent(code)}`}>{code}</Tag>
                          : <span key={id} className="tag" title="Orden dada de baja o aún sin cargar">#{id}</span>;
                      })}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Async>
  );
}

// ------------------------------------------------------------------ Existencias

function Stock() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const [text, setText] = useState(q);
  const [onlyAlerts, setOnlyAlerts] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => {
      if (text.trim() === q) return;
      const next = new URLSearchParams(params);
      if (text.trim()) next.set("q", text.trim());
      else next.delete("q");
      setParams(next, { replace: true });
    }, 250);
    return () => window.clearTimeout(t);
  }, [text, q, params, setParams]);

  const parts = useApi((s) => api.parts(q, s), [q], { pollMs: 15_000 });
  const alerts = (p: PartSummary) => p.available <= 0 || p.open_shortages > 0 || (p.min_qty != null && p.available < p.min_qty);
  const outOfStock = (parts.data ?? []).filter((p) => p.available <= 0).length;

  return (
    <>
      <div className="panel-pad row" style={{ justifyContent: "space-between", borderBottom: "1px solid var(--line)" }}>
        <div className="field" style={{ flex: "1 1 280px", maxWidth: 420 }}>
          <label htmlFor="stock-q" className="field"><span>Buscar</span></label>
          <input id="stock-q" className="input" type="search" value={text} placeholder="Nombre, SKU o número de pieza"
            onChange={(e) => setText(e.target.value)} />
        </div>
        <div className="row">
          {parts.data && <Badge tone={outOfStock ? "danger" : "ok"}>{fmtQty(outOfStock)} sin stock</Badge>}
          <label className="row" style={{ cursor: "pointer" }}>
            <input type="checkbox" checked={onlyAlerts} onChange={(e) => setOnlyAlerts(e.target.checked)} />
            Solo con alerta
          </label>
        </div>
      </div>
      <Async state={parts} empty={<div>Ninguna pieza coincide con “{q}”</div>}>
        {(items) => {
          const rows = onlyAlerts ? items.filter(alerts) : items;
          return (
            <div className="table-wrap">
              <table className="table stackable">
                <thead>
                  <tr>
                    <th scope="col">Pieza</th>
                    <th scope="col">Etiqueta</th>
                    <th scope="col" className="num">Existencia</th>
                    <th scope="col" className="num">Reservado</th>
                    <th scope="col" className="num">Disponible</th>
                    <th scope="col">Alertas</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.part_id}>
                      <td className="name" data-label="Pieza"><Link to={`/kardex/${p.part_id}`}>{p.name}</Link></td>
                      <td data-label="Etiqueta"><PartTag part={p} link={false} /></td>
                      <td className="num" data-label="Existencia">{fmtQty(p.on_hand)}</td>
                      <td className="num" data-label="Reservado">{fmtQty(p.reserved)}</td>
                      <td className="num" data-label="Disponible"><strong>{fmtQty(p.available)}</strong></td>
                      <td data-label="Alertas"><StockBadges part={p} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length === 0 && <div className="empty">Ninguna pieza con alerta</div>}
            </div>
          );
        }}
      </Async>
    </>
  );
}

// ------------------------------------------------------------------ Sin relacionar

function Unmatched() {
  const receipts = useApi((s) => api.unmatched(s), [], { pollMs: 15_000 });
  const [resolving, setResolving] = useState<UnmatchedReceipt | null>(null);
  const [done, setDone] = useState<string | null>(null);

  return (
    <>
      {done && <div className="banner ok" role="status" style={{ margin: 12 }}><IconCheck />{done}</div>}
      <Async state={receipts} empty={<><IconCheck /><div>Todas las recepciones están relacionadas con el catálogo</div></>}>
        {(items) => (
          <div className="table-wrap">
            <table className="table stackable">
              <thead>
                <tr>
                  <th scope="col">Número de parte</th>
                  <th scope="col">Descripción</th>
                  <th scope="col">Motivo</th>
                  <th scope="col" className="num">Cant.</th>
                  <th scope="col" className="num">Precio</th>
                  <th scope="col">Recibida</th>
                  <th scope="col">Orden</th>
                  <th scope="col"><span className="sr-only">Acción</span></th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={String(r.id)}>
                    <td data-label="Número de parte"><Tag>{r.part_number}</Tag></td>
                    <td className="name" data-label="Descripción">{r.description}</td>
                    <td data-label="Motivo">{r.reason ? <Badge tone={r.reason === "ambiguous" ? "warn" : "neutral"}>{UNMATCHED_REASON_LABEL[r.reason]}</Badge> : "—"}</td>
                    <td className="num" data-label="Cant.">{fmtQty(r.quantity)}</td>
                    <td className="num" data-label="Precio">{fmtMoney(r.unit_price, r.currency)}</td>
                    <td data-label="Recibida">{fmtDate(r.received_at)}</td>
                    <td data-label="Orden">{r.work_order_code ? <Tag to={`/ordenes/${encodeURIComponent(r.work_order_code)}`}>{r.work_order_code}</Tag> : <span className="muted">General</span>}</td>
                    <td data-label="">
                      <button className="btn btn-primary" onClick={() => { setDone(null); setResolving(r); }}><IconLink />Relacionar</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Async>
      {resolving && (
        <ResolveDialog receipt={resolving} onClose={() => setResolving(null)}
          onResolved={(m, part) => {
            setResolving(null);
            setDone(`Entrada registrada: ${m.quantity} × ${part.name} en la ubicación ${m.location_id}`);
            receipts.reload();
          }} />
      )}
    </>
  );
}

function ResolveDialog({ receipt, onClose, onResolved }: {
  receipt: UnmatchedReceipt;
  onClose: () => void;
  onResolved: (m: Movement, part: PartSummary) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [part, setPart] = useState<PartSummary | null>(null);
  const [locationId, setLocationId] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locations = useApi(() => catalog.locations(), []);

  useEffect(() => {
    const d = ref.current!;
    if (!d.open) d.showModal();
    return () => d.close();
  }, []);

  async function resolve() {
    if (!part || sending) return;
    setSending(true);
    setError(null);
    try {
      const m = await api.resolveReceipt(receipt.id, part.part_id, locationId ? Number(locationId) : undefined);
      onResolved(m, part);
    } catch (e) {
      setError(errorMessage(e as ApiError, "resolve"));
      setSending(false);
    }
  }

  return (
    <dialog ref={ref} onCancel={(e) => { e.preventDefault(); onClose(); }} aria-labelledby="resolve-title">
      <div className="dialog-head">
        <h2 id="resolve-title">Relacionar recepción</h2>
        <button className="btn btn-quiet" onClick={onClose} aria-label="Cerrar"><IconX /></button>
      </div>
      <div className="dialog-body">
        <div>
          <Tag>{receipt.part_number}</Tag> · {receipt.description}
          <div className="muted">{fmtQty(receipt.quantity)} piezas · {fmtMoney(receipt.unit_price, receipt.currency)} c/u{receipt.work_order_code ? ` · orden ${receipt.work_order_code}` : ""}</div>
        </div>
        {part ? (
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span><strong>{part.name}</strong> <Tag>{partLabel(part)}</Tag></span>
            <button className="btn btn-quiet" onClick={() => setPart(null)}>Cambiar</button>
          </div>
        ) : (
          <PartSearch label="¿Qué pieza es?" onPick={setPart} autoFocus />
        )}
        <label className="field" htmlFor="resolve-location">
          <span>Ubicación de entrada</span>
          <select id="resolve-location" className="input" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">Recepción (U-100)</option>
            {(locations.data ?? []).filter((l) => l.active).map((l) => (
              <option key={l.location_id} value={l.location_id}>{l.code} · {l.name}</option>
            ))}
          </select>
        </label>
        {error && <div className="banner danger" role="alert"><IconAlert />{error}</div>}
      </div>
      <div className="dialog-foot">
        <button className="btn" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" disabled={!part || sending} onClick={resolve}>
          {sending ? "Registrando…" : "Registrar entrada"}
        </button>
      </div>
    </dialog>
  );
}
