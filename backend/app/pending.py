"""Cola de eventos pendientes (contrato, regla 20).

Un evento que referencia algo que todavía no llegó no se descarta ni detiene el consumo: se
guarda en `pending_events` y se reintenta. Reglas:

- Los eventos de una misma llave dentro de un mismo tópico se aplican en orden. Si hay uno
  pendiente, los que lleguen después con esa (tópico, llave) esperan detrás de él.
- Cuando llega una pieza, un BOM o una orden se adelanta el reintento de los que esperaban
  justo eso (`wake`), sin esperar al tiempo de espera. Si al reintentar espera otra cosa,
  los intentos se cuentan de nuevo: solo se agota el que sigue atascado en lo mismo.
- El motivo (`reason`) empieza con `missing:` si falta algo por llegar, o `error:` si el
  evento falló por otra causa. Los `missing` se esperan mucho; los `error` se rinden pronto.
- Cuando se agotan los intentos el evento queda con `next_retry_at = infinity`, a la espera
  de mandarse a la DLQ.
"""
from collections import Counter

from psycopg import errors as pg_errors
from psycopg.types.json import Jsonb

from . import db
from .config import PENDING_BACKOFF_S as BACKOFF_S
from .config import PENDING_MAX_ATTEMPTS_ERROR as MAX_ATTEMPTS_ERROR
from .config import PENDING_MAX_ATTEMPTS_MISSING as MAX_ATTEMPTS_MISSING
from .domain import MissingDependency
from .handlers import HANDLERS

# Al procesar uno de estos, los que esperaban justo eso se reintentan de inmediato.
WAKE_TYPES = {"part.upserted", "bom.upserted", "work_order.opened"}


def apply_event(conn, env: dict, topic: str) -> str:
    """Aplica un evento dentro de la transacción abierta. 'procesado' o 'duplicado'."""
    fresh = conn.execute(
        """INSERT INTO processed_events (event_id, event_type, topic)
           VALUES (%s, %s, %s) ON CONFLICT DO NOTHING RETURNING event_id""",
        (env["event_id"], env["event_type"], topic),
    ).fetchone()
    if fresh is None:
        return "duplicado"
    HANDLERS[env["event_type"]](conn, env)
    return "procesado"


def classify(exc: Exception) -> str:
    """'missing' si el evento solo espera algo que falta; 'error' en cualquier otro caso."""
    if isinstance(exc, (MissingDependency, pg_errors.ForeignKeyViolation)):
        return "missing"
    return "error"


def _reason(exc: Exception) -> str:
    return f"{classify(exc)}: {type(exc).__name__}: {exc}"[:500]


def _max_attempts(reason: str) -> int:
    return MAX_ATTEMPTS_MISSING if reason.startswith("missing:") else MAX_ATTEMPTS_ERROR


def _backoff(attempts: int) -> int:
    return BACKOFF_S[min(attempts, len(BACKOFF_S)) - 1]


def _waited_for(env: dict) -> list[str]:
    """Lo que este evento acaba de dar de alta, escrito como lo dicen los `MissingDependency`."""
    d = env["data"]
    if env["event_type"] == "part.upserted":
        return [f"pieza {d['part_id']} no existe"]
    if env["event_type"] == "bom.upserted":
        return [f"línea de BOM {line['bom_line_id']} no existe" for line in d["lines"]]
    if env["event_type"] == "work_order.opened":
        return [f"orden {d['work_order_id']} no existe"]
    return []


def wake(conn, env: dict) -> None:
    """Adelanta el reintento solo de los eventos que esperaban lo que `env` acaba de dar de alta.
    (Despertar a todos gastaba sus intentos en reintentos inútiles.)"""
    waited = _waited_for(env)
    if waited:
        conn.execute(
            """UPDATE pending_events SET next_retry_at = now()
                WHERE reason LIKE ANY(%s) AND next_retry_at > now() AND next_retry_at < 'infinity'""",
            ([f"missing: % {w}" for w in waited],),
        )


def _enqueue(conn, env: dict, topic: str, reason: str, attempts: int) -> None:
    wait = _backoff(attempts) if attempts else 0
    conn.execute(
        """INSERT INTO pending_events (event_id, topic, envelope, reason, attempts, next_retry_at)
           VALUES (%s, %s, %s, %s, %s, now() + make_interval(secs => %s))
           ON CONFLICT (event_id) DO NOTHING""",
        (env["event_id"], topic, Jsonb(env), reason, attempts, wait),
    )


def has_pending_before(conn, topic: str, key: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM pending_events WHERE topic = %s AND envelope->>'key' = %s LIMIT 1", (topic, key)
    ).fetchone() is not None


def submit(env: dict, topic: str) -> str:
    """Punto de entrada de cada mensaje que llega. Devuelve 'procesado', 'duplicado' o 'pendiente'.
    Nunca lanza por culpa del evento: si no se puede aplicar, queda en la cola."""
    with db.tx() as conn:
        queued = conn.execute("SELECT 1 FROM pending_events WHERE event_id = %s", (env["event_id"],)).fetchone()
        if queued:
            return "duplicado"  # ya está en la cola, esperando
        if has_pending_before(conn, topic, env["key"]):
            _enqueue(conn, env, topic, "missing: espera a un evento anterior de la misma llave", 0)
            return "pendiente"
        try:
            with conn.transaction():  # savepoint: si falla, solo se deshace el evento
                result = apply_event(conn, env, topic)
        except Exception as exc:
            _enqueue(conn, env, topic, _reason(exc), 1)
            return "pendiente"
        if result == "procesado" and env["event_type"] in WAKE_TYPES:
            wake(conn, env)
        return result


_NEXT_DUE = """
    SELECT p.id, p.topic, p.envelope, p.attempts, p.reason
      FROM pending_events p
     WHERE p.next_retry_at <= now()
       AND NOT EXISTS (SELECT 1 FROM pending_events o
                        WHERE o.topic = p.topic AND o.envelope->>'key' = p.envelope->>'key' AND o.id < p.id)
     ORDER BY p.id LIMIT 1 FOR UPDATE OF p SKIP LOCKED
"""


def retry_due(limit: int = 200) -> Counter:
    """Reintenta los pendientes que ya les toca, en orden de llegada. Devuelve el conteo por
    resultado: 'procesado', 'duplicado', 'pendiente' (sigue esperando) y 'agotado'."""
    stats: Counter = Counter()
    for _ in range(limit):
        with db.tx() as conn:
            row = conn.execute(_NEXT_DUE).fetchone()
            if row is None:
                break
            pid, topic, env, attempts, old_reason = row
            try:
                with conn.transaction():
                    result = apply_event(conn, env, topic)
            except Exception as exc:
                reason = _reason(exc)
                # Si ahora espera otra cosa, lo anterior ya llegó: hubo avance y se cuenta de nuevo.
                attempts = 1 if reason != old_reason and old_reason.startswith("missing:") else attempts + 1
                if attempts >= _max_attempts(reason):
                    conn.execute("UPDATE pending_events SET reason = %s, attempts = %s, next_retry_at = 'infinity' WHERE id = %s",
                                 (reason, attempts, pid))
                    stats["agotado"] += 1
                else:
                    conn.execute(
                        """UPDATE pending_events SET reason = %s, attempts = %s,
                                  next_retry_at = now() + make_interval(secs => %s) WHERE id = %s""",
                        (reason, attempts, _backoff(attempts), pid))
                    stats["pendiente"] += 1
                continue
            conn.execute("DELETE FROM pending_events WHERE id = %s", (pid,))
            if result == "procesado" and env["event_type"] in WAKE_TYPES:
                wake(conn, env)
            stats[result] += 1
    return stats


def count(conn=None) -> dict:
    """Cuántos hay en la cola: esperando, y agotados (listos para la DLQ)."""
    def run(c):
        r = c.execute(
            """SELECT count(*) FILTER (WHERE next_retry_at < 'infinity'),
                      count(*) FILTER (WHERE next_retry_at = 'infinity') FROM pending_events""").fetchone()
        return {"esperando": r[0], "agotados": r[1]}
    if conn is not None:
        return run(conn)
    with db.tx() as c:
        return run(c)
