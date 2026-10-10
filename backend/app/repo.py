"""Acceso a datos. PLACEHOLDER: cada función devuelve datos de ejemplo con la forma exacta
de kit/contract/openapi.yaml. Se reemplaza el cuerpo por la consulta real a Postgres
(ver db/schema.sql); las rutas de main.py no cambian."""

NOW = "2026-10-10T12:00:00Z"


def get_availability(part_id: int):
    return {
        "part_id": part_id, "on_hand": 4, "reserved": 1, "available": 3,
        "locations": [{"location_id": 100, "code": "U-100", "on_hand": 4, "reserved": 0, "available": 4}],
    }


def get_ledger(part_id: int):
    return {"part_id": part_id, "entries": [{
        "movement_id": 1, "type": "receipt", "part_id": part_id, "location_id": 100,
        "quantity": 4, "occurred_at": NOW, "reference": "2044", "balance": 4,
    }]}


def get_materials(code: str):
    return {"work_order_id": 1203, "code": code, "lines": [{
        "inspection_item_id": 9001, "bom_line_id": 77, "part_id": 305, "name": "RODAMIENTO DELANTERO",
        "required": 2, "reserved": 1, "issued": 0, "missing": 1,
    }]}


def list_shortages(work_order_code: str | None, part_id: int | None):
    return {"items": [{
        "work_order_id": 1203, "work_order_code": "R061026012", "part_id": 305,
        "name": "RODAMIENTO DELANTERO", "missing_quantity": 1, "inspection_item_id": 9001, "opened_at": NOW,
    }]}


def list_reorder_suggestions():
    return {"items": [{
        "part_id": 305, "sku": "7014 CTA/P4", "name": "RODAMIENTO DELANTERO",
        "suggested_quantity": 1, "work_order_ids": [1203],
    }]}


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
