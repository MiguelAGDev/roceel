"""Constantes del contrato que se usan en varios lugares."""

RECEIVING_LOCATION_ID = 100  # U-100: las compras de reabasto entran aquí (contrato, regla 11)

# Todas las fechas de la API salen con el mismo formato (UTC, a segundos), para que ordenarlas
# como texto dé el mismo orden que como fecha.
ISO_UTC = """'YYYY-MM-DD"T"HH24:MI:SS"Z"'"""


class NotFound(Exception):
    """La pieza, ubicación, orden o recepción pedida no existe (la API responde 404)."""


class Conflict(Exception):
    """La operación choca con el estado actual: saldo insuficiente, ya resuelta... (409)."""


class MissingDependency(Exception):
    """El evento referencia algo que todavía no llegó (pieza, orden, línea de BOM...).
    No es un error del evento: se encola y se reintenta cuando llegue lo que falta."""


def key_for_part(part_id: int) -> str:
    return f"part:{part_id}"


def key_for_purchase_line(line_id: int) -> str:
    return f"purchase_line:{line_id}"
