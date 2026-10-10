"""Un manejador por tipo de evento. Cada uno recibe la conexión de la transacción abierta
por el consumidor y el sobre completo del evento. Si lanza una excepción, la transacción
se deshace (y el evento tampoco queda marcado como procesado)."""
from decimal import Decimal

from .domain import RECEIVING_LOCATION_ID, MissingDependency, key_for_purchase_line
from .ledger import lock_part, post_receipt
from .outbox import emit
from .reservations import reconcile_need, refresh_reorder


def part_upserted(conn, env):
    d = env["data"]
    unit = d["unit"] or {}
    conn.execute(
        """INSERT INTO parts (part_id, sku, name, family, "group", subgroup,
                              unit_id, unit_name, image_url, active)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
           ON CONFLICT (part_id) DO UPDATE SET
             sku = EXCLUDED.sku, name = EXCLUDED.name, family = EXCLUDED.family,
             "group" = EXCLUDED."group", subgroup = EXCLUDED.subgroup,
             unit_id = EXCLUDED.unit_id, unit_name = EXCLUDED.unit_name,
             image_url = EXCLUDED.image_url, active = EXCLUDED.active""",
        (d["part_id"], d["sku"], d["name"], d["family"], d["group"], d["subgroup"],
         unit.get("id"), unit.get("name"), d["image_url"], d["active"]),
    )


def location_upserted(conn, env):
    d = env["data"]
    conn.execute(
        """INSERT INTO locations (location_id, code, name, is_workbench, active)
           VALUES (%s, %s, %s, %s, %s)
           ON CONFLICT (location_id) DO UPDATE SET
             code = EXCLUDED.code, name = EXCLUDED.name,
             is_workbench = EXCLUDED.is_workbench, active = EXCLUDED.active""",
        (d["location_id"], d["code"], d["name"], d["is_workbench"], d["active"]),
    )


def bom_upserted(conn, env):
    d = env["data"]
    conn.execute(
        """INSERT INTO models (model_id, model_name, brand) VALUES (%s, %s, %s)
           ON CONFLICT (model_id) DO UPDATE SET
             model_name = EXCLUDED.model_name, brand = EXCLUDED.brand""",
        (d["model_id"], d["model_name"], d["brand"]),
    )
    # La lista que llega es la vigente del modelo: se quitan las líneas que ya no vienen.
    line_ids = [line["bom_line_id"] for line in d["lines"]]
    conn.execute(
        "DELETE FROM bom_lines WHERE model_id = %s AND bom_line_id <> ALL(%s::bigint[])",
        (d["model_id"], line_ids),
    )
    with conn.cursor() as cur:
        cur.executemany(
            """INSERT INTO bom_lines (bom_line_id, model_id, part_id, name, group_name,
                                      unit_id, unit_name, qty_per_unit, sort_order)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (bom_line_id) DO UPDATE SET
                 model_id = EXCLUDED.model_id, part_id = EXCLUDED.part_id, name = EXCLUDED.name,
                 group_name = EXCLUDED.group_name, unit_id = EXCLUDED.unit_id,
                 unit_name = EXCLUDED.unit_name, qty_per_unit = EXCLUDED.qty_per_unit,
                 sort_order = EXCLUDED.sort_order""",
            [(line["bom_line_id"], d["model_id"], line["part_id"], line["name"], line["group_name"],
              (line["unit"] or {}).get("id"), (line["unit"] or {}).get("name"),
              line["qty_per_unit"], line["sort_order"]) for line in d["lines"]],
        )


def work_order_opened(conn, env):
    d = env["data"]
    conn.execute(
        """INSERT INTO work_orders (work_order_id, code, model_id, department, received_at)
           VALUES (%s, %s, %s, %s, %s)
           ON CONFLICT (work_order_id) DO UPDATE SET
             code = EXCLUDED.code, model_id = EXCLUDED.model_id,
             department = EXCLUDED.department, received_at = EXCLUDED.received_at""",
        (d["work_order_id"], d["code"], d["model_id"], d["department"], d["received_at"]),
    )


def work_order_stage_changed(conn, env):
    d = env["data"]
    cur = conn.execute(
        "UPDATE work_orders SET stage = %s WHERE work_order_id = %s", (d["to_stage"], d["work_order_id"])
    )
    if cur.rowcount == 0:
        raise MissingDependency(f"orden {d['work_order_id']} no existe")


def purchase_item_received(conn, env):
    d = env["data"]
    line_id = d["line_id"]

    if d["purpose"] == "customer_order":
        status, part_id, reason = "not_inventory", None, None  # material para un cliente: no entra
    else:
        # El número de parte llega como texto libre: se compara contra el sku normalizado.
        matches = [r[0] for r in conn.execute(
            "SELECT part_id FROM parts WHERE sku_norm = normalize_sku(%s)", (d["part_number"],))]
        if len(matches) == 1:
            status, part_id, reason = "matched", matches[0], None
        else:
            status, part_id, reason = "unmatched", None, ("no_match" if not matches else "ambiguous")

    inserted = conn.execute(
        """INSERT INTO purchase_receipts
             (purchase_line_id, purchase_request_id, request_number, part_number, description,
              quantity, unit_price, currency, purpose, work_order_code, received_at,
              match_status, unmatched_reason, part_id)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
           ON CONFLICT (purchase_line_id) DO NOTHING RETURNING purchase_line_id""",
        (line_id, d["purchase_request_id"], d["request_number"], d["part_number"], d["description"],
         d["quantity"], Decimal(d["unit_price"]), d["currency"], d["purpose"], d["work_order_code"],
         d["received_at"], status, reason, part_id),
    ).fetchone()
    if inserted is None:
        return  # esa línea de compra ya se procesó (llegó con otro event_id)

    if status == "matched":
        post_receipt(conn, line_id=line_id, part_id=part_id, location_id=RECEIVING_LOCATION_ID,
                     quantity=d["quantity"], unit_cost=d["unit_price"], currency=d["currency"],
                     work_order_code=d["work_order_code"], received_at=d["received_at"],
                     source_event_id=env["event_id"])
    elif status == "unmatched":
        emit(conn, "stock.unmatched_receipt", key_for_purchase_line(line_id), {
            "purchase_line_id": line_id, "part_number": d["part_number"],
            "description": d["description"], "quantity": d["quantity"],
        }, d["received_at"])


def store_inspection(conn, env, status: str) -> None:
    """Guarda la inspección y sus líneas tal como llegaron (copia cruda)."""
    d = env["data"]
    if conn.execute("SELECT 1 FROM work_orders WHERE work_order_id = %s", (d["work_order_id"],)).fetchone() is None:
        raise MissingDependency(f"orden {d['work_order_id']} no existe")
    conn.execute(
        """INSERT INTO inspections (inspection_id, work_order_id, kind, status, approved_by, approved_at, updated_at)
           VALUES (%s, %s, %s, %s, %s, %s, %s)
           ON CONFLICT (inspection_id) DO UPDATE SET
             status = EXCLUDED.status, approved_by = EXCLUDED.approved_by,
             approved_at = EXCLUDED.approved_at, updated_at = EXCLUDED.updated_at""",
        (d["inspection_id"], d["work_order_id"], d["kind"], status,
         d.get("approved_by"), d.get("approved_at"), env["occurred_at"]),
    )
    with conn.cursor() as cur:
        cur.executemany(
            """INSERT INTO inspection_items (inspection_item_id, inspection_id, bom_line_id, part_id, name,
                                             group_name, condition, action, quantity, note)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (inspection_item_id) DO NOTHING""",
            [(it["inspection_item_id"], d["inspection_id"], it["bom_line_id"], it["part_id"], it["name"],
              it["group_name"], it["condition"], it["action"], it["quantity"], it["note"]) for it in d["items"]],
        )


def inspection_submitted(conn, env):
    store_inspection(conn, env, "submitted")  # solo se guarda: no mueve inventario


def inspection_closed(status: str):
    """rejected / discarded: solo cambian el estado; no mueven inventario."""
    def handler(conn, env):
        d = env["data"]
        cur = conn.execute(
            "UPDATE inspections SET status = %s, reason = %s, updated_at = %s WHERE inspection_id = %s",
            (status, d.get("reason"), env["occurred_at"], d["inspection_id"]),
        )
        if cur.rowcount == 0:
            raise MissingDependency(f"inspección {d['inspection_id']} no existe")
    return handler


def inspection_approved(conn, env):
    """Solo una aprobación crea necesidad. Cada línea `buy` fija la necesidad de su línea."""
    d, code, at = env["data"], env["key"], env["occurred_at"]
    store_inspection(conn, env, "approved")

    buy = [it for it in d["items"] if it["action"] == "buy"]
    # Todo lo que referencia debe existir ya; si no, el evento espera (regla 20) en vez de
    # inventar una necesidad con cantidad desconocida.
    bom_qty = dict(conn.execute(
        "SELECT bom_line_id, qty_per_unit FROM bom_lines WHERE bom_line_id = ANY(%s::bigint[])",
        ([it["bom_line_id"] for it in buy],)).fetchall())
    for it in buy:
        if it["bom_line_id"] not in bom_qty:
            raise MissingDependency(f"línea de BOM {it['bom_line_id']} no existe")
    parts = sorted({it["part_id"] for it in buy if it["part_id"] is not None})
    known = {r[0] for r in conn.execute("SELECT part_id FROM parts WHERE part_id = ANY(%s::bigint[])", (parts,))}
    for part_id in parts:
        if part_id not in known:
            raise MissingDependency(f"pieza {part_id} no existe")
    for part_id in parts:  # candados en orden ascendente: así dos procesos no se bloquean entre sí
        lock_part(conn, part_id)

    for it in buy:
        required = it["quantity"]
        if required is None:  # sin cantidad capturada: se usa la de la lista de partes
            required = bom_qty[it["bom_line_id"]]
        reconcile_need(conn, d["work_order_id"], code, it, required, d["inspection_id"], at)

    for part_id in parts:
        refresh_reorder(conn, part_id, at)


# Los demás tipos de evento se agregan aquí conforme se implementen.
HANDLERS = {
    "purchase.item_received": purchase_item_received,
    "part.upserted": part_upserted,
    "location.upserted": location_upserted,
    "bom.upserted": bom_upserted,
    "work_order.opened": work_order_opened,
    "work_order.stage_changed": work_order_stage_changed,
    "inspection.submitted": inspection_submitted,
    "inspection.approved": inspection_approved,
    "inspection.rejected": inspection_closed("rejected"),
    "inspection.discarded": inspection_closed("discarded"),
}
