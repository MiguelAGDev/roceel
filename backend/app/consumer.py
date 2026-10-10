"""Consumidor de Kafka. Paso 1: solo lee de Redpanda e imprime cada evento.

    python -m app.consumer
"""
import json

from confluent_kafka import Consumer, KafkaError

from .config import KAFKA_BROKERS, KAFKA_GROUP_ID, TOPICS_IN


def main() -> None:
    consumer = Consumer({
        "bootstrap.servers": KAFKA_BROKERS,
        "group.id": KAFKA_GROUP_ID,
        "auto.offset.reset": "earliest",  # un grupo nuevo empieza por el primer mensaje
        "enable.auto.commit": False,      # todavía no procesamos nada: no avanzamos el offset
    })
    consumer.subscribe(TOPICS_IN)
    print(f"Leyendo {TOPICS_IN} de {KAFKA_BROKERS} (grupo {KAFKA_GROUP_ID})", flush=True)

    try:
        while True:
            msg = consumer.poll(1.0)  # espera hasta 1 s por un mensaje
            if msg is None:
                continue
            if msg.error():
                if msg.error().code() != KafkaError._PARTITION_EOF:
                    print("Error de Kafka:", msg.error(), flush=True)
                continue

            event = json.loads(msg.value())
            print(f"{msg.topic()} | {event['key']} | {event['event_type']} | {event['event_id']}", flush=True)
    except KeyboardInterrupt:
        pass
    finally:
        consumer.close()


if __name__ == "__main__":
    main()
