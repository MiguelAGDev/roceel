// Asesor "El Consejero": ventana flotante en todas las pantallas que conversa con Gemini (POST /advisor).
// Solo lee; el backend le pasa los datos de ahora en cada pregunta. Si estás en el kardex de una pieza o en
// una orden, la pregunta va sobre esa pieza u orden. Las respuestas traen acciones (enlaces a la pantalla
// donde se hace, armados por el backend) y preguntas para seguir.
import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, matchPath, useLocation } from "react-router-dom";
import { api, ApiError, errorMessage, useApi, type AdvisorAction, type AdvisorTurn } from "../api";
import { IconAdvisor, IconX } from "./icons";
import { ErrorBox, PartTag, Tag } from "./ui";

const GENERAL = [
  "¿Qué compro primero y por qué?",
  "¿Qué inventario es capital muerto?",
  "Si no alcanza, ¿qué orden sacrifico?",
  "¿Cómo viene la demanda?",
];
const FOR_PART = ["¿Cuánto pido de esta pieza?", "Explícame su kardex"];
const FOR_ORDER = ["¿Por qué le falta material a esta orden?", "¿Qué hago para terminar esta orden?"];
const OPEN_EVENT = "advisor:open";

/** Abre la ventana del asesor desde cualquier pantalla (p. ej. el botón "Preguntar al Consejero"). */
export function openAdvisor() {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

type Turn = AdvisorTurn & { actions?: AdvisorAction[] };

/** El modelo puede marcar **negritas**; es el único formato que se pinta (el resto queda en texto plano). */
function Rich({ text }: { text: string }) {
  return <>{text.split(/\*\*(.+?)\*\*/g).map((chunk, i) => (i % 2 ? <strong key={i}>{chunk}</strong> : <Fragment key={i}>{chunk}</Fragment>))}</>;
}

/** La pieza u orden de la pantalla actual, si la hay. */
function useScreenContext() {
  const { pathname } = useLocation();
  const kardex = matchPath("/kardex/:partId", pathname);
  const order = matchPath("/ordenes/:code", pathname);
  const partId = Number(kardex?.params.partId);
  return {
    partId: Number.isInteger(partId) && partId > 0 ? partId : undefined,
    orderCode: order?.params.code || undefined,
  };
}

const isPhone = () => window.matchMedia?.("(max-width: 767px)").matches ?? false;

export default function Advisor() {
  const [open, setOpen] = useState(false);
  const { partId, orderCode } = useScreenContext();
  const part = useApi((s) => (partId ? api.part(partId, s) : Promise.resolve(undefined)), [partId], { enabled: open });

  const [turns, setTurns] = useState<Turn[]>([]);
  const [followUps, setFollowUps] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<ApiError>();
  const sendingRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, show);
    return () => window.removeEventListener(OPEN_EVENT, show);
  }, []);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => { endRef.current?.scrollIntoView?.({ block: "nearest" }); }, [turns, sending, open]);

  const ask = useCallback(async (question: string) => {
    const q = question.trim();
    if (!q || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError(undefined);
    setDraft("");
    const before = turns;
    setTurns([...before, { role: "user", text: q }]);
    try {
      const res = await api.advisor({
        question: q,
        history: before.map(({ role, text }) => ({ role, text })),
        part_id: partId,
        work_order_code: orderCode,
      });
      setTurns([...before, { role: "user", text: q }, { role: "model", text: res.answer, actions: res.actions }]);
      setFollowUps(res.follow_ups);
    } catch (err) {
      // Sin respuesta, la pregunta vuelve al campo para reintentar y no queda en el historial.
      setTurns(before);
      setDraft(q);
      setError(err instanceof ApiError ? err : new ApiError(0, String(err)));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [turns, partId, orderCode]);

  function submit(e: FormEvent) {
    e.preventDefault();
    void ask(draft);
  }

  function reset() {
    setTurns([]);
    setFollowUps([]);
    setError(undefined);
  }

  const starters = [...(partId ? FOR_PART : []), ...(orderCode ? FOR_ORDER : []), ...GENERAL].slice(0, 4);
  const suggestions = turns.length && followUps.length ? followUps : starters;

  return (
    <>
      {open && (
        <section className="advisor-window" role="dialog" aria-label="El Consejero">
          <header className="advisor-head">
            <div>
              <strong>El Consejero</strong>
              <div className="advisor-context">
                {partId || orderCode ? (
                  <>
                    <span className="muted">Sobre</span>
                    {partId && (part.data ? <PartTag part={part.data} /> : <Tag>Pieza {partId}</Tag>)}
                    {orderCode && <Tag>{orderCode}</Tag>}
                  </>
                ) : <span className="muted">Asesor con IA · solo aconseja</span>}
              </div>
            </div>
            <div className="row">
              {turns.length > 0 && <button className="btn btn-quiet" onClick={reset} disabled={sending}>Nueva</button>}
              <button className="btn btn-quiet advisor-close" onClick={() => setOpen(false)} aria-label="Cerrar"><IconX /></button>
            </div>
          </header>

          <div className="advisor-log" aria-live="polite">
            {turns.length === 0 && !sending && (
              <p className="muted advisor-hint">
                Pregunta lo que quieras. Cada respuesta usa los datos de este momento
                {partId || orderCode ? " y lo que ves en esta pantalla" : ""}; no ejecuta nada, la decisión es tuya.
              </p>
            )}
            {turns.map((t, i) => (
              <div key={i} className={`advisor-msg ${t.role}`}>
                <span className="advisor-who">{t.role === "user" ? "Tú" : "El Consejero"}</span>
                <div className="advisor-text"><Rich text={t.text} /></div>
                {t.actions && t.actions.length > 0 && (
                  <div className="advisor-actions" aria-label="Qué hacer">
                    {t.actions.map((a) => (
                      <Link key={a.to + a.label} to={a.to} className="btn" onClick={() => { if (isPhone()) setOpen(false); }}>
                        {a.label} →
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {sending && (
              <div className="advisor-msg model" role="status">
                <span className="advisor-who">El Consejero</span>
                <div className="advisor-text muted">El Consejero calcula…</div>
              </div>
            )}
            <div ref={endRef} />
          </div>

          {error && <div className="advisor-error"><ErrorBox error={new ApiError(error.status, errorMessage(error, "advisor"))} /></div>}

          <div className="advisor-chips" aria-label="Preguntas sugeridas">
            {suggestions.map((s) => (
              <button key={s} type="button" className="chip" onClick={() => void ask(s)} disabled={sending}>{s}</button>
            ))}
          </div>

          <form className="advisor-form" onSubmit={submit}>
            <textarea ref={inputRef} className="input" rows={2} maxLength={1000} placeholder="Escribe tu pregunta…"
              aria-label="Tu pregunta" value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(draft); } }} />
            <button className="btn btn-primary" type="submit" disabled={sending || !draft.trim()}>Preguntar</button>
          </form>
        </section>
      )}
      <button className={`advisor-fab${open ? " is-open" : ""}`} onClick={() => setOpen((o) => !o)}
        aria-expanded={open} aria-label={open ? "Cerrar asesor" : "Abrir El Consejero"} title="El Consejero">
        {open ? <IconX /> : <IconAdvisor />}
      </button>
    </>
  );
}
