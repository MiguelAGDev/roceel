"""Operaciones del libro mayor que comparten el consumidor (handlers) y la API (repo).

Todas se llaman dentro de una transacción abierta por quien las usa."""
from decimal import Decimal

from .domain import ISO_UTC, key_for_part
from .outbox import emit
from .reservations import fill_shortages, refresh_reorder


def lock_part(conn, part_id: int) -> None:
    """Candado por pieza hasta el fin de la transacción: dos procesos no pueden tocar su saldo a la vez."""
    conn.execute("SELECT pg_advisory_xact_lock(%s::bigint)", (part_id,))


def on_hand_at(conn, part_id: int, location_id: int) -> int:
    return conn.execute(
        "SELECT COALESCE(SUM(qty), 0)::int FROM movements WHERE part_id = %s AND location_id = %s",
        (part_id, location_id),
    ).fetchone()[0]


def add_movement(conn, movement_type: str, part_id: int, location_id: int, qty: int, at, *,
                 group_id=None, work_order_id=None, purchase_line_id=None, reservation_id=None,
                 reason=None, actor=None, unit_cost=None, currency=None, source_event_id=None,
                 reference=None) -> dict:
    """Inserta un movimiento (qty con signo) y devuelve su forma de API (`Movement` del contrato).
    `reference` solo se devuelve; no se guarda (se calcula al leer el kardex)."""
    movement_id, occurred = conn.execute(
        f"""INSERT INTO movements (movement_type, part_id, location_id, qty, unit_cost, currency, work_order_id,
                                   purchase_line_id, reservation_id, reason, actor, source_event_id, occurred_at, group_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, COALESCE(%s::uuid, gen_random_uuid()))
            RETURNING movement_id, to_char(occurred_at AT TIME ZONE 'UTC', {ISO_UTC})""",
        (movement_type, part_id, location_id, qty, unit_cost, currency, work_order_id, purchase_line_id,
         reservation_id, reason, actor, source_event_id, at, group_id),
    ).fetchone()
    return {"movement_id": movement_id, "type": movement_type, "part_id": part_id, "location_id": location_id,
            "quantity": qty, "occurred_at": occurred, "reference": reference}


def post_receipt(conn, *, line_id: int, part_id: int, location_id: int, quantity: int, unit_cost: str,
                 currency: str, work_order_code, received_at, source_event_id=None) -> dict:
    """Da entrada a una compra relacionada con una pieza: movimiento, `stock.received`, surte los
    faltantes (primero los de la orden de la compra) y revisa la sugerencia de compra.
    Lo usan la compra que coincide con el catálogo y la recepción resuelta a mano."""
    lock_part(conn, part_id)
    movement = add_movement(conn, "receipt", part_id, location_id, quantity, received_at,
                            unit_cost=Decimal(unit_cost), currency=currency, purchase_line_id=line_id,
                            source_event_id=source_event_id, reference=str(line_id))
    emit(conn, "stock.received", key_for_part(part_id), {
        "part_id": part_id, "location_id": location_id, "quantity": quantity,
        "unit_cost": unit_cost, "currency": currency, "purchase_line_id": line_id,
    }, received_at)
    fill_shortages(conn, part_id, work_order_code, received_at)
    refresh_reorder(conn, part_id, received_at)
    return movement
