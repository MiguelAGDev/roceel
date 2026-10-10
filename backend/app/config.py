import os

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://inv:inv@localhost:5432/inventory")
