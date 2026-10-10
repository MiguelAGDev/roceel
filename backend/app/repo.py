"""Acceso a datos. Las funciones con consulta real leen de Postgres (ver db/schema.sql).
Las que dicen PLACEHOLDER devuelven datos de ejemplo con la forma exacta de
kit/contract/openapi.yaml; se reemplazan una por una. Las rutas de main.py no cambian."""
from . import db

NOW = "2026-10-10T12:00:00Z"
# Todas las fechas de la API salen con el mismo formato (UTC, a segundos), para que ordenarlas
# como texto dé el mismo orden que como fecha.
ISO_UTC = """'YYYY-MM-DD"T"HH24:MI:SS"Z"'"""


def get_availability(part_id: int):
    """Saldo de una pieza, total y por ubicación. None si la pieza no existe."""
    with db.tx() as conn:
        total = conn.execute(
            "SELECT on_hand, reserved, available FROM part_availability WHERE part_id = %s", (part_id,)
        ).fetchone()
        if total is None:
            return None
        locations = conn.execute(
            """SELECT s.location_id, l.code, s.on_hand
                 FROM stock_on_hand s JOIN locations l USING (location_id)
                WHERE s.part_id = %s ORDER BY s.location_id""",
            (part_id,),
        ).fetchall()
    return {
        "part_id": part_id, "on_hand": total[0], "reserved": total[1], "available": total[2],
        # Las reservas son por pieza, no por ubicación: por ubicación reserved va en 0.
        "locations": [{"location_id": lid, "code": code, "on_hand": oh, "reserved": 0, "available": oh}
                      for lid, code, oh in locations],
    }


def get_ledger(part_id: int):
    """Kardex: movimientos del más reciente al más antiguo, con saldo corrido. None si no existe."""
    with db.tx() as conn:
        if conn.execute("SELECT 1 FROM parts WHERE part_id = %s", (part_id,)).fetchone() is None:
            return None
        rows = conn.execute(
            f"""SELECT movement_id, movement_type::text, part_id, location_id, qty,
                       to_char(occurred_at AT TIME ZONE 'UTC', {ISO_UTC}),
                       CASE movement_type
                         WHEN 'receipt' THEN purchase_line_id::text
                         WHEN 'issue' THEN (SELECT code FROM work_orders w WHERE w.work_order_id = l.work_order_id)
                         WHEN 'adjustment' THEN reason
                       END,
                       running_balance
                  FROM part_ledger l WHERE part_id = %s ORDER BY occurred_at DESC, movement_id DESC""",
            (part_id,),
        ).fetchall()
    return {"part_id": part_id, "entries": [
        {"movement_id": r[0], "type": r[1], "part_id": r[2], "location_id": r[3], "quantity": r[4],
         "occurred_at": r[5], "reference": r[6], "balance": r[7]} for r in rows]}


def get_materials(code: str):
    """Materiales de una orden: una línea por necesidad vigente. None si la orden no existe."""
    with db.tx() as conn:
        order = conn.execute("SELECT work_order_id FROM work_orders WHERE code = %s", (code,)).fetchone()
        if order is None:
            return None
        rows = conn.execute(
            """SELECT inspection_item_id, bom_line_id, part_id, name, required, reserved, issued, missing
                 FROM work_order_materials WHERE work_order_id = %s ORDER BY bom_line_id""",
            (order[0],),
        ).fetchall()
    return {"work_order_id": order[0], "code": code, "lines": [
        {"inspection_item_id": r[0], "bom_line_id": r[1], "part_id": r[2], "name": r[3],
         "required": r[4], "reserved": r[5], "issued": r[6], "missing": r[7]} for r in rows]}


def list_shortages(work_order_code: str | None, part_id: int | None):
    """Faltantes abiertos, del más antiguo al más nuevo. `missing_quantity` es lo que aún falta."""
    with db.tx() as conn:
        rows = conn.execute(
            f"""SELECT s.work_order_id, w.code, s.part_id, s.name,
                       s.missing_quantity - s.resolved_quantity, s.inspection_item_id,
                       to_char(s.opened_at AT TIME ZONE 'UTC', {ISO_UTC})
                  FROM shortages s JOIN work_orders w USING (work_order_id)
                 WHERE s.status = 'open'
                   AND (%s::text IS NULL OR w.code = %s) AND (%s::bigint IS NULL OR s.part_id = %s)
                 ORDER BY s.opened_at, s.shortage_id""",
            (work_order_code, work_order_code, part_id, part_id),
        ).fetchall()
    return {"items": [
        {"work_order_id": r[0], "work_order_code": r[1], "part_id": r[2], "name": r[3],
         "missing_quantity": r[4], "inspection_item_id": r[5], "opened_at": r[6]} for r in rows]}


def list_reorder_suggestions():
    with db.tx() as conn:
        rows = conn.execute(
            """SELECT rs.part_id, p.sku, p.name, rs.suggested_quantity, rs.work_order_ids
                 FROM reorder_suggestions rs JOIN parts p USING (part_id)
                WHERE rs.status = 'open' ORDER BY rs.part_id"""
        ).fetchall()
    return {"items": [{"part_id": r[0], "sku": r[1], "name": r[2], "suggested_quantity": r[3],
                       "work_order_ids": r[4]} for r in rows]}


def list_unmatched_receipts():
    return {"items": [{
        "id": 540, "purchase_line_id": 540, "part_number": "PROV-123", "description": "Rodamiento",
        "quantity": 4, "unit_price": "1850.00", "currency": "MXN", "received_at": NOW, "work_order_code": None,
    }]}


def resolve_receipt(receipt_id: str, part_id: int, location_id: int | None):
    return _movement("receipt", part_id, location_id or 100, 4)


def issue(work_order_code: str, part_id: int, location_id: int, quantity: int, issued_by):
    return _movement("issue", part_id, location_id, -quantity, work_order_code)


def transfer(part_id: int, from_location_id: int, to_location_id: int, quantity: int):
    return _movement("transfer_out", part_id, from_location_id, -quantity)


def count(location_id: int, reason: str, lines):
    return {"adjustments": []}


def _movement(type_: str, part_id: int, location_id: int, quantity: int, reference: str | None = None):
    return {
        "movement_id": 1, "type": type_, "part_id": part_id, "location_id": location_id,
        "quantity": quantity, "occurred_at": NOW, "reference": reference,
    }
