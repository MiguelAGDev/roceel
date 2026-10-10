from contextlib import contextmanager

from psycopg_pool import ConnectionPool

from .config import DATABASE_URL

# open=False: la API arranca aunque Postgres todavía no esté listo.
pool = ConnectionPool(DATABASE_URL, min_size=1, max_size=10, open=False)


@contextmanager
def tx():
    """Una transacción: hace commit al salir y rollback si algo falla."""
    with pool.connection() as conn:
        yield conn


def ping() -> bool:
    try:
        with tx() as conn:
            conn.execute("SELECT 1")
        return True
    except Exception:
        return False
