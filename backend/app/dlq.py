"""Cola de eventos muertos (`inventory.dlq`, contrato regla 21).

Aquí cae lo que no se pudo procesar: mensajes ilegibles y eventos que agotaron sus intentos
en la cola de pendientes. Se publica el evento original tal cual y con la misma llave; el
motivo y el tópico de origen viajan en headers, para no alterar el cuerpo."""
import json

from confluent_kafka import Producer

from . import db
from .config import KAFKA_BROKERS, TOPIC_DLQ


def make_producer() -> Producer:
    return Producer({"bootstrap.servers": KAFKA_BROKERS, "enable.idempotence": True})


def send(producer: Producer, source_topic: str, key, value: bytes, reason: str) -> None:
    """Publica en la DLQ y espera la confirmación de Kafka. Lanza si no se confirmó."""
    failed = []

    def confirm(err, _msg):
        if err is not None:
            failed.append(err)

    producer.produce(
        TOPIC_DLQ, key=key, value=value, on_delivery=confirm,
        headers=[("dlq-reason", reason[:500].encode()), ("dlq-source-topic", source_topic.encode())],
    )
    if producer.flush(15) > 0 or failed:
        raise RuntimeError(f"no se confirmó la publicación en {TOPIC_DLQ}: {failed or 'tiempo agotado'}")


def drain_exhausted(producer: Producer) -> int:
    """Manda a la DLQ los pendientes que agotaron sus intentos y los quita de la cola. Si el
    proceso muere entre publicar y borrar, el evento puede quedar duplicado en la DLQ (la
    entrega es 'al menos una vez'). Devuelve cuántos mandó."""
    sent = 0
    while True:
        with db.tx() as conn:
            row = conn.execute(
                """SELECT id, topic, envelope, reason FROM pending_events
                    WHERE next_retry_at = 'infinity' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED"""
            ).fetchone()
            if row is None:
                return sent
            pid, topic, env, reason = row
            send(producer, topic, env.get("key"), json.dumps(env, ensure_ascii=False).encode(), reason)
            conn.execute("DELETE FROM pending_events WHERE id = %s", (pid,))
            sent += 1
