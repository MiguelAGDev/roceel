"""Consumidor de Kafka.

Por cada mensaje: abre una transacción, marca el event_id como procesado (si ya lo estaba,
es un duplicado y se ignora) y aplica el manejador del tipo de evento. Solo después del
commit de Postgres se confirma el offset en Kafka.

    python -m app.consumer
"""
import json
import os
import threading
import time
from collections import Counter

from confluent_kafka import Consumer, KafkaError

from . import db
from .config import KAFKA_BROKERS, KAFKA_GROUP_ID, TOPICS_IN
from .handlers import HANDLERS
from .outbox import run_publisher

# 0 = corre para siempre. Con un número, termina tras ese tiempo sin mensajes (útil en pruebas).
EXIT_WHEN_IDLE_SECONDS = float(os.environ.get("EXIT_WHEN_IDLE_SECONDS", "0"))


def process(env: dict, topic: str) -> str:
    """Procesa un evento en una sola transacción. Devuelve 'procesado' o 'duplicado'."""
    with db.tx() as conn:
        fresh = conn.execute(
            """INSERT INTO processed_events (event_id, event_type, topic)
               VALUES (%s, %s, %s) ON CONFLICT DO NOTHING RETURNING event_id""",
            (env["event_id"], env["event_type"], topic),
        ).fetchone()
        if fresh is None:
            return "duplicado"
        HANDLERS[env["event_type"]](conn, env)
    return "procesado"


def main() -> None:
    db.pool.open(wait=True)
    consumer = Consumer({
        "bootstrap.servers": KAFKA_BROKERS,
        "group.id": KAFKA_GROUP_ID,
        "auto.offset.reset": "earliest",  # un grupo nuevo empieza por el primer mensaje
        "enable.auto.commit": False,      # el offset se confirma a mano, después del commit de Postgres
    })
    consumer.subscribe(TOPICS_IN)
    print(f"Leyendo {TOPICS_IN} de {KAFKA_BROKERS} (grupo {KAFKA_GROUP_ID})", flush=True)

    # El publicador del outbox corre en un hilo aparte, a su ritmo.
    stop_publisher = threading.Event()
    publisher = threading.Thread(target=run_publisher, args=(stop_publisher,), daemon=True)
    publisher.start()

    stats = Counter()
    last_message = time.monotonic()
    try:
        while True:
            msg = consumer.poll(1.0)  # espera hasta 1 s por un mensaje
            if msg is None:
                if EXIT_WHEN_IDLE_SECONDS and time.monotonic() - last_message > EXIT_WHEN_IDLE_SECONDS:
                    break
                continue
            if msg.error():
                if msg.error().code() != KafkaError._PARTITION_EOF:
                    print("Error de Kafka:", msg.error(), flush=True)
                continue
            last_message = time.monotonic()

            env = json.loads(msg.value())
            if env["event_type"] not in HANDLERS:
                stats["sin manejador"] += 1  # todavía no implementado: se omite
            else:
                try:
                    stats[process(env, msg.topic())] += 1
                except Exception as exc:
                    # Sin DLQ todavía: se registra y NO se confirma el offset de este mensaje.
                    stats["error"] += 1
                    print(f"ERROR {env['event_type']} {env['event_id']}: {exc}", flush=True)
                    continue
            consumer.commit(message=msg, asynchronous=False)  # después del commit de Postgres
    except KeyboardInterrupt:
        pass
    finally:
        consumer.close()
        stop_publisher.set()
        publisher.join()  # termina de publicar lo pendiente
        db.pool.close()
        print("Resumen:", dict(stats), flush=True)


if __name__ == "__main__":
    main()
