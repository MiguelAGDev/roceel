// Asesor "El Consejero": conversación con Gemini (POST /advisor) que explica los números y aconseja
// decisiones. Solo lee; el backend le pasa los datos de ahora en cada pregunta. Con ?pieza= u ?orden= la
// conversación es sobre esa pieza u orden.
import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError, errorMessage, useApi, type AdvisorTurn } from "../api";
import { ErrorBox, PartTag, Tag } from "../components/ui";

const GENERAL = [
  "¿Qué compro primero y por qué?",
  "¿Qué inventario es capital muerto?",
  "Si no alcanza, ¿qué orden sacrifico?",
  "¿Cómo viene la demanda?",
];
const FOR_PART = ["¿Cuánto pido de esta pieza?", "Explícame su kardex", "¿Qué orden debe llevarse esta pieza?"];
const FOR_ORDER = ["¿Por qué le falta material a esta orden?", "¿Qué hago para terminar esta orden?"];

/** El modelo puede marcar **negritas**; es el único formato que se pinta (el resto queda en texto plano). */
function Rich({ text }: { text: string }) {
  return <>{text.split(/\*\*(.+?)\*\*/g).map((chunk, i) => (i % 2 ? <strong key={i}>{chunk}</strong> : <Fragment key={i}>{chunk}</Fragment>))}</>;
}

export default function Asesor() {
  const [params] = useSearchParams();
  const pieza = Number(params.get("pieza"));
  const partId = Number.isInteger(pieza) && pieza > 0 ? pieza : undefined;
  const orden = params.get("orden")?.trim() || undefined;
  const part = useApi((s) => (partId ? api.part(partId, s) : Promise.resolve(undefined)), [partId]);

  const [turns, setTurns] = useState<AdvisorTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<ApiError>();
  const sendingRef = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);

  // Otra pieza u orden es otra conversación.
  useEffect(() => { setTurns([]); setError(undefined); }, [partId, orden]);
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }); }, [turns, sending]);

  async function ask(question: string) {
    const q = question.trim();
    if (!q || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError(undefined);
    setDraft("");
    const history = turns;
    setTurns([...history, { role: "user", text: q }]);
    try {
      const res = await api.advisor({ question: q, history, part_id: partId, work_order_code: orden });
      setTurns([...history, { role: "user", text: q }, { role: "model", text: res.answer }]);
    } catch (err) {
      // Sin respuesta, la pregunta vuelve al campo para reintentar y no queda en el historial.
      setTurns(history);
      setDraft(q);
      setError(err instanceof ApiError ? err : new ApiError(0, String(err)));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void ask(draft);
  }

  const suggestions = [...(partId ? FOR_PART : []), ...(orden ? FOR_ORDER : []), ...GENERAL];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>El Consejero</h1>
          <p className="muted">Asesor con IA: explica los números del almacén y aconseja. No ejecuta nada; la decisión es tuya.</p>
          {(partId || orden) && (
            <div className="row" style={{ marginTop: 8 }}>
              <span className="muted">Sobre</span>
              {partId && (part.data ? <PartTag part={part.data} /> : <Tag>Pieza {partId}</Tag>)}
              {part.data && <span>{part.data.name}</span>}
              {orden && <Tag to={`/ordenes/${encodeURIComponent(orden)}`}>{orden}</Tag>}
            </div>
          )}
        </div>
        {turns.length > 0 && (
          <button className="btn" onClick={() => { setTurns([]); setError(undefined); }} disabled={sending}>Nueva conversación</button>
        )}
      </div>

      <div className="panel advisor">
        <div className="advisor-log" aria-live="polite">
          {turns.length === 0 && !sending && (
            <p className="muted advisor-hint">Pregunta lo que quieras o elige una de abajo. Cada respuesta usa los datos de este momento.</p>
          )}
          {turns.map((t, i) => (
            <div key={i} className={`advisor-msg ${t.role}`}>
              <span className="advisor-who">{t.role === "user" ? "Tú" : "El Consejero"}</span>
              <div className="advisor-text"><Rich text={t.text} /></div>
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

        {error && <div className="panel-pad"><ErrorBox error={new ApiError(error.status, errorMessage(error, "advisor"))} /></div>}

        <div className="advisor-chips" aria-label="Preguntas sugeridas">
          {suggestions.map((s) => (
            <button key={s} type="button" className="chip" onClick={() => void ask(s)} disabled={sending}>{s}</button>
          ))}
        </div>

        <form className="advisor-form" onSubmit={submit}>
          <textarea className="input" rows={2} maxLength={1000} placeholder="Escribe tu pregunta…" aria-label="Tu pregunta"
            value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(draft); } }} />
          <button className="btn btn-primary" type="submit" disabled={sending || !draft.trim()}>Preguntar</button>
        </form>
      </div>
    </>
  );
}
