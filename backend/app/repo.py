"""Acceso a datos de la API: consultas y operaciones sobre Postgres (ver db/schema.sql).
Las operaciones que escriben (transfer, count, issue, resolve_receipt) toman el candado de la
pieza, validan antes de escribir y dejan su aviso de salida en el outbox, todo en una transacción.
Los errores se lanzan como NotFound (404) o Conflict (409); main.py los traduce."""
import re
import uuid
from contextlib import contextmanager
from datetime import date, timedelta

from psycopg import errors as pg_errors

from . import db
from .domain import ISO_UTC, RECEIVING_LOCATION_ID, Conflict, NotFound, key_for_part
from .ledger import add_movement, lock_part, on_hand_at, post_receipt
from .outbox import emit


@contextmanager
def write_tx():
    """Transacción de una operación que escribe. Si Postgres rechaza el commit por dejar un saldo
    negativo (red de seguridad del esquema), se responde 409 en vez de un error 500."""
    try:
        with db.tx() as conn:
            yield conn
    except pg_errors.CheckViolation as exc:
        raise Conflict("el saldo de la ubicación no alcanza") from exc


def require_part(conn, part_id: int) -> None:
    if conn.execute("SELECT 1 FROM parts WHERE part_id = %s", (part_id,)).fetchone() is None:
        raise NotFound(f"la pieza {part_id} no existe")


def require_location(conn, location_id: int) -> None:
    if conn.execute("SELECT 1 FROM locations WHERE location_id = %s", (location_id,)).fetchone() is None:
        raise NotFound(f"la ubicación {location_id} no existe")


def now(conn):
    """Hora del servidor. Se toma DESPUÉS del candado de la pieza: así el orden de las horas sigue el
    orden real de los movimientos y el saldo corrido del kardex nunca queda desordenado."""
    return conn.execute("SELECT clock_timestamp()").fetchone()[0]


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
    """Recepciones que no coincidieron con el catálogo y esperan relación manual."""
    with db.tx() as conn:
        rows = conn.execute(
            f"""SELECT purchase_line_id, part_number, description, quantity, unit_price::text, currency,
                       to_char(received_at AT TIME ZONE 'UTC', {ISO_UTC}), work_order_code, unmatched_reason
                  FROM purchase_receipts WHERE match_status = 'unmatched'
                 ORDER BY received_at, purchase_line_id"""
        ).fetchall()
    return {"items": [
        {"id": r[0], "purchase_line_id": r[0], "part_number": r[1], "description": r[2], "quantity": r[3],
         "unit_price": r[4], "currency": r[5], "received_at": r[6], "work_order_code": r[7], "reason": r[8]}
        for r in rows]}


def resolve_receipt(receipt_id: str, part_id: int, location_id: int | None):
    """Relaciona a mano una recepción con una pieza: da la entrada como si hubiera coincidido desde
    el principio (con la fecha de la recepción), incluido surtir el faltante de su orden.
    Primero se bloquea la fila de la recepción y luego la pieza; así dos peticiones a la vez
    no la registran dos veces (la segunda ve que ya está resuelta y recibe 409)."""
    try:
        line_id = int(receipt_id)
    except ValueError:
        raise NotFound(f"la recepción {receipt_id} no existe")
    with write_tx() as conn:
        row = conn.execute(
            """SELECT match_status, quantity, unit_price::text, currency, work_order_code, received_at
                 FROM purchase_receipts WHERE purchase_line_id = %s FOR UPDATE""",
            (line_id,),
        ).fetchone()
        if row is None:
            raise NotFound(f"la recepción {receipt_id} no existe")
        status, quantity, unit_cost, currency, work_order_code, received_at = row
        if status == "resolved":
            raise Conflict(f"la recepción {line_id} ya fue resuelta")
        if status != "unmatched":
            raise Conflict(f"la recepción {line_id} no está pendiente de relacionar")
        require_part(conn, part_id)
        location = location_id if location_id is not None else RECEIVING_LOCATION_ID
        require_location(conn, location)
        conn.execute(
            """UPDATE purchase_receipts SET match_status = 'resolved', unmatched_reason = NULL, part_id = %s,
                      resolved_by = 'api', resolved_at = clock_timestamp() WHERE purchase_line_id = %s""",
            (part_id, line_id),
        )
        return post_receipt(conn, line_id=line_id, part_id=part_id, location_id=location, quantity=quantity,
                            unit_cost=unit_cost, currency=currency, work_order_code=work_order_code,
                            received_at=received_at)


def issue(work_order_code: str, part_id: int, location_id: int, quantity: int, issued_by):
    """Salida de una pieza contra una orden. Consume primero las reservas de esa orden para esa
    pieza (la más antigua primero); una reserva entregada completa pasa a `fulfilled`.
    409 si no alcanza el saldo de la ubicación, o si la salida dejaría sin cubrir las reservas de
    otras órdenes (available nunca baja de cero por una salida; solo un conteo puede)."""
    with write_tx() as conn:
        order = conn.execute("SELECT work_order_id FROM work_orders WHERE code = %s", (work_order_code,)).fetchone()
        if order is None:
            raise NotFound(f"la orden {work_order_code} no existe")
        require_part(conn, part_id)
        require_location(conn, location_id)
        lock_part(conn, part_id)
        have = on_hand_at(conn, part_id, location_id)
        if have < quantity:
            raise Conflict(f"en la ubicación {location_id} hay {have} y se piden {quantity}")
        available_before = conn.execute("SELECT available FROM part_availability WHERE part_id = %s", (part_id,)).fetchone()[0]
        at = now(conn)

        left, first_reservation = quantity, None
        reservations = conn.execute(
            """SELECT reservation_id, quantity, fulfilled_quantity FROM reservations
                WHERE work_order_id = %s AND part_id = %s AND status = 'active'
                ORDER BY created_at, reservation_id FOR UPDATE""",
            (order[0], part_id),
        ).fetchall()
        for reservation_id, qty, done in reservations:
            take = min(left, qty - done)
            if take <= 0:
                continue
            conn.execute(
                """UPDATE reservations SET fulfilled_quantity = fulfilled_quantity + %s, updated_at = %s,
                          status = CASE WHEN fulfilled_quantity + %s = quantity THEN 'fulfilled' ELSE 'active' END
                    WHERE reservation_id = %s""",
                (take, at, take, reservation_id),
            )
            first_reservation = first_reservation or reservation_id
            left -= take
            if left == 0:
                break

        movement = add_movement(conn, "issue", part_id, location_id, -quantity, at, work_order_id=order[0],
                                reservation_id=first_reservation, actor=str(issued_by), reference=work_order_code)
        available_after = conn.execute("SELECT available FROM part_availability WHERE part_id = %s", (part_id,)).fetchone()[0]
        if available_after < min(available_before, 0):
            raise Conflict("la salida dejaría sin cubrir las reservas de otras órdenes")
        emit(conn, "stock.issued", work_order_code, {
            "work_order_id": order[0], "part_id": part_id, "location_id": location_id,
            "quantity": quantity, "issued_by": issued_by}, at)
    return movement


def transfer(part_id: int, from_location_id: int, to_location_id: int, quantity: int):
    """Mueve piezas entre ubicaciones: un movimiento de salida y otro de entrada, juntos o ninguno.
    El total de la pieza no cambia, así que las reservas (por pieza) tampoco."""
    with write_tx() as conn:
        require_part(conn, part_id)
        require_location(conn, from_location_id)
        require_location(conn, to_location_id)
        lock_part(conn, part_id)
        have = on_hand_at(conn, part_id, from_location_id)
        if have < quantity:
            raise Conflict(f"en la ubicación {from_location_id} hay {have} y se piden {quantity}")
        at, group = now(conn), uuid.uuid4()
        out = add_movement(conn, "transfer_out", part_id, from_location_id, -quantity, at, group_id=group)
        add_movement(conn, "transfer_in", part_id, to_location_id, quantity, at, group_id=group)
        emit(conn, "stock.transferred", key_for_part(part_id), {
            "part_id": part_id, "from_location_id": from_location_id,
            "to_location_id": to_location_id, "quantity": quantity}, at)
    return out


def count(location_id: int, reason: str, lines):
    """Conteo cíclico de una ubicación: un ajuste por cada pieza cuyo conteo difiere del saldo.
    Una pieza que no se lista no se toca. Es todo o nada: una pieza inexistente cancela el conteo."""
    with write_tx() as conn:
        require_location(conn, location_id)
        counted = {}  # si una pieza se repite en las líneas, gana la última
        for line in lines:
            counted[line.part_id] = line.counted_quantity
        for part_id in counted:
            require_part(conn, part_id)
        for part_id in sorted(counted):  # candados en orden ascendente: dos conteos no se bloquean entre sí
            lock_part(conn, part_id)
        at = now(conn)
        adjustments = []
        for part_id, qty in counted.items():
            delta = qty - on_hand_at(conn, part_id, location_id)
            if delta == 0:
                continue
            add_movement(conn, "adjustment", part_id, location_id, delta, at, reason=reason, reference=reason)
            emit(conn, "stock.adjusted", key_for_part(part_id), {
                "part_id": part_id, "location_id": location_id, "delta": delta, "reason": reason}, at)
            adjustments.append({"part_id": part_id, "delta": delta})
    return {"adjustments": adjustments}


# ---------------------------------------------------------------------------------------------
# Rutas extra para las pantallas (fuera del contrato, que permite agregar rutas).
# ---------------------------------------------------------------------------------------------

PART_SUMMARY = """
    SELECT p.part_id, p.sku, p.name, p.family, p.unit_name, a.on_hand, a.reserved, a.available,
           (SELECT COUNT(*) FROM shortages s WHERE s.part_id = p.part_id AND s.status = 'open')::int,
           pol.min_qty, pol.max_qty
      FROM parts p
      JOIN part_availability a USING (part_id)
      LEFT JOIN part_policies pol USING (part_id)"""


def _part_summary(r) -> dict:
    return {"part_id": r[0], "sku": r[1], "name": r[2], "family": r[3], "unit_name": r[4], "on_hand": r[5],
            "reserved": r[6], "available": r[7], "open_shortages": r[8], "min_qty": r[9], "max_qty": r[10]}


def _location(r) -> dict:
    return {"location_id": r[0], "code": r[1], "name": r[2], "is_workbench": r[3], "active": r[4]}


def list_parts(q: str | None, limit: int = 500):
    """Piezas activas con sus totales, para la tabla de existencias y el buscador de piezas.
    `q` busca en nombre y SKU (sin importar mayúsculas) o por part_id exacto."""
    q = (q or "").strip() or None
    like = f"%{q}%" if q else None
    with db.tx() as conn:
        rows = conn.execute(
            PART_SUMMARY + """
             WHERE p.active
               AND (%s::text IS NULL OR p.name ILIKE %s OR p.sku ILIKE %s OR p.part_id::text = %s)
             ORDER BY p.name, p.part_id LIMIT %s""",
            (q, like, like, q, limit),
        ).fetchall()
    return {"items": [_part_summary(r) for r in rows]}


def get_part(part_id: int):
    """Una pieza con sus totales (para el encabezado del kardex). None si no existe."""
    with db.tx() as conn:
        row = conn.execute(PART_SUMMARY + " WHERE p.part_id = %s", (part_id,)).fetchone()
    return _part_summary(row) if row else None


LOCATION_CODE = re.compile(r"^U-\d{3}$", re.IGNORECASE)
PART_LABEL = re.compile(r"^P-(\d+)$", re.IGNORECASE)


def scan(code: str):
    """Traduce lo que leyó el escáner (contrato §5): `U-101` es una ubicación, `P-24` una pieza sin SKU
    y cualquier otra cosa un SKU, comparado como en las compras (sin mayúsculas ni espacios en los
    extremos). Un SKU puede ser de varias piezas y un código de ubicación puede repetirse: se devuelven
    todas y la pantalla pide elegir. None si nada coincide."""
    text = code.strip()
    with db.tx() as conn:
        if LOCATION_CODE.match(text):
            rows = conn.execute(
                """SELECT location_id, code, name, is_workbench, active FROM locations
                    WHERE upper(code) = upper(%s) ORDER BY active DESC, location_id""",
                (text,),
            ).fetchall()
            if rows:
                locations = [_location(r) for r in rows]
                return {"kind": "location", "location": locations[0], "locations": locations}
        label = PART_LABEL.match(text)
        if label:
            rows = conn.execute(PART_SUMMARY + " WHERE p.part_id = %s", (int(label.group(1)),)).fetchall()
        else:
            rows = conn.execute(
                PART_SUMMARY + " WHERE p.sku_norm = normalize_sku(%s) ORDER BY p.active DESC, p.part_id", (code,)
            ).fetchall()
    if not rows:
        return None
    return {"kind": "part", "parts": [_part_summary(r) for r in rows]}


def list_locations():
    with db.tx() as conn:
        rows = conn.execute(
            "SELECT location_id, code, name, is_workbench, active FROM locations ORDER BY code, location_id"
        ).fetchall()
    return {"items": [_location(r) for r in rows]}


def list_work_orders():
    """Órdenes vivas (sin las dadas de baja), de la más reciente a la más antigua, con su avance."""
    with db.tx() as conn:
        rows = conn.execute(
            f"""SELECT w.work_order_id, w.code, w.stage, w.department,
                       to_char(w.received_at AT TIME ZONE 'UTC', {ISO_UTC}),
                       COUNT(m.bom_line_id)::int,
                       (COUNT(m.bom_line_id) FILTER (WHERE m.missing IS NULL OR m.missing > 0))::int
                  FROM work_orders w
                  LEFT JOIN work_order_materials m USING (work_order_id)
                 WHERE w.deleted_at IS NULL
                 GROUP BY w.work_order_id
                 ORDER BY w.received_at DESC NULLS LAST, w.code DESC"""
        ).fetchall()
    return {"items": [
        {"work_order_id": r[0], "code": r[1], "stage": r[2], "department": r[3], "received_at": r[4],
         "lines": r[5], "lines_missing": r[6]} for r in rows]}


def get_policy(part_id: int):
    """Política mínimo/máximo de una pieza; los campos van en null si no tiene. None si la pieza no existe."""
    with db.tx() as conn:
        if conn.execute("SELECT 1 FROM parts WHERE part_id = %s", (part_id,)).fetchone() is None:
            return None
        row = conn.execute(
            "SELECT min_qty, max_qty, reorder_qty, lead_time_days FROM part_policies WHERE part_id = %s",
            (part_id,),
        ).fetchone() or (None, None, None, None)
    return {"part_id": part_id, "min_qty": row[0], "max_qty": row[1], "reorder_qty": row[2],
            "lead_time_days": row[3]}


def part_work_orders(part_id: int):
    """Órdenes vivas que esperan una pieza (algo reservado por entregar o un faltante abierto), para que
    Piso llene la orden sola al retirar. Una pieza puede estar en varias líneas de la misma orden: se suman.
    None si la pieza no existe."""
    with db.tx() as conn:
        if conn.execute("SELECT 1 FROM parts WHERE part_id = %s", (part_id,)).fetchone() is None:
            return None
        rows = conn.execute(
            """SELECT m.work_order_id, m.code, w.stage,
                      SUM(m.required)::int, SUM(m.reserved)::int, SUM(m.issued)::int,
                      COALESCE(SUM(m.missing), 0)::int, bool_or(m.missing IS NULL)
                 FROM work_order_materials m JOIN work_orders w USING (work_order_id)
                WHERE m.part_id = %s AND w.deleted_at IS NULL
                GROUP BY m.work_order_id, m.code, w.stage
               HAVING SUM(m.reserved) > 0 OR bool_or(m.missing IS NULL OR m.missing > 0)
                ORDER BY SUM(m.reserved) DESC, m.code""",
            (part_id,),
        ).fetchall()
    return {"items": [
        {"work_order_id": r[0], "code": r[1], "stage": r[2], "required": r[3], "reserved": r[4], "issued": r[5],
         "missing": r[6], "missing_unknown": r[7]} for r in rows]}


FORECAST_WEEKS = 4  # semanas que se promedian y semanas que se proyectan
IDLE_DAYS = 30


def dashboard():
    """Indicadores del tablero. La demanda sale de las necesidades de las inspecciones aprobadas (el
    dataset no trae salidas: esas solo nacen de POST /issues). "Sin movimiento" se mide contra el último
    movimiento registrado, porque el simulador corre en tiempo simulado."""
    with db.tx() as conn:
        kpis = conn.execute(
            """SELECT
                 (SELECT COUNT(*) FROM part_availability a JOIN parts p USING (part_id)
                   WHERE p.active AND a.available <= 0)::int,
                 (SELECT COUNT(*) FROM shortages WHERE status = 'open')::int,
                 (SELECT COUNT(*) FROM reorder_suggestions WHERE status = 'open')::int,
                 (SELECT COUNT(*) FROM purchase_receipts WHERE match_status = 'unmatched')::int,
                 (SELECT COUNT(*) FROM parts WHERE active)::int"""
        ).fetchone()
        # Costo promedio ponderado de las entradas por pieza, en la moneda de su última entrada
        # (no se convierte entre monedas).
        value_rows = conn.execute(
            """WITH main AS (
                 SELECT DISTINCT ON (part_id) part_id, currency FROM movements
                  WHERE movement_type = 'receipt' AND currency IS NOT NULL AND unit_cost IS NOT NULL
                  ORDER BY part_id, occurred_at DESC, movement_id DESC),
               cost AS (
                 SELECT m.part_id, m.currency, SUM(mv.qty * mv.unit_cost) / SUM(mv.qty) AS avg_cost
                   FROM main m JOIN movements mv
                     ON mv.part_id = m.part_id AND mv.currency = m.currency
                    AND mv.movement_type = 'receipt' AND mv.unit_cost IS NOT NULL
                  GROUP BY m.part_id, m.currency)
               SELECT c.currency, ROUND(SUM(GREATEST(a.on_hand, 0) * c.avg_cost), 2)::text
                 FROM cost c JOIN part_availability a USING (part_id)
                GROUP BY c.currency ORDER BY c.currency"""
        ).fetchall()
        top = conn.execute(
            """WITH d AS (SELECT part_id, SUM(required_qty) AS demand FROM needs
                           WHERE part_id IS NOT NULL AND required_qty IS NOT NULL GROUP BY part_id),
                    m AS (SELECT part_id,
                                 -SUM(qty) FILTER (WHERE movement_type = 'issue') AS issued,
                                 SUM(qty) FILTER (WHERE movement_type = 'receipt') AS received
                            FROM movements GROUP BY part_id)
               SELECT p.part_id, p.sku, p.name, COALESCE(d.demand, 0)::int, COALESCE(m.issued, 0)::int,
                      COALESCE(m.received, 0)::int, a.on_hand
                 FROM parts p JOIN part_availability a USING (part_id)
                 LEFT JOIN d USING (part_id) LEFT JOIN m USING (part_id)
                WHERE COALESCE(d.demand, 0) + COALESCE(m.issued, 0) > 0
                ORDER BY COALESCE(d.demand, 0) + COALESCE(m.issued, 0) DESC, p.part_id LIMIT 10"""
        ).fetchall()
        idle = conn.execute(
            f"""SELECT p.part_id, p.sku, p.name, a.on_hand,
                       to_char(MAX(mv.occurred_at) AT TIME ZONE 'UTC', {ISO_UTC})
                  FROM parts p JOIN part_availability a USING (part_id)
                  JOIN movements mv USING (part_id)
                 WHERE a.on_hand > 0
                 GROUP BY p.part_id, p.sku, p.name, a.on_hand
                HAVING MAX(mv.occurred_at) < (SELECT MAX(occurred_at) FROM movements) - make_interval(days => %s)
                 ORDER BY MAX(mv.occurred_at), p.part_id LIMIT 10""",
            (IDLE_DAYS,),
        ).fetchall()
        weeks = conn.execute(
            """WITH d AS (SELECT date_trunc('week', updated_at) AS week, SUM(required_qty) AS demand FROM needs
                           WHERE required_qty IS NOT NULL GROUP BY 1),
                    i AS (SELECT date_trunc('week', occurred_at) AS week, -SUM(qty) AS issued FROM movements
                           WHERE movement_type = 'issue' GROUP BY 1),
                    r AS (SELECT date_trunc('week', occurred_at) AS week, SUM(qty) AS received FROM movements
                           WHERE movement_type = 'receipt' GROUP BY 1),
                    -- todas las semanas entre la primera y la última, aunque alguna no tenga datos
                    s AS (SELECT generate_series(MIN(week), MAX(week), interval '1 week') AS week
                            FROM (SELECT week FROM d UNION SELECT week FROM i UNION SELECT week FROM r) x)
               SELECT to_char(s.week, 'YYYY-MM-DD'), COALESCE(d.demand, 0)::int, COALESCE(i.issued, 0)::int,
                      COALESCE(r.received, 0)::int
                 FROM s LEFT JOIN d USING (week) LEFT JOIN i USING (week) LEFT JOIN r USING (week)
                ORDER BY s.week"""
        ).fetchall()
        consumer = conn.execute(
            f"""SELECT (SELECT COUNT(*) FROM processed_events)::int,
                       (SELECT to_char(MAX(processed_at) AT TIME ZONE 'UTC', {ISO_UTC}) FROM processed_events),
                       (SELECT COUNT(*) FROM pending_events WHERE next_retry_at <> 'infinity')::int,
                       (SELECT COUNT(*) FROM pending_events WHERE next_retry_at = 'infinity')::int,
                       (SELECT COUNT(*) FROM outbox WHERE published_at IS NULL)::int,
                       (SELECT to_char(MIN(occurred_at) AT TIME ZONE 'UTC', {ISO_UTC})
                          FROM outbox WHERE published_at IS NULL)"""
        ).fetchone()

    series = [{"week": w, "demand": d, "issued": i, "received": r} for w, d, i, r in weeks]
    recent = [s["demand"] + s["issued"] for s in series[-FORECAST_WEEKS:]]
    projection = []
    if recent:
        avg = round(sum(recent) / len(recent))
        last = date.fromisoformat(series[-1]["week"])
        projection = [{"week": (last + timedelta(weeks=n)).isoformat(), "demand": avg}
                      for n in range(1, FORECAST_WEEKS + 1)]
    return {
        "kpis": {"parts_out_of_stock": kpis[0], "open_shortages": kpis[1], "open_suggestions": kpis[2],
                 "unmatched_receipts": kpis[3], "active_parts": kpis[4],
                 "inventory_value": [{"currency": c, "amount": v} for c, v in value_rows]},
        "rotation": {
            "top": [{"part_id": r[0], "sku": r[1], "name": r[2], "demand": r[3], "issued": r[4], "received": r[5],
                     "on_hand": r[6]} for r in top],
            "idle": [{"part_id": r[0], "sku": r[1], "name": r[2], "on_hand": r[3], "last_movement_at": r[4]}
                     for r in idle],
            "idle_days": IDLE_DAYS,
        },
        "forecast": {"weeks": series, "projection": projection,
                     "method": f"promedio de las últimas {FORECAST_WEEKS} semanas (demanda + salidas)"},
        "consumer": {"processed": consumer[0], "last_processed_at": consumer[1], "pending": consumer[2],
                     "exhausted": consumer[3], "outbox_unpublished": consumer[4],
                     "oldest_unpublished_at": consumer[5]},
    }
