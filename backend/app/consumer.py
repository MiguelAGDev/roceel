"""Consumidor de Kafka.

Por cada mensaje: lo valida, y `pending.submit` lo aplica en una transacción de Postgres
(marca el event_id como procesado, o lo ignora si ya lo estaba). Si el evento espera algo que
aún no llega, o falla por sí mismo, queda en la cola de pendientes y se reintenta; si agota
sus intentos o es ilegible, va a la DLQ. Solo después de eso se confirma el offset en Kafka,
así que ningún evento se pierde ni detiene el consumo.

    python -m app.consumer
"""
import json
import os
import threading
import time
import uuid
from collections import Counter

from confluent_kafka import Consumer, KafkaError, TopicPartition

from . import db, dlq, pending
from .config import KAFKA_BROKERS, KAFKA_GROUP_ID, TOPICS_IN
from .handlers import HANDLERS
from .outbox import run_publisher

# 0 = corre para siempre. Con un número, termina tras ese tiempo sin mensajes (útil en pruebas).
EXIT_WHEN_IDLE_SECONDS = float(os.environ.get("EXIT_WHEN_IDLE_SECONDS", "0"))
RETRY_EVERY_S = 0.5  # cada cuánto se revisan los pendientes que ya les toca


def validate(raw: bytes | None) -> tuple[dict | None, str | None]:
    """Devuelve (sobre, None) si el mensaje se puede procesar, o (None, motivo) si es ilegible."""
    if not raw:
        return None, "malformed: mensaje vacío"
    try:
        env = json.loads(raw)
    except ValueError:
        return None, "malformed: no es JSON"
    if not isinstance(env, dict):
        return None, "malformed: el mensaje no es un objeto"
    for field in ("event_id", "event_type", "key", "occurred_at"):
        if not isinstance(env.get(field), str) or not env[field]:
            return None, f"malformed: falta '{field}'"
    if not isinstance(env.get("data"), dict):
        return None, "malformed: falta 'data'"
    try:
        uuid.UUID(env["event_id"])
    except ValueError:
        return None, "malformed: event_id no es un UUID"
    return env, None


def handle(msg, producer, stats: Counter) -> str:
    """Procesa un mensaje. Devuelve el resultado; al volver, el offset ya se puede confirmar.
    Lanza solo por fallas de infraestructura (Postgres o Kafka caídos): en ese caso el
    mensaje NO se confirma y se vuelve a intentar."""
    env, problem = validate(msg.value())
    if problem:
        dlq.send(producer, msg.topic(), msg.key(), msg.value() or b"", problem)
        stats["dlq"] += 1
        return "dlq"
    if env["event_type"] not in HANDLERS:
        stats["sin manejador"] += 1  # todavía no implementado: se omite
        return "sin manejador"
    result = pending.submit(env, msg.topic())
    stats[result] += 1
    if result == "procesado" and env["event_type"] in pending.WAKE_TYPES:
        return "despertar"  # llegó algo que otros esperaban: reintentar ya
    return result


def tick(producer, stats: Counter) -> None:
    """Reintenta los pendientes que ya les toca y manda los agotados a la DLQ."""
    for result, n in pending.retry_due().items():
        stats[f"reintento {result}"] += n
    sent = dlq.drain_exhausted(producer)
    if sent:
        stats["dlq"] += sent


def main() -> None:
    db.pool.open(wait=True)
    consumer = Consumer({
        "bootstrap.servers": KAFKA_BROKERS,
        "group.id": KAFKA_GROUP_ID,
        "auto.offset.reset": "earliest",  # un grupo nuevo empieza por el primer mensaje
        "enable.auto.commit": False,      # el offset se confirma a mano, después del commit de Postgres
    })
    consumer.subscribe(TOPICS_IN)
    producer = dlq.make_producer()
    print(f"Leyendo {TOPICS_IN} de {KAFKA_BROKERS} (grupo {KAFKA_GROUP_ID})", flush=True)

    # El publicador del outbox corre en un hilo aparte, a su ritmo.
    stop_publisher = threading.Event()
    publisher = threading.Thread(target=run_publisher, args=(stop_publisher,), daemon=True)
    publisher.start()

    stats = Counter()
    last_message = last_tick = time.monotonic()
    retry_now = False
    try:
        while True:
            msg = consumer.poll(1.0)  # espera hasta 1 s por un mensaje

            if retry_now or time.monotonic() - last_tick >= RETRY_EVERY_S:
                try:
                    tick(producer, stats)
                except Exception as exc:  # Postgres o Kafka caídos: se vuelve a intentar en el siguiente turno
                    print(f"ERROR reintentando pendientes: {exc}", flush=True)
                retry_now, last_tick = False, time.monotonic()

            if msg is None:
                if EXIT_WHEN_IDLE_SECONDS and time.monotonic() - last_message > EXIT_WHEN_IDLE_SECONDS:
                    break
                continue
            if msg.error():
                if msg.error().code() != KafkaError._PARTITION_EOF:
                    print("Error de Kafka:", msg.error(), flush=True)
                continue
            last_message = time.monotonic()

            try:
                retry_now = handle(msg, producer, stats) == "despertar"
            except Exception as exc:
                # Falla de infraestructura: no se confirma y se vuelve a este mismo mensaje.
                # (Sin el seek, el siguiente mensaje confirmaría un offset posterior y este se perdería.)
                stats["error"] += 1
                print(f"ERROR {msg.topic()}[{msg.partition()}]@{msg.offset()}: {exc}", flush=True)
                consumer.seek(TopicPartition(msg.topic(), msg.partition(), msg.offset()))
                time.sleep(2)
                continue
            consumer.commit(message=msg, asynchronous=False)  # después del commit de Postgres
    except KeyboardInterrupt:
        pass
    finally:
        consumer.close()
        stop_publisher.set()
        publisher.join()  # termina de publicar lo pendiente
        try:
            stats["en cola"] = pending.count()["esperando"]
        except Exception:
            pass
        db.pool.close()
        print("Resumen:", dict(stats), flush=True)


if __name__ == "__main__":
    main()
