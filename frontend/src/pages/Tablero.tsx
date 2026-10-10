// Tablero (extras): inventario a costo promedio, rotación, pronóstico de demanda y estado del consumidor.
// Todo se calcula en el backend (/dashboard); aquí solo se dibuja.
import { Link, useSearchParams } from "react-router-dom";
import { api, consumerHealth, fmtDate, fmtDateTime, fmtMoney, fmtQty, partLabel, useApi, type Dashboard } from "../api";
import { BarChart, Kpi, LineChart } from "../components/charts";
import { Async, Tag } from "../components/ui";

const TABS = [
  { key: "inventario", label: "Inventario" },
  { key: "rotacion", label: "Rotación" },
  { key: "pronostico", label: "Pronóstico" },
  { key: "consumidor", label: "Consumidor" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export default function Tablero() {
  const [params, setParams] = useSearchParams();
  const tab: TabKey = TABS.some((t) => t.key === params.get("tab")) ? (params.get("tab") as TabKey) : "inventario";
  const dash = useApi((s) => api.dashboard(s), [], { pollMs: 15_000 });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Tablero</h1>
          <p className="muted">Estado del almacén y del servicio de inventario</p>
        </div>
      </div>
      <div className="tabs" role="tablist" aria-label="Secciones del tablero">
        {TABS.map((t) => (
          <a key={t.key} role="tab" href={`#/tablero?tab=${t.key}`} aria-selected={t.key === tab}
            onClick={(e) => { e.preventDefault(); setParams({ tab: t.key }); }}>{t.label}</a>
        ))}
      </div>
      <div role="tabpanel">
        <Async state={dash} isEmpty={() => false}>
          {(d) => (
            <>
              {tab === "inventario" && <Inventory d={d} />}
              {tab === "rotacion" && <Rotation d={d} />}
              {tab === "pronostico" && <Forecast d={d} />}
              {tab === "consumidor" && <Consumer d={d} />}
            </>
          )}
        </Async>
      </div>
    </>
  );
}

function Inventory({ d }: { d: Dashboard }) {
  const k = d.kpis;
  return (
    <>
      <div className="kpis">
        <Kpi label="Faltantes abiertos" value={fmtQty(k.open_shortages)} tone={k.open_shortages ? "danger" : "ok"} to="/almacen?tab=faltantes" sub="Ver faltantes" />
        <Kpi label="Piezas sin stock" value={fmtQty(k.parts_out_of_stock)} tone={k.parts_out_of_stock ? "danger" : "ok"} to="/almacen?tab=existencias" sub={`de ${fmtQty(k.active_parts)} activas`} />
        <Kpi label="Compras sugeridas" value={fmtQty(k.open_suggestions)} tone={k.open_suggestions ? "warn" : "ok"} to="/almacen?tab=compras" sub="Ver sugerencias" />
        <Kpi label="Recepciones sin relacionar" value={fmtQty(k.unmatched_receipts)} tone={k.unmatched_receipts ? "warn" : "ok"} to="/almacen?tab=sin-relacionar" sub="Relacionar a mano" />
      </div>
      <section className="panel panel-pad">
        <h2>Valor del inventario a costo promedio</h2>
        <p className="muted" style={{ marginTop: 4 }}>
          Costo promedio ponderado de las entradas de cada pieza, en la moneda de su última compra. Las monedas no se convierten ni se suman.
        </p>
        {k.inventory_value.length === 0 ? (
          <div className="empty">Aún no hay entradas con costo</div>
        ) : (
          <div className="kpis" style={{ marginBottom: 0 }}>
            {k.inventory_value.map((v) => <Kpi key={v.currency} label={v.currency} value={fmtMoney(v.amount, v.currency)} tone="info" />)}
          </div>
        )}
      </section>
    </>
  );
}

function Rotation({ d }: { d: Dashboard }) {
  const r = d.rotation;
  return (
    <div className="split" style={{ gridTemplateColumns: "minmax(0, 3fr) minmax(0, 2fr)" }}>
      <section className="panel panel-pad stack">
        <h2>Piezas de mayor demanda</h2>
        <p className="muted" style={{ margin: 0 }}>Cantidad pedida por inspecciones aprobadas más salidas registradas.</p>
        <BarChart
          title="Piezas de mayor demanda"
          series={[{ name: "Demanda (inspecciones)", color: "var(--info)" }, { name: "Salidas", color: "var(--safety-strong)" }]}
          rows={r.top.map((p) => ({
            key: p.part_id,
            label: <Link to={`/kardex/${p.part_id}`} title={p.name}>{p.name}</Link>,
            values: [p.demand, p.issued],
          }))}
        />
      </section>
      <section className="panel">
        <h2 className="panel-pad" style={{ borderBottom: "1px solid var(--line)" }}>Sin movimiento en {r.idle_days} días</h2>
        {r.idle.length === 0 ? (
          <div className="empty">Todas las piezas con existencia se han movido recientemente</div>
        ) : (
          <div className="table-wrap">
            <table className="table stackable">
              <thead>
                <tr>
                  <th scope="col">Pieza</th>
                  <th scope="col" className="num">Exist.</th>
                  <th scope="col" className="num">Último mov.</th>
                </tr>
              </thead>
              <tbody>
                {r.idle.map((p) => (
                  <tr key={p.part_id}>
                    <td data-label="Pieza">
                      <Link to={`/kardex/${p.part_id}`}>{p.name}</Link>
                      <div><Tag>{partLabel(p)}</Tag></div>
                    </td>
                    <td className="num" data-label="Existencia">{fmtQty(p.on_hand)}</td>
                    <td className="num" data-label="Último mov.">{fmtDate(p.last_movement_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Forecast({ d }: { d: Dashboard }) {
  const f = d.forecast;
  const labels = [...f.weeks.map((w) => w.week), ...f.projection.map((p) => p.week)].map((w) => fmtDate(`${w}T12:00:00Z`));
  const n = f.weeks.length;
  const pad = (vals: number[]) => [...vals, ...f.projection.map(() => null)];
  // La proyección arranca en la última semana real para que la línea punteada continúe la histórica.
  const projection = [
    ...f.weeks.map((_, i) => (i === n - 1 ? f.weeks[i].demand + f.weeks[i].issued : null)),
    ...f.projection.map((p) => p.demand),
  ];
  return (
    <section className="panel panel-pad stack">
      <h2>Demanda semanal y pronóstico</h2>
      <p className="muted" style={{ margin: 0 }}>Método: {f.method}.</p>
      <LineChart
        title="Demanda semanal y pronóstico"
        labels={labels}
        series={[
          { name: "Demanda (inspecciones)", color: "var(--info)", values: pad(f.weeks.map((w) => w.demand)) },
          { name: "Salidas", color: "var(--safety-strong)", values: pad(f.weeks.map((w) => w.issued)) },
          { name: "Entradas", color: "var(--ok)", values: pad(f.weeks.map((w) => w.received)) },
          { name: "Pronóstico", color: "var(--danger)", values: projection, dashed: true },
        ]}
      />
    </section>
  );
}

function Consumer({ d }: { d: Dashboard }) {
  const c = d.consumer;
  const { tone, text } = consumerHealth(c, false);
  const kpiTone = tone === "ok" ? "ok" : tone === "warn" ? "warn" : "danger";
  return (
    <>
      <div className={`banner ${kpiTone}`} role="status" style={{ marginBottom: 16 }}>
        <span className={`dot ${tone}`} aria-hidden="true" />{text}
      </div>
      <div className="kpis">
        <Kpi label="Eventos procesados" value={fmtQty(c.processed)} sub={`Último: ${fmtDateTime(c.last_processed_at)}`} tone="ok" />
        <Kpi label="En espera" value={fmtQty(c.pending)} tone={c.pending ? "warn" : "ok"} sub="Esperan algo que no ha llegado (desorden)" />
        <Kpi label="Para la DLQ" value={fmtQty(c.exhausted)} tone={c.exhausted ? "danger" : "ok"} sub="Agotaron sus intentos" />
        <Kpi label="Avisos sin publicar" value={fmtQty(c.outbox_unpublished)} tone={c.outbox_unpublished ? "warn" : "ok"}
          sub={c.oldest_unpublished_at ? `El más viejo: ${fmtDateTime(c.oldest_unpublished_at)}` : "Outbox al día"} />
      </div>
    </>
  );
}
