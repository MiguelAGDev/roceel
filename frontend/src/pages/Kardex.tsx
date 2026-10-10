// Kardex de una pieza: saldo total y por ubicación, política mín/máx y movimientos con saldo corrido.
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, catalog, fmtDateTime, fmtQty, fmtSigned, MOVEMENT_LABEL, partLabel, useApi, type LedgerEntry } from "../api";
import { openAdvisor } from "../components/Advisor";
import { IconAdvisor, IconBack } from "../components/icons";
import { Async, Badge, ErrorBox, Loading, StockBadges, Tag } from "../components/ui";
import { Kpi } from "../components/charts";

const PAGE = 50;

export default function Kardex() {
  const partId = Number(useParams().partId);
  const part = useApi((s) => api.part(partId, s), [partId], { pollMs: 10_000 });

  if (!Number.isInteger(partId)) return <div className="empty"><h1>Pieza no encontrada</h1></div>;
  if (part.data === undefined) {
    if (part.error?.status === 404) {
      return (
        <div className="empty" role="alert">
          <h1>Pieza no encontrada</h1>
          <p>No existe la pieza {partId}. <Link to="/almacen?tab=existencias">Ir a existencias</Link></p>
        </div>
      );
    }
    if (part.error) return <ErrorBox error={part.error} onRetry={part.reload} />;
    return <Loading />;
  }
  const p = part.data;

  return (
    <>
      <div className="page-head">
        <div>
          <Link to="/almacen?tab=existencias" className="btn btn-quiet" style={{ paddingLeft: 0 }}><IconBack />Existencias</Link>
          <h1 style={{ marginTop: 4 }}>{p.name}</h1>
          <div className="row" style={{ marginTop: 6 }}>
            <Tag large>{partLabel(p)}</Tag>
            <span className="muted">Pieza {p.part_id}{p.family ? ` · ${p.family}` : ""}{p.unit_name ? ` · ${p.unit_name}` : ""}</span>
            <StockBadges part={p} />
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={openAdvisor}><IconAdvisor />Preguntar al Consejero</button>
          <Link className="btn" to={`/almacen?tab=faltantes&pieza=${p.part_id}`}>Ver faltantes</Link>
        </div>
      </div>

      <div className="kpis">
        <Kpi label="Existencia" value={fmtQty(p.on_hand)} />
        <Kpi label="Reservado" value={fmtQty(p.reserved)} tone="info" sub="Para órdenes (a nivel pieza)" />
        <Kpi label="Disponible" value={fmtQty(p.available)} tone={p.available <= 0 ? "danger" : "ok"} />
        <Policy partId={p.part_id} available={p.available} />
      </div>

      <div className="split">
        <section className="panel" aria-labelledby="by-location">
          <h2 id="by-location" className="panel-pad" style={{ borderBottom: "1px solid var(--line)" }}>Por ubicación</h2>
          <ByLocation partId={p.part_id} />
        </section>
        <section className="panel" aria-labelledby="movements">
          <h2 id="movements" className="panel-pad" style={{ borderBottom: "1px solid var(--line)" }}>Movimientos</h2>
          <Movements partId={p.part_id} />
        </section>
      </div>
    </>
  );
}

function Policy({ partId, available }: { partId: number; available: number }) {
  const policy = useApi((s) => api.policy(partId, s), [partId]);
  const pol = policy.data;
  if (!pol) return <Kpi label="Política mín/máx" value="…" />;
  if (pol.min_qty == null && pol.max_qty == null) return <Kpi label="Política mín/máx" value={<span className="muted">—</span>} sub="Sin política" />;
  const below = pol.min_qty != null && available < pol.min_qty;
  return (
    <Kpi label="Política mín/máx" tone={below ? "warn" : "neutral"}
      value={`${fmtQty(pol.min_qty, "—")} / ${fmtQty(pol.max_qty, "—")}`}
      sub={below ? <Badge tone="warn">Bajo mínimo</Badge> : pol.lead_time_days != null ? `Entrega en ${pol.lead_time_days} días` : undefined} />
  );
}

function ByLocation({ partId }: { partId: number }) {
  const avail = useApi((s) => api.availability(partId, s), [partId], { pollMs: 10_000 });
  const locations = useApi(() => catalog.locations(), []);
  const nameOf = useMemo(() => new Map((locations.data ?? []).map((l) => [l.location_id, l.name])), [locations.data]);
  return (
    <Async state={avail} isEmpty={(a) => a.locations.length === 0} empty="Sin existencia en ninguna ubicación">
      {(a) => (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Ubicación</th>
              <th scope="col" className="num">Existencia</th>
            </tr>
          </thead>
          <tbody>
            {a.locations.map((l) => (
              <tr key={l.location_id}>
                <td>
                  <Tag>{l.code ?? `#${l.location_id}`}</Tag>{" "}
                  <span className="muted">{nameOf.get(l.location_id) ?? ""}</span>
                </td>
                <td className="num"><strong>{fmtQty(l.on_hand)}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Async>
  );
}

function referenceCell(e: LedgerEntry) {
  if (!e.reference) return <span className="muted">—</span>;
  if (e.type === "issue") return <Tag to={`/ordenes/${encodeURIComponent(e.reference)}`}>{e.reference}</Tag>;
  if (e.type === "receipt") return <span>Línea de compra {e.reference}</span>;
  return <span>{e.reference}</span>;
}

function Movements({ partId }: { partId: number }) {
  const ledger = useApi((s) => api.ledger(partId, s), [partId], { pollMs: 10_000 });
  // El kardex trae location_id; el código U-### sale del catálogo de ubicaciones (en caché).
  const locations = useApi(() => catalog.locations(), []);
  const codeOf = useMemo(() => new Map((locations.data ?? []).map((l) => [l.location_id, l.code])), [locations.data]);
  const [shown, setShown] = useState(PAGE);

  return (
    <Async state={ledger} isEmpty={(l) => l.entries.length === 0} empty="Esta pieza aún no tiene movimientos">
      {(l) => (
        <>
          <div className="table-wrap">
            <table className="table stackable">
              <thead>
                <tr>
                  <th scope="col">Fecha</th>
                  <th scope="col">Tipo</th>
                  <th scope="col" className="num">Cantidad</th>
                  <th scope="col">Ubicación</th>
                  <th scope="col">Referencia</th>
                  <th scope="col" className="num">Saldo</th>
                </tr>
              </thead>
              <tbody>
                {l.entries.slice(0, shown).map((e) => (
                  <tr key={String(e.movement_id)}>
                    <td data-label="Fecha">{fmtDateTime(e.occurred_at)}</td>
                    <td data-label="Tipo">{MOVEMENT_LABEL[e.type] ?? e.type}</td>
                    <td className="num" data-label="Cantidad" style={{ color: e.quantity < 0 ? "var(--danger)" : "var(--ok)", fontWeight: 700 }}>
                      {fmtSigned(e.quantity)}
                    </td>
                    <td data-label="Ubicación"><Tag>{codeOf.get(e.location_id) ?? `#${e.location_id}`}</Tag></td>
                    <td data-label="Referencia">{referenceCell(e)}</td>
                    <td className="num" data-label="Saldo"><strong>{fmtQty(e.balance)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {l.entries.length > shown && (
            <div className="panel-pad" style={{ textAlign: "center" }}>
              <button className="btn" onClick={() => setShown((n) => n + PAGE)}>
                Ver más ({fmtQty(l.entries.length - shown)} restantes)
              </button>
            </div>
          )}
        </>
      )}
    </Async>
  );
}
