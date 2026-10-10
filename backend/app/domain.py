"""Constantes del contrato que se usan en varios lugares."""

RECEIVING_LOCATION_ID = 100  # U-100: las compras de reabasto entran aquí (contrato, regla 11)
PART_LOCK_NAMESPACE = 1      # pg_advisory_xact_lock(1, part_id)


class MissingDependency(Exception):
    """El evento referencia algo que todavía no llegó (pieza, orden, línea de BOM...).
    No es un error del evento: se encola y se reintenta cuando llegue lo que falta."""


def key_for_part(part_id: int) -> str:
    return f"part:{part_id}"


def key_for_purchase_line(line_id: int) -> str:
    return f"purchase_line:{line_id}"
