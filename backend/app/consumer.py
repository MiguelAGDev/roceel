"""Consumidor de Kafka.

Por cada mensaje: lo valida, y `pending.submit` lo aplica en una transacción de Postgres
(marca el event_id como procesado, o lo ignora si ya lo estaba). Si el evento espera algo que
aún no llega, o falla por sí mismo, queda en la cola de pendientes y se reintenta; si agota
sus intentos o es ilegible, va a la DLQ. Solo después de eso se confirma el offset en Kafka,
así que ningún evento se pierde ni detiene el consumo.

Al arrancar:
- Si la base está vacía (primera vez, o la borraron para reconstruir), se relee TODO desde el
  inicio de los tópicos, aunque el grupo ya hubiera avanzado (contrato, regla 23).
- `shop.catalog` se lee completo ANTES que los demás tópicos (regla 22): así las compras se
  relacionan con el catálogo ya completo y no con uno a medias.

    python -m app.consumer
"""
import json
import os
import threading
import time
import uuid
from collections import Counter

from confluent_kafka import OFFSET_BEGINNING, Consumer, KafkaError, TopicPartition

from . import db, dlq, pending
from .config import CATALOG_IDLE_SECONDS, KAFKA_BROKERS, KAFKA_GROUP_ID, TOPIC_CATALOG, TOPICS_IN
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
        stats["sin manejador"] += 1  # tipo desconocido: se omite
        return "sin manejador"
    result = pending.submit(env, msg.topic())
    stats[result] += 1
    if result == "procesado" and env["event_type"] in pending.WAKE_TYPES:
        return "despertar"  # llegó algo que otros esperaban: reintentar ya
    return result


def consume_one(consumer, producer, msg, stats: Counter) -> bool | None:
    """Procesa un mensaje y confirma su offset. Devuelve True si hay que reintentar pendientes ya.
    Si falla la infraestructura devuelve None: no se confirma y se vuelve a este mismo mensaje.
    (Sin el seek, el siguiente mensaje confirmaría un offset posterior y este se perdería.)"""
    try:
        wake = handle(msg, producer, stats) == "despertar"
    except Exception as exc:
        stats["error"] += 1
        print(f"ERROR {msg.topic()}[{msg.partition()}]@{msg.offset()}: {exc}", flush=True)
        consumer.seek(TopicPartition(msg.topic(), msg.partition(), msg.offset()))
        time.sleep(2)
        return None
    consumer.commit(message=msg, asynchronous=False)  # después del commit de Postgres
    return wake


def tick(producer, stats: Counter) -> None:
    """Reintenta los pendientes que ya les toca y manda los agotados a la DLQ."""
    for result, n in pending.retry_due().items():
        stats[f"reintento {result}"] += n
    sent = dlq.drain_exhausted(producer)
    if sent:
        stats["dlq"] += sent


def new_consumer() -> Consumer:
    return Consumer({
        "bootstrap.servers": KAFKA_BROKERS,
        "group.id": KAFKA_GROUP_ID,
        "auto.offset.reset": "earliest",  # un grupo nuevo empieza por el primer mensaje
        "enable.auto.commit": False,      # el offset se confirma a mano, después del commit de Postgres
    })


def database_is_empty() -> bool:
    """Base vacía = primera vez o reconstrucción: hay que releer todo desde el inicio."""
    with db.tx() as conn:
        return conn.execute("SELECT NOT EXISTS (SELECT 1 FROM processed_events)").fetchone()[0]


def load_catalog_first(producer, stats: Counter, rebuild: bool) -> None:
    """Lee `shop.catalog` hasta donde llegaba cuando arrancamos, antes de tocar los demás tópicos.
    En un reinicio normal ya está al día y no lee nada; en una reconstrucción lo lee completo."""
    consumer = new_consumer()
    try:
        meta = consumer.list_topics(TOPIC_CATALOG, timeout=10).topics.get(TOPIC_CATALOG)
        if meta is None or meta.error is not None or not meta.partitions:
            print(f"Catálogo: el tópico {TOPIC_CATALOG} aún no existe; se sigue sin esperarlo", flush=True)
            return
        base = [TopicPartition(TOPIC_CATALOG, p) for p in meta.partitions]
        committed = {tp.partition: tp.offset for tp in consumer.committed(base, timeout=10)}
        low_high = {tp.partition: consumer.get_watermark_offsets(tp, timeout=10) for tp in base}
        # Donde empieza cada partición: el inicio si reconstruimos; si no, donde nos quedamos.
        start = {p: (low if rebuild or committed.get(p, -1) < 0 else max(committed[p], low))
                 for p, (low, high) in low_high.items()}
        high = {p: h for p, (low, h) in low_high.items()}
        consumer.assign([TopicPartition(TOPIC_CATALOG, p, start[p]) for p in start])
        pending_parts = {p for p in start if start[p] < high[p]}
        if not pending_parts:
            return
        print(f"Catálogo primero: leyendo {sum(high[p] - start[p] for p in pending_parts)} mensajes de {TOPIC_CATALOG}", flush=True)

        next_offset, last_progress = dict(start), time.monotonic()
        while any(next_offset[p] < high[p] for p in next_offset):
            msg = consumer.poll(1.0)
            if msg is None:
                if time.monotonic() - last_progress > CATALOG_IDLE_SECONDS:
                    print(f"Catálogo: {CATALOG_IDLE_SECONDS:.0f} s sin mensajes nuevos; se da por leído", flush=True)
                    break
                continue
            if msg.error():
                if msg.error().code() != KafkaError._PARTITION_EOF:
                    print("Error de Kafka:", msg.error(), flush=True)
                continue
            last_progress = time.monotonic()
            if consume_one(consumer, producer, msg, stats) is not None:
                next_offset[msg.partition()] = msg.offset() + 1
        print("Catálogo listo; se sigue con los demás tópicos", flush=True)
    finally:
        consumer.close()


def main() -> None:
    db.pool.open(wait=True)
    producer = dlq.make_producer()

    # El publicador del outbox corre en un hilo aparte, a su ritmo.
    stop_publisher = threading.Event()
    publisher = threading.Thread(target=run_publisher, args=(stop_publisher,), daemon=True)
    publisher.start()

    stats = Counter()
    rebuild = database_is_empty()
    if rebuild:
        print("Base vacía: se relee todo desde el inicio de los tópicos", flush=True)
    if TOPIC_CATALOG in TOPICS_IN:
        load_catalog_first(producer, stats, rebuild)

    # Fase 2: todos los tópicos. En una reconstrucción, los que no son el catálogo (ya leído) empiezan
    # de cero aunque el grupo tuviera offsets confirmados de una vida anterior.
    rewind = {"pending": rebuild}

    def on_assign(c, partitions):
        if rewind["pending"]:
            for p in partitions:
                if p.topic != TOPIC_CATALOG:
                    p.offset = OFFSET_BEGINNING
            rewind["pending"] = False
        c.assign(partitions)

    consumer = new_consumer()
    consumer.subscribe(TOPICS_IN, on_assign=on_assign)
    print(f"Leyendo {TOPICS_IN} de {KAFKA_BROKERS} (grupo {KAFKA_GROUP_ID})", flush=True)

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

            wake = consume_one(consumer, producer, msg, stats)
            retry_now = bool(wake)
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
