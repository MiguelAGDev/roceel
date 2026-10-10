import os

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://inv:inv@localhost:5432/inventory")

# Desde tu máquina el broker está en localhost:19092; desde un contenedor, en redpanda:9092.
KAFKA_BROKERS = os.environ.get("KAFKA_BROKERS", "localhost:19092")
# Cambiar el grupo hace que el consumidor relea todo desde el inicio.
KAFKA_GROUP_ID = os.environ.get("KAFKA_GROUP_ID", "inventory-service")
TOPICS_IN = os.environ.get(
    "TOPICS_IN", "shop.catalog,shop.work_orders,shop.inspections,shop.purchasing"
).split(",")
