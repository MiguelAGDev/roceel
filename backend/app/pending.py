"""Cola de eventos pendientes (contrato, regla 20).

Un evento que referencia algo que todavía no llegó no se descarta ni detiene el consumo: se
guarda en `pending_events` y se reintenta. Reglas:

- Los eventos de una misma llave dentro de un mismo tópico se aplican en orden. Si hay uno
  pendiente, los que lleguen después con esa (tópico, llave) esperan detrás de él.
- Cuando llega algo de lo que otros dependen (pieza, ubicación, BOM, orden) se adelanta el
  reintento de los que esperaban (`wake`), sin esperar al tiempo de espera.
- El motivo (`reason`) empieza con `missing:` si falta algo por llegar, o `error:` si el
  evento falló por otra causa. Los `missing` se esperan mucho; los `error` se rinden pronto.
- Cuando se agotan los intentos el evento queda con `next_retry_at = infinity`, a la espera
  de mandarse a la DLQ.
"""
from collections import Counter

from psycopg import errors as pg_errors
from psycopg.types.json import Jsonb

from . import db
from .domain import MissingDependency
from .handlers import HANDLERS

BACKOFF_S = (1, 2, 4, 8, 10)   # espera tras el intento n; después se queda en 10 s
MAX_ATTEMPTS_MISSING = 70      # ~10 minutos esperando a que llegue lo que falta
MAX_ATTEMPTS_ERROR = 3         # un error del propio evento se rinde pronto

# Al procesar uno de estos, los que esperaban algo se reintentan de inmediato.
WAKE_TYPES = {"part.upserted", "location.upserted", "bom.upserted", "work_order.opened"}


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


def wake(conn) -> None:
    """Adelanta el reintento de los eventos que esperan algo por llegar."""
    conn.execute(
        """UPDATE pending_events SET next_retry_at = now()
            WHERE reason LIKE 'missing:%' AND next_retry_at > now() AND next_retry_at < 'infinity'"""
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
            wake(conn)
        return result


_NEXT_DUE = """
    SELECT p.id, p.topic, p.envelope, p.attempts
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
            pid, topic, env, attempts = row
            try:
                with conn.transaction():
                    result = apply_event(conn, env, topic)
            except Exception as exc:
                reason = _reason(exc)
                attempts += 1
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
                wake(conn)
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
