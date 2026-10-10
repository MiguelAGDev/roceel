// Piso (celular): Retirar · Transferir · Contar, escaneando ubicación y pieza.
// Cada lectura llena el paso y avanza sola; siempre hay entrada manual y buscador por si falla la cámara.
import { useEffect, useReducer, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import {
  api, ApiError, catalog, errorMessage, fmtQty, fmtSigned, hasTouchCamera, ORDER_CODE, partLabel, stageLabel, store, useApi,
  type Location, type PartSummary,
} from "../api";
import { IconAlert, IconCheck, IconCount, IconKeyboard, IconCamera, IconMinus, IconOut, IconPlus, IconTransfer, IconTrash, IconX } from "../components/icons";
import PartSearch from "../components/PartSearch";
import Scanner from "../components/Scanner";
import { Tag } from "../components/ui";
import { initialState, MODES, reducer, STEPS, STEP_LABEL, type FloorState, type Mode, type StepKey } from "./floorFlow";

const MODE_META: Record<Mode, { label: string; Icon: typeof IconOut; verb: string }> = {
  retirar: { label: "Retirar", Icon: IconOut, verb: "Confirmar retiro" },
  transferir: { label: "Transferir", Icon: IconTransfer, verb: "Confirmar transferencia" },
  contar: { label: "Contar", Icon: IconCount, verb: "Registrar conteo" },
};

const KEY_ISSUED_BY = "piso.issued_by";
const KEY_ORDER = "piso.last_order";
const KEY_CAMERA = "piso.camera";

function locLabel(l: Location | null) {
  return l ? <Tag>{l.code}</Tag> : null;
}

export default function Piso() {
  const [params, setParams] = useSearchParams();
  const mode: Mode = MODES.includes(params.get("modo") as Mode) ? (params.get("modo") as Mode) : "retirar";
  // Desde Órdenes ("Retirar" en una línea) llegan la orden, la pieza y la cantidad reservada en la URL.
  const [state, dispatch] = useReducer(reducer, mode, (m) => {
    const orden = params.get("orden");
    return initialState(m, store.get(KEY_ORDER), orden ? { order: orden, quantity: Number(params.get("cant")) || undefined } : undefined);
  });
  const [issuedBy, setIssuedBy] = useState(() => store.get(KEY_ISSUED_BY));
  // En laptop no se ofrece la cámara: se teclea el código o se usa una pistola lectora USB.
  const [canCamera] = useState(hasTouchCamera);
  const [camera, setCamera] = useState(() => store.get(KEY_CAMERA) !== "off");
  const sendingRef = useRef(false);
  const lookingUp = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.mode !== mode) dispatch({ type: "mode", mode });
  }, [mode, state.mode]);

  // Pieza que viene en la URL: se carga una vez y se limpian los parámetros para que "Empezar de nuevo"
  // no los vuelva a usar.
  const prefillPart = useRef(params.get("pieza"));
  useEffect(() => {
    const id = Number(prefillPart.current);
    prefillPart.current = null;
    if (params.has("orden") || params.has("pieza")) setParams({ modo: mode }, { replace: true });
    if (!id) return;
    api.part(id).then(
      (part) => dispatch({ type: "part", part }),
      () => dispatch({ type: "notice", notice: `No se encontró la pieza ${id}; escanéala` }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scanStep = state.step === "location" || state.step === "to" || state.step === "part" || (state.step === "lines" && !state.part);

  // Foco al panel del paso actual: el lector de pantalla anuncia el cambio y el teclado sigue el flujo.
  // En laptop, en los pasos de escaneo, el foco va directo al campo del código: una pistola lectora USB
  // escribe ahí y manda Enter sin tocar nada.
  useEffect(() => {
    const manual = !canCamera && scanStep ? document.getElementById("manual-code") : null;
    (manual ?? panelRef.current)?.focus({ preventScroll: true });
  }, [state.step, state.part, canCamera, scanStep]);
  const wants: "location" | "part" = state.step === "location" || state.step === "to" ? "location" : "part";

  async function handleCode(raw: string) {
    const text = raw.replace(/[\r\n]+$/, "");
    if (!text.trim() || lookingUp.current || state.sending) return;
    lookingUp.current = true;
    try {
      const res = await api.scan(text);
      if (res.kind !== wants) {
        dispatch({ type: "notice", notice: res.kind === "location" ? `${text} es una ubicación; ahora escanea una pieza` : `${text} es una pieza; ahora escanea una ubicación` });
        return;
      }
      if (res.kind === "location") {
        if (res.locations.length > 1) dispatch({ type: "candidates", candidates: { kind: "location", items: res.locations } });
        else dispatch({ type: "location", location: res.location });
      } else if (res.parts.length > 1) {
        // Un mismo SKU puede ser de varias piezas: nunca se toma la primera, se pide elegir.
        dispatch({ type: "candidates", candidates: { kind: "part", items: res.parts } });
      } else {
        dispatch({ type: "part", part: res.parts[0] });
      }
    } catch (e) {
      const err = e as ApiError;
      dispatch({ type: "notice", notice: err.status === 404 ? `Código desconocido: ${text}` : err.detail });
    } finally {
      lookingUp.current = false;
    }
  }

  async function submit() {
    if (sendingRef.current) return; // un doble toque no manda dos salidas
    if (state.mode === "retirar" && !issuedBy.trim()) {
      dispatch({ type: "notice", notice: "Escribe quién retira (técnico) antes de confirmar" });
      return;
    }
    sendingRef.current = true;
    dispatch({ type: "send" });
    try {
      if (state.mode === "retirar") {
        const movement = await api.issue({
          work_order_code: state.order, part_id: state.part!.part_id, location_id: state.location!.location_id,
          quantity: state.quantity, issued_by: issuedBy.trim(),
        });
        store.set(KEY_ORDER, state.order);
        dispatch({ type: "success", movement });
      } else if (state.mode === "transferir") {
        const movement = await api.transfer({
          part_id: state.part!.part_id, from_location_id: state.location!.location_id,
          to_location_id: state.to!.location_id, quantity: state.quantity,
        });
        dispatch({ type: "success", movement });
      } else {
        const count = await api.count({
          location_id: state.location!.location_id, reason: state.reason.trim(),
          lines: state.lines.map((l) => ({ part_id: l.part.part_id, counted_quantity: l.counted })),
        });
        dispatch({ type: "success", count });
      }
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(0, String(e));
      const ctx = state.mode === "retirar" ? "issue" : state.mode === "transferir" ? "transfer" : "count";
      dispatch({ type: "failure", status: err.status, message: `${errorMessage(err, ctx)}${err.status === 409 ? ` (${err.detail})` : ""}` });
    } finally {
      sendingRef.current = false;
    }
  }

  return (
    <div className="floor">
      <h1 className="sr-only">Piso: {MODE_META[mode].label}</h1>
      <nav className="modes" aria-label="Modo">
        {MODES.map((m) => {
          const { label, Icon } = MODE_META[m];
          return (
            <a key={m} href={`#/piso?modo=${m}`} aria-current={m === mode ? "page" : undefined}
              onClick={(e) => { e.preventDefault(); setParams({ modo: m }); }}>
              <Icon />{label}
            </a>
          );
        })}
      </nav>

      {/* El contrato exige issued_by en POST /issues: se pide una vez y se recuerda en este celular. */}
      {state.mode === "retirar" && (
        <WhoWithdraws value={issuedBy} onChange={(v) => { setIssuedBy(v); store.set(KEY_ISSUED_BY, v.trim()); }} />
      )}

      <StepRail state={state} onEdit={(s) => dispatch({ type: "goto", step: s })} />

      <div ref={panelRef} tabIndex={-1} className="panel" style={{ outline: "none" }} aria-live="polite">
        {state.step === "result" && state.result?.ok ? (
          <ResultPanel state={state} onAgain={() => dispatch({ type: "again" })} onReset={() => dispatch({ type: "reset" })} />
        ) : state.candidates ? (
          <CandidatePicker state={state} dispatch={dispatch} />
        ) : (
          <div className="step-panel">
            {state.notice && <div className="banner warn" role="alert"><IconAlert />{state.notice}</div>}

            {scanStep && (
              <>
                <div className="step-title">
                  {state.step === "lines"
                    ? state.lines.length ? "Escanea otra pieza o termina" : "Escanea la primera pieza contada"
                    : `Escanea ${state.step === "part" ? "la pieza" : state.step === "to" ? "la ubicación destino" : state.mode === "transferir" ? "la ubicación origen" : "la ubicación"}`}
                </div>
                {canCamera && camera ? <Scanner onScan={handleCode} paused={state.sending} /> : null}
                {canCamera && (
                  <div className="row" style={{ justifyContent: "flex-end" }}>
                    <button type="button" className="btn btn-quiet" onClick={() => { setCamera(!camera); store.set(KEY_CAMERA, camera ? "off" : "on"); }}>
                      {camera ? <><IconKeyboard />Solo teclado</> : <><IconCamera />Usar cámara</>}
                    </button>
                  </div>
                )}
                <ManualCode onSubmit={handleCode} placeholder={wants === "location" ? "U-101" : "SKU o P-24"} />
                {wants === "part" && <PartSearch label="o busca la pieza" onPick={(p) => dispatch({ type: "part", part: p })} />}
                {state.step === "lines" && <CountLines state={state} dispatch={dispatch} />}
              </>
            )}

            {state.step === "lines" && state.part && <CountLineEntry state={state} dispatch={dispatch} />}
            {state.step === "quantity" && <QuantityStep state={state} dispatch={dispatch} />}
            {state.step === "order" && <OrderStep state={state} dispatch={dispatch} />}
            {state.step === "reason" && <ReasonStep state={state} dispatch={dispatch} />}
            {state.step === "confirm" && (
              <ConfirmStep state={state} issuedBy={issuedBy}
                onSubmit={submit}
                onOtherLocation={() => dispatch({ type: "otherLocation" })} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

type Dispatch = React.Dispatch<Parameters<typeof reducer>[1]>;

/** Quién retira: se pide una sola vez (si falta) y luego se muestra en una línea con "cambiar". */
function WhoWithdraws({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(!value.trim());
  const [text, setText] = useState(value);
  if (!editing && value.trim()) {
    return (
      <div className="row who" style={{ justifyContent: "space-between", marginBottom: 10 }}>
        <span>Retira: <strong>{value}</strong></span>
        <button type="button" className="btn btn-quiet" onClick={() => { setText(value); setEditing(true); }}>Cambiar</button>
      </div>
    );
  }
  return (
    <form className="panel panel-pad stack" style={{ marginBottom: 10, gap: 8 }}
      onSubmit={(e) => { e.preventDefault(); if (text.trim()) { onChange(text.trim()); setEditing(false); } }}>
      <label className="field" htmlFor="issued-by"><span>¿Quién retira?</span></label>
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <input id="issued-by" className="input input-xl" value={text} placeholder="Nombre o número de técnico"
          autoComplete="name" onChange={(e) => setText(e.target.value)} />
        <button type="submit" className="btn btn-primary" style={{ minHeight: "var(--touch)" }} disabled={!text.trim()}>Listo</button>
      </div>
      <div className="hint">Se pide una sola vez en este celular; queda en el kardex de cada salida.</div>
    </form>
  );
}

function StepRail({ state, onEdit }: { state: FloorState; onEdit: (s: StepKey) => void }) {
  const steps = STEPS[state.mode];
  const value = (s: StepKey) => {
    switch (s) {
      case "location": return locLabel(state.location);
      case "to": return locLabel(state.to);
      case "part": return state.part ? <Tag>{partLabel(state.part)}</Tag> : null;
      case "quantity": return state.completed.includes("quantity") ? <strong className="num">{fmtQty(state.quantity)}</strong> : null;
      case "order":
        if (!state.completed.includes("order")) return null;
        return (
          <span className="row" style={{ flexWrap: "nowrap", gap: 6 }}>
            {state.orderSource === "auto" && <span className="badge info">auto</span>}
            {state.orderSource === "url" && <span className="badge info">de la orden</span>}
            <Tag>{state.order}</Tag>
          </span>
        );
      case "lines": return state.lines.length ? <strong>{state.lines.length} pieza{state.lines.length === 1 ? "" : "s"}</strong> : null;
      case "reason": return state.completed.includes("reason") ? <span className="muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{state.reason}</span> : null;
    }
  };
  const editable = state.step !== "result" && !state.sending;
  return (
    <ol className="step-rail" aria-label="Pasos">
      {steps.map((s, i) => {
        const done = state.completed.includes(s);
        const current = state.step === s;
        const cls = current ? "current" : done ? "done" : "todo";
        const v = value(s);
        return (
          <li key={s} className={cls} aria-current={current ? "step" : undefined}>
            <span className="n" aria-hidden="true">{done && !current ? <IconCheck width={14} height={14} /> : i + 1}</span>
            <span className="label">{STEP_LABEL[state.mode][s]}</span>
            {done && !current && editable ? (
              <button type="button" className="value" onClick={() => onEdit(s)} aria-label={`Corregir ${STEP_LABEL[state.mode][s]}`}>{v}</button>
            ) : (
              <span className="value">{v}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function ManualCode({ onSubmit, placeholder }: { onSubmit: (code: string) => void; placeholder: string }) {
  const [text, setText] = useState("");
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    onSubmit(text);
    setText("");
  }
  return (
    <form onSubmit={submit} className="stack" style={{ gap: 6 }}>
      <label className="field" htmlFor="manual-code"><span>Teclear el código</span></label>
      <div className="row" style={{ flexWrap: "nowrap" }}>
        {/* Sin autocorrección ni mayúsculas automáticas: el SKU se manda tal cual. */}
        <input id="manual-code" className="input input-xl input-mono" value={text} placeholder={placeholder}
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
          onChange={(e) => setText(e.target.value)} />
        <button type="submit" className="btn btn-primary" style={{ minHeight: "var(--touch)" }}>Buscar</button>
      </div>
    </form>
  );
}

function CandidatePicker({ state, dispatch }: { state: FloorState; dispatch: Dispatch }) {
  const c = state.candidates!;
  return (
    <div className="step-panel">
      <div className="step-title">{c.kind === "part" ? "Ese código es de varias piezas: elige cuál" : "Hay varias ubicaciones con ese código: elige cuál"}</div>
      <ul className="candidates">
        {c.kind === "part"
          ? c.items.map((p) => (
            <li key={p.part_id}>
              <button type="button" onClick={() => dispatch({ type: "part", part: p })}>
                <span><strong>{p.name}</strong><br /><span className="muted">Pieza {p.part_id} · {p.family ?? "sin familia"}</span></span>
                <span className="num">disp. {fmtQty(p.available)}</span>
              </button>
            </li>
          ))
          : c.items.map((l) => (
            <li key={l.location_id}>
              <button type="button" onClick={() => dispatch({ type: "location", location: l })}>
                <span><strong>{l.name}</strong><br /><span className="muted">Ubicación {l.location_id}{l.active ? "" : " · inactiva"}</span></span>
                <Tag>{l.code}</Tag>
              </button>
            </li>
          ))}
      </ul>
      <button type="button" className="btn" onClick={() => dispatch({ type: "goto", step: state.step as StepKey })}>
        <IconX />Cancelar
      </button>
    </div>
  );
}

function Stepper({ value, min, onChange, label }: { value: number; min: number; onChange: (n: number) => void; label: string }) {
  return (
    <div className="stepper">
      <button type="button" className="btn" onClick={() => onChange(Math.max(min, value - 1))} aria-label="Uno menos"><IconMinus /></button>
      <input className="input" inputMode="numeric" pattern="[0-9]*" aria-label={label}
        value={Number.isFinite(value) ? String(value) : ""}
        onChange={(e) => onChange(Number(e.target.value.replace(/\D/g, "")))}
        onFocus={(e) => e.target.select()} />
      <button type="button" className="btn" onClick={() => onChange(value + 1)} aria-label="Uno más"><IconPlus /></button>
    </div>
  );
}

/** Contexto, no validación: cuánto hay de la pieza en la ubicación elegida (la API decide si alcanza). */
function StockHere({ part, location }: { part: PartSummary; location: Location }) {
  const avail = useApi((s) => api.availability(part.part_id, s), [part.part_id]);
  if (!avail.data) return null;
  const here = avail.data.locations.find((l) => l.location_id === location.location_id)?.on_hand ?? 0;
  return (
    <div className="hint">
      Hay <strong>{fmtQty(here)}</strong> en <Tag>{location.code}</Tag> · disponible total {fmtQty(avail.data.available)}
    </div>
  );
}

function QuantityStep({ state, dispatch }: { state: FloorState; dispatch: Dispatch }) {
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); dispatch({ type: "confirmQuantity" }); }}>
      <div className="step-title">¿Cuántas?</div>
      <div><strong>{state.part?.name}</strong> {state.part && <Tag>{partLabel(state.part)}</Tag>}</div>
      {state.mode === "retirar" && state.order && <div className="hint">Para la orden <Tag>{state.order}</Tag></div>}
      {state.part && state.location && <StockHere part={state.part} location={state.location} />}
      <Stepper value={state.quantity} min={1} label="Cantidad" onChange={(n) => dispatch({ type: "quantity", quantity: n })} />
      <button type="submit" className="btn btn-primary btn-xl">Siguiente</button>
    </form>
  );
}

function OrderStep({ state, dispatch }: { state: FloorState; dispatch: Dispatch }) {
  const orders = useApi(() => catalog.workOrders(), []);
  const part = state.part;
  // Órdenes que esperan esta pieza (algo reservado por entregar o un faltante abierto).
  const waiting = useApi((s) => (part ? api.partOrders(part.part_id, s) : Promise.resolve([])), [part?.part_id]);
  const firstTime = !state.completed.includes("order");

  // Si solo una orden espera la pieza, se llena sola y se salta el paso (una vez por pieza, y no cuando el
  // usuario volvió a este paso para corregir la orden).
  useEffect(() => {
    const list = waiting.data;
    if (!part || !list || list.length !== 1 || !firstTime || state.autoOrderFor === part.part_id) return;
    const o = list[0];
    dispatch({ type: "pickOrder", order: o.code, source: "auto", quantity: o.reserved > 0 ? o.reserved : undefined });
  }, [waiting.data, part, firstTime, state.autoOrderFor, dispatch]);

  const warn = state.order.trim() !== "" && !ORDER_CODE.test(state.order.trim());
  const list = waiting.data ?? [];
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); dispatch({ type: "confirmOrder" }); }}>
      <div className="step-title">¿Para qué orden?</div>
      {waiting.loading && !waiting.data && <div className="hint">Buscando órdenes que esperan esta pieza…</div>}
      {list.length > 0 && (
        <>
          <div className="hint">Órdenes que esperan esta pieza:</div>
          <ul className="candidates">
            {list.map((o) => (
              <li key={o.work_order_id}>
                <button type="button" onClick={() => dispatch({
                  type: "pickOrder", order: o.code, source: "manual", quantity: o.reserved > 0 ? o.reserved : undefined,
                })}>
                  <span>
                    <Tag>{o.code}</Tag>
                    <br /><span className="muted">{stageLabel(o.stage)}</span>
                  </span>
                  <span className="stack" style={{ gap: 4, alignItems: "flex-end" }}>
                    {o.reserved > 0 && <span className="badge info">{fmtQty(o.reserved)} reservada{o.reserved === 1 ? "" : "s"}</span>}
                    {(o.missing > 0 || o.missing_unknown) && (
                      <span className="badge danger">{o.missing > 0 ? `falta ${fmtQty(o.missing)}` : "falta (sin cantidad)"}</span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <label className="field" htmlFor="order-code"><span>{list.length ? "U otra orden" : "Código de la orden"}</span></label>
      <input id="order-code" className="input input-xl input-mono" list="open-orders" value={state.order}
        placeholder="R061026012" autoComplete="off" autoCapitalize="characters" spellCheck={false}
        onChange={(e) => dispatch({ type: "order", order: e.target.value })} />
      <datalist id="open-orders">
        {(orders.data ?? []).map((o) => <option key={o.work_order_id} value={o.code} />)}
      </datalist>
      {warn && <div className="hint warn">El código no tiene la forma usual (R + 9 dígitos); se enviará igual.</div>}
      <button type="submit" className="btn btn-primary btn-xl">Siguiente</button>
    </form>
  );
}

function CountLineEntry({ state, dispatch }: { state: FloorState; dispatch: Dispatch }) {
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); dispatch({ type: "addLine" }); }}>
      <div className="step-title">¿Cuántas contaste?</div>
      <div><strong>{state.part!.name}</strong> <Tag>{partLabel(state.part!)}</Tag></div>
      {state.location && <StockHere part={state.part!} location={state.location} />}
      <Stepper value={state.quantity} min={0} label="Cantidad contada" onChange={(n) => dispatch({ type: "quantity", quantity: n })} />
      <button type="submit" className="btn btn-primary btn-xl">Agregar al conteo</button>
    </form>
  );
}

function CountLines({ state, dispatch }: { state: FloorState; dispatch: Dispatch }) {
  if (!state.lines.length) return null;
  return (
    <div className="stack">
      <ul className="count-lines" aria-label="Piezas contadas">
        {state.lines.map((l, i) => (
          <li key={l.part.part_id}>
            <span style={{ minWidth: 0 }}>{l.part.name} <Tag>{partLabel(l.part)}</Tag></span>
            <span className="row" style={{ flexWrap: "nowrap" }}>
              <strong className="num">{fmtQty(l.counted)}</strong>
              <button type="button" className="btn btn-quiet" aria-label={`Quitar ${l.part.name}`} onClick={() => dispatch({ type: "removeLine", index: i })}><IconTrash /></button>
            </span>
          </li>
        ))}
      </ul>
      <button type="button" className="btn btn-primary btn-xl" onClick={() => dispatch({ type: "finishLines" })}>Terminar conteo</button>
    </div>
  );
}

function ReasonStep({ state, dispatch }: { state: FloorState; dispatch: Dispatch }) {
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); dispatch({ type: "confirmReason" }); }}>
      <div className="step-title">Motivo del conteo</div>
      <label className="field" htmlFor="count-reason"><span>Motivo (obligatorio)</span></label>
      <input id="count-reason" className="input input-xl" value={state.reason} required placeholder="Conteo cíclico, merma, error de captura…"
        onChange={(e) => dispatch({ type: "reason", reason: e.target.value })} />
      <div className="row">
        {["Conteo cíclico", "Merma", "Error de captura"].map((r) => (
          <button key={r} type="button" className="btn" onClick={() => dispatch({ type: "reason", reason: r })}>{r}</button>
        ))}
      </div>
      <button type="submit" className="btn btn-primary btn-xl">Siguiente</button>
    </form>
  );
}

function ConfirmStep({ state, issuedBy, onSubmit, onOtherLocation }: {
  state: FloorState;
  issuedBy: string;
  onSubmit: () => void;
  onOtherLocation: () => void;
}) {
  const failed = state.result && !state.result.ok ? state.result : null;
  const missingName = state.mode === "retirar" && !issuedBy.trim();
  return (
    <div className="stack">
      <div className="step-title">Revisa y confirma</div>
      <Summary state={state} />
      {state.mode === "retirar" && !missingName && <div className="muted">Retira: {issuedBy}</div>}
      {missingName && <div className="banner warn" role="alert"><IconAlert />Escribe arriba quién retira para confirmar</div>}
      {failed && (
        <div className="result danger" role="alert">
          <div className="result-title"><IconAlert />{failed.message}</div>
          {failed.status === 409 && state.mode !== "contar" && (
            <button type="button" className="btn btn-xl" onClick={onOtherLocation}>Escanear otra ubicación</button>
          )}
        </div>
      )}
      <button type="button" className="btn btn-primary btn-xl" disabled={state.sending || missingName} onClick={onSubmit}>
        {state.sending ? "Enviando…" : MODE_META[state.mode].verb}
      </button>
    </div>
  );
}

function Summary({ state }: { state: FloorState }) {
  if (state.mode === "contar") {
    return (
      <div>
        <div>Ubicación {locLabel(state.location)} · {state.lines.length} pieza{state.lines.length === 1 ? "" : "s"}</div>
        <div className="muted">Motivo: {state.reason}</div>
      </div>
    );
  }
  return (
    <div style={{ fontSize: "1.1rem" }}>
      <div><strong className="num">{fmtQty(state.quantity)}</strong> × {state.part?.name} {state.part && <Tag>{partLabel(state.part)}</Tag>}</div>
      {state.mode === "retirar"
        ? <div>de {locLabel(state.location)} para la orden <Tag>{state.order}</Tag></div>
        : <div>de {locLabel(state.location)} a {locLabel(state.to)}</div>}
    </div>
  );
}

function ResultPanel({ state, onAgain, onReset }: { state: FloorState; onAgain: () => void; onReset: () => void }) {
  const result = state.result as Extract<NonNullable<FloorState["result"]>, { ok: true }>;
  const snap = result.snapshot;
  const title = snap.mode === "retirar" ? "Salida registrada" : snap.mode === "transferir" ? "Transferencia registrada" : "Conteo registrado";
  return (
    <div className="step-panel">
      <div className="result ok" role="status">
        <div className="result-title"><IconCheck />{title}</div>
        {snap.mode !== "contar" && <Summary state={snap} />}
        {result.movement && <div className="muted">Movimiento {String(result.movement.movement_id)}</div>}
        {result.count && (
          result.count.adjustments.length === 0 ? (
            <div>Sin diferencias: no se registró ningún ajuste.</div>
          ) : (
            <ul className="count-lines">
              {result.count.adjustments.map((a) => {
                const line = snap.lines.find((l) => l.part.part_id === a.part_id);
                return (
                  <li key={a.part_id}>
                    <span>{line?.part.name ?? `Pieza ${a.part_id}`}</span>
                    <strong className="num">{fmtSigned(a.delta)}</strong>
                  </li>
                );
              })}
            </ul>
          )
        )}
      </div>
      <button type="button" className="btn btn-primary btn-xl" onClick={onAgain} autoFocus>
        {snap.mode === "contar" ? "Contar otra vez esta ubicación" : "Otra pieza (misma ubicación)"}
      </button>
      <button type="button" className="btn btn-xl" onClick={onReset}>Empezar de nuevo</button>
    </div>
  );
}
