"""Necesidades, reservas y faltantes de las órdenes.

Todas estas funciones se llaman dentro de la transacción del evento y con el candado de la
pieza ya tomado (ver ledger.lock_part)."""
from .outbox import emit


def available(conn, part_id: int) -> int:
    row = conn.execute("SELECT available FROM part_availability WHERE part_id = %s", (part_id,)).fetchone()
    return row[0] if row else 0


def covered(conn, wo_id: int, bom_line_id: int) -> int:
    """Cuánto de la necesidad de esa línea ya está apartado o entregado."""
    return conn.execute(
        """SELECT COALESCE(SUM(quantity), 0) FROM reservations
            WHERE work_order_id = %s AND bom_line_id = %s AND status IN ('active', 'fulfilled')""",
        (wo_id, bom_line_id),
    ).fetchone()[0]


def refresh_reorder(conn, part_id: int, at: str, emit_event: bool = True) -> None:
    conn.execute("SELECT refresh_reorder(%s, %s::timestamptz, %s)", (part_id, at, emit_event))


def reserve(conn, wo_id, code, bom_line_id, part_id, qty, inspection_id, item_id, at) -> None:
    reservation_id = conn.execute(
        """INSERT INTO reservations (work_order_id, bom_line_id, part_id, quantity, status,
                                     inspection_id, inspection_item_id, created_at, updated_at)
           VALUES (%s, %s, %s, %s, 'active', %s, %s, %s, %s) RETURNING reservation_id""",
        (wo_id, bom_line_id, part_id, qty, inspection_id, item_id, at, at),
    ).fetchone()[0]
    emit(conn, "stock.reserved", code, {
        "reservation_id": reservation_id, "work_order_id": wo_id, "part_id": part_id,
        "quantity": qty, "inspection_item_id": item_id}, at)


def release_excess(conn, wo_id: int, bom_line_id: int, excess: int, at: str) -> None:
    """Libera lo que sobra de las reservas activas de una línea, de la más nueva a la más vieja.
    Lo ya entregado no se toca. Liberar no emite evento (contrato, regla 15)."""
    rows = conn.execute(
        """SELECT reservation_id, quantity, fulfilled_quantity FROM reservations
            WHERE work_order_id = %s AND bom_line_id = %s AND status = 'active'
            ORDER BY reservation_id DESC""",
        (wo_id, bom_line_id),
    ).fetchall()
    for rid, qty, done in rows:
        if excess <= 0:
            break
        take = min(qty - done, excess)
        if take <= 0:
            continue
        if take == qty - done:  # se libera todo lo que quedaba por entregar
            if done == 0:
                conn.execute("UPDATE reservations SET status = 'cancelled', updated_at = %s WHERE reservation_id = %s", (at, rid))
            else:
                conn.execute("UPDATE reservations SET quantity = %s, status = 'fulfilled', updated_at = %s WHERE reservation_id = %s", (done, at, rid))
        else:
            conn.execute("UPDATE reservations SET quantity = %s, updated_at = %s WHERE reservation_id = %s", (qty - take, at, rid))
        excess -= take


def release_need(conn, wo_id: int, bom_line_id: int, at) -> None:
    """Deja sin efecto la necesidad de una línea (inspección anulada u orden dada de baja): libera sus
    reservas activas (lo ya entregado se conserva), cierra su faltante abierto y la marca `released`.
    No emite eventos (contrato, regla 15)."""
    conn.execute(
        """SELECT release_reservation(reservation_id, %s::timestamptz) FROM reservations
            WHERE work_order_id = %s AND bom_line_id = %s AND status = 'active'""",
        (at, wo_id, bom_line_id),
    )
    conn.execute(
        """UPDATE shortages SET status = 'closed', closed_at = %s::timestamptz
            WHERE work_order_id = %s AND bom_line_id = %s AND status = 'open'""",
        (at, wo_id, bom_line_id),
    )
    conn.execute(
        "UPDATE needs SET status = 'released', updated_at = %s::timestamptz WHERE work_order_id = %s AND bom_line_id = %s",
        (at, wo_id, bom_line_id),
    )


def sync_shortage(conn, wo_id, code, bom_line_id, part_id, name, kind, missing, inspection_id, item_id, at) -> None:
    """Deja el faltante abierto de la línea igual a `missing` (None = cantidad desconocida,
    0 = ya no falta nada). Emite stock.shortage_detected cuando nace o cambia."""
    existing = conn.execute(
        """SELECT shortage_id, kind, missing_quantity - resolved_quantity FROM shortages
            WHERE work_order_id = %s AND bom_line_id = %s AND status = 'open'""",
        (wo_id, bom_line_id),
    ).fetchone()

    if missing == 0:
        if existing:
            conn.execute("UPDATE shortages SET status = 'resolved', closed_at = %s WHERE shortage_id = %s", (at, existing[0]))
        return

    if existing:
        sid, old_kind, old_remaining = existing
        conn.execute(
            """UPDATE shortages SET part_id = %s, name = %s, kind = %s, missing_quantity = %s, resolved_quantity = 0,
                      inspection_id = %s, inspection_item_id = %s WHERE shortage_id = %s""",
            (part_id, name, kind, missing, inspection_id, item_id, sid),
        )
        if old_kind == kind and old_remaining == missing:
            return  # nada cambió: no se vuelve a avisar
    else:
        conn.execute(
            """INSERT INTO shortages (work_order_id, bom_line_id, part_id, name, missing_quantity, kind, status,
                                      inspection_id, inspection_item_id, opened_at)
               VALUES (%s, %s, %s, %s, %s, %s, 'open', %s, %s, %s)""",
            (wo_id, bom_line_id, part_id, name, missing, kind, inspection_id, item_id, at),
        )
    emit(conn, "stock.shortage_detected", code, {
        "work_order_id": wo_id, "part_id": part_id, "name": name,
        "missing_quantity": missing, "inspection_item_id": item_id}, at)


def reconcile_need(conn, wo_id, code, item, required, inspection_id, at) -> None:
    """Fija la necesidad vigente de una línea (se REEMPLAZA, no se suma) y deja las reservas y
    el faltante de acuerdo con ella."""
    bom_line_id, part_id, name = item["bom_line_id"], item["part_id"], item["name"]
    conn.execute(
        """INSERT INTO needs (work_order_id, bom_line_id, part_id, name, required_qty, status,
                              inspection_id, inspection_item_id, updated_at)
           VALUES (%s, %s, %s, %s, %s, 'active', %s, %s, %s)
           ON CONFLICT (work_order_id, bom_line_id) DO UPDATE SET
             part_id = EXCLUDED.part_id, name = EXCLUDED.name, required_qty = EXCLUDED.required_qty,
             status = 'active', inspection_id = EXCLUDED.inspection_id,
             inspection_item_id = EXCLUDED.inspection_item_id, updated_at = EXCLUDED.updated_at""",
        (wo_id, bom_line_id, part_id, name, required, inspection_id, item["inspection_item_id"], at),
    )
    item_id = item["inspection_item_id"]

    if part_id is None:  # pieza sin identificar: nunca se reserva
        sync_shortage(conn, wo_id, code, bom_line_id, None, name, "unidentified", required, inspection_id, item_id, at)
        return
    if required is None:  # sin cantidad ni qty_per_unit: se reporta, no se reserva
        sync_shortage(conn, wo_id, code, bom_line_id, part_id, name, "unknown_qty", None, inspection_id, item_id, at)
        return

    have = covered(conn, wo_id, bom_line_id)
    if required < have:
        release_excess(conn, wo_id, bom_line_id, have - required, at)
        have = covered(conn, wo_id, bom_line_id)
    elif required > have:
        grab = min(max(available(conn, part_id), 0), required - have)
        if grab > 0:
            reserve(conn, wo_id, code, bom_line_id, part_id, grab, inspection_id, item_id, at)
            have += grab
    sync_shortage(conn, wo_id, code, bom_line_id, part_id, name, "insufficient",
                  max(required - have, 0), inspection_id, item_id, at)


def fill_shortages(conn, part_id: int, preferred_code, at: str) -> None:
    """Llegó material: surte los faltantes abiertos de la pieza. Primero los de la orden
    `preferred_code` (si sigue viva) y después los demás, del más antiguo al más nuevo."""
    rows = conn.execute(
        """SELECT s.shortage_id, s.work_order_id, w.code, s.bom_line_id, s.name,
                  s.missing_quantity - s.resolved_quantity, s.inspection_id, s.inspection_item_id
             FROM shortages s JOIN work_orders w USING (work_order_id)
            WHERE s.part_id = %s AND s.status = 'open' AND s.kind = 'insufficient' AND w.deleted_at IS NULL
            ORDER BY COALESCE(w.code = %s, false) DESC, s.opened_at, s.shortage_id""",
        (part_id, preferred_code),
    ).fetchall()
    for sid, wo_id, code, bom_line_id, name, remaining, inspection_id, item_id in rows:
        fill = min(max(available(conn, part_id), 0), remaining)
        if fill <= 0:
            break
        reserve(conn, wo_id, code, bom_line_id, part_id, fill, inspection_id, item_id, at)
        done = fill == remaining
        conn.execute(
            """UPDATE shortages SET resolved_quantity = resolved_quantity + %s,
                      status = CASE WHEN %s THEN 'resolved' ELSE status END,
                      closed_at = CASE WHEN %s THEN %s::timestamptz ELSE closed_at END
                WHERE shortage_id = %s""",
            (fill, done, done, at, sid),
        )
        emit(conn, "stock.shortage_resolved", code,
             {"work_order_id": wo_id, "part_id": part_id, "quantity": fill}, at)
