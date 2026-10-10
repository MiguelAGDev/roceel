"""Avisos de salida. Cada cambio escribe su aviso en la tabla outbox, dentro de la misma
transacción; el publicador los manda después a inventory.events."""
import json
import threading

from confluent_kafka import Producer
from psycopg.types.json import Jsonb

from . import db
from .config import KAFKA_BROKERS, OUTBOX_POLL_MS, TOPIC_OUT


def emit(conn, event_type: str, key: str, data: dict, occurred_at: str) -> None:
    conn.execute(
        "INSERT INTO outbox (event_type, key, data, occurred_at) VALUES (%s, %s, %s, %s)",
        (event_type, key, Jsonb(data), occurred_at),
    )


def publish_batch(producer: Producer, limit: int = 200) -> int:
    """Publica hasta `limit` avisos pendientes, en orden. Solo marca como publicados los que
    Kafka confirmó. Devuelve cuántos publicó."""
    with db.tx() as conn:
        rows = conn.execute(
            """SELECT id, event_id, event_type, key, data,
                      to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                 FROM outbox WHERE published_at IS NULL
                ORDER BY id LIMIT %s FOR UPDATE SKIP LOCKED""",
            (limit,),
        ).fetchall()
        if not rows:
            return 0

        delivered: list[int] = []

        for row_id, event_id, event_type, key, data, occurred_at in rows:
            envelope = {
                "event_id": str(event_id), "event_type": event_type, "event_version": 1,
                "occurred_at": occurred_at, "source": "inventory", "key": key, "data": data,
            }

            def confirm(err, msg, row_id=row_id):
                if err is None:
                    delivered.append(row_id)

            producer.produce(TOPIC_OUT, key=key, value=json.dumps(envelope), on_delivery=confirm)
        producer.flush(15)  # espera las confirmaciones de Kafka

        if delivered:
            conn.execute("UPDATE outbox SET published_at = now() WHERE id = ANY(%s)", (delivered,))
        return len(delivered)


def run_publisher(stop: threading.Event) -> None:
    """Bucle del publicador. Al recibir `stop`, publica lo que quede pendiente y termina."""
    producer = Producer({"bootstrap.servers": KAFKA_BROKERS, "enable.idempotence": True})
    while True:
        try:
            published = publish_batch(producer)
        except Exception as exc:
            print(f"ERROR publicando el outbox: {exc}", flush=True)
            published = 0
        if published:
            continue  # puede haber más pendientes
        if stop.is_set():
            break
        stop.wait(OUTBOX_POLL_MS / 1000)
    producer.flush(15)
