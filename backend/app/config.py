import os

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://inv:inv@localhost:5432/inventory")

# Desde tu máquina el broker está en localhost:19092; desde un contenedor, en redpanda:9092.
KAFKA_BROKERS = os.environ.get("KAFKA_BROKERS", "localhost:19092")
# Cambiar el grupo hace que el consumidor relea todo desde el inicio.
KAFKA_GROUP_ID = os.environ.get("KAFKA_GROUP_ID", "inventory-service")
TOPIC_OUT = os.environ.get("TOPIC_OUT", "inventory.events")
TOPIC_DLQ = os.environ.get("TOPIC_DLQ", "inventory.dlq")
OUTBOX_POLL_MS = int(os.environ.get("OUTBOX_POLL_MS", "200"))

# Cola de pendientes: espera (s) tras cada intento fallido y cuántos intentos se aguantan
# antes de mandar el evento a la DLQ. "missing" = espera algo que no ha llegado; "error" = falla propia.
PENDING_BACKOFF_S = tuple(int(x) for x in os.environ.get("PENDING_BACKOFF_S", "1,2,4,8,10").split(","))
PENDING_MAX_ATTEMPTS_MISSING = int(os.environ.get("PENDING_MAX_ATTEMPTS_MISSING", "70"))  # ~10 minutos
PENDING_MAX_ATTEMPTS_ERROR = int(os.environ.get("PENDING_MAX_ATTEMPTS_ERROR", "3"))
TOPICS_IN = os.environ.get(
    "TOPICS_IN", "shop.catalog,shop.work_orders,shop.inspections,shop.purchasing"
).split(",")
