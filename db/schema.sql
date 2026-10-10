-- =====================================================================
-- Servicio de inventario — Almacén inteligente para taller
-- Esquema PostgreSQL (13+)
--
-- Principios:
--   * Libro mayor: on_hand = SUM(movements.qty). Nunca se edita.
--   * Idempotencia: processed_events en la misma transacción que los efectos.
--   * Lock por pieza: pg_advisory_xact_lock(1, part_id), en orden ascendente.
--   * Outbox: todo evento de salida se escribe en la misma transacción.
--   * Reconstruible: borrar y releer tópicos (shop.catalog completo primero).
--
-- Alineado con kit/contract/ (gana sobre el documento del reto):
--   * Cantidades enteras, en la unidad de la pieza.
--   * Importes como decimal exacto (se publican como texto "1850.00").
--   * Fechas en UTC.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. Funciones compartidas
-- ---------------------------------------------------------------------

-- Normalización de SKU / part_number (regla 10 del contrato):
--   mayúsculas, sin espacios al inicio ni al final, y espacios internos
--   repetidos colapsados a uno. No se quitan puntos, guiones ni diagonales:
--   un falso positivo mete stock a la pieza equivocada.
CREATE FUNCTION normalize_sku(t text) RETURNS text
LANGUAGE sql IMMUTABLE RETURNS NULL ON NULL INPUT AS $$
  SELECT upper(btrim(regexp_replace(t, '\s+', ' ', 'g')))
$$;

-- ---------------------------------------------------------------------
-- 1. Control: idempotencia, desorden y salida
-- ---------------------------------------------------------------------

CREATE TABLE processed_events (
  event_id     uuid PRIMARY KEY,
  event_type   text        NOT NULL,
  topic        text        NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pending_events (
  id            bigserial PRIMARY KEY,
  event_id      uuid        NOT NULL UNIQUE,
  topic         text        NOT NULL,
  envelope      jsonb       NOT NULL,          -- sobre completo, se reintenta tal cual
  reason        text        NOT NULL,          -- ej. 'part 305 not found'
  attempts      int         NOT NULL DEFAULT 0,
  next_retry_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pending_events_due ON pending_events (next_retry_at);

CREATE TABLE outbox (
  id           bigserial PRIMARY KEY,           -- orden de publicación
  event_id     uuid        NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  event_type   text        NOT NULL,
  key          text        NOT NULL,           -- código de orden, part:<id> o purchase_line:<id>
  data         jsonb       NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz                      -- NULL = falta publicar
);
CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;

-- ---------------------------------------------------------------------
-- 2. Catálogo (shop.catalog)
-- ---------------------------------------------------------------------

CREATE TABLE parts (
  part_id    bigint PRIMARY KEY,                -- viene del taller, no se genera
  sku        text,                              -- nullable y NO único
  sku_norm   text GENERATED ALWAYS AS (normalize_sku(sku)) STORED,
  name       text    NOT NULL,
  family     text,                              -- 'SERVICIO' no se inventaría
  "group"    text,
  subgroup   text,
  unit_id    bigint,
  unit_name  text,
  image_url  text,
  active     boolean NOT NULL
);
CREATE INDEX parts_sku_norm ON parts (sku_norm);   -- no único a propósito

CREATE TABLE locations (
  location_id  bigint PRIMARY KEY,
  code         text    NOT NULL,                -- código de barras: U-100, U-101… (NO único: las pruebas de contrato generan códigos repetidos)
  name         text    NOT NULL,
  is_workbench boolean NOT NULL,
  active       boolean NOT NULL
);
CREATE INDEX locations_code ON locations (code);

CREATE TABLE models (
  model_id   bigint PRIMARY KEY,
  model_name text NOT NULL,
  brand      text
);

CREATE TABLE bom_lines (
  bom_line_id  bigint PRIMARY KEY,
  model_id     bigint NOT NULL REFERENCES models,
  part_id      bigint,                          -- sin FK: el BOM puede llegar antes que la pieza
  name         text   NOT NULL,
  group_name   text,                            -- kit (solo informativo: se inventarían componentes)
  unit_id      bigint,
  unit_name    text,
  qty_per_unit int    CHECK (qty_per_unit >= 1),
  sort_order   int
);
CREATE INDEX bom_lines_by_model ON bom_lines (model_id);

-- ---------------------------------------------------------------------
-- 3. Órdenes e inspecciones (copia cruda de lo que llegó)
-- ---------------------------------------------------------------------

CREATE TABLE work_orders (
  work_order_id bigint PRIMARY KEY,
  code          text   NOT NULL UNIQUE,
  model_id      bigint,                         -- sin FK: el modelo puede llegar después
  department    text CHECK (department IN ('spindles','motors','electronics','torque_center')),
  stage         text CHECK (stage IN (
                  'awaiting_quick_inspection','quick_inspection',
                  'awaiting_full_inspection','full_inspection','cleaning',
                  'assembly','run_in','final_assembly','final_release')),
  received_at   timestamptz,
  deleted_at    timestamptz                     -- baja lógica (regla 14)
);

CREATE TABLE inspections (
  inspection_id bigint PRIMARY KEY,
  work_order_id bigint NOT NULL REFERENCES work_orders,
  kind          text   NOT NULL CHECK (kind IN ('quick','full')),
  status        text   NOT NULL CHECK (status IN
                  ('submitted','approved','rejected','discarded','voided')),
  approved_by   bigint,
  approved_at   timestamptz,
  reason        text,
  updated_at    timestamptz NOT NULL
);
CREATE INDEX inspections_by_work_order ON inspections (work_order_id);

CREATE TABLE inspection_items (
  inspection_item_id bigint PRIMARY KEY,
  inspection_id      bigint NOT NULL REFERENCES inspections,
  bom_line_id        bigint NOT NULL,           -- sin FK: copia cruda
  part_id            bigint,                    -- sin FK: puede ser null o desconocido
  name               text   NOT NULL,
  group_name         text,
  condition          text   NOT NULL CHECK (condition IN ('ok','damaged','missing')),
  action             text   CHECK (action IN ('buy','repair')),
  quantity           int    CHECK (quantity >= 1),
  note               text
);
CREATE INDEX inspection_items_by_inspection ON inspection_items (inspection_id);

-- ---------------------------------------------------------------------
-- 4. Necesidades, reservas y faltantes (estado validado)
-- ---------------------------------------------------------------------

-- Una necesidad por (orden, línea de BOM). Se reemplaza, no se suma (reglas 2-3).
CREATE TABLE needs (
  work_order_id      bigint NOT NULL REFERENCES work_orders,
  bom_line_id        bigint NOT NULL,
  part_id            bigint REFERENCES parts,   -- null = pieza sin identificar
  name               text   NOT NULL,
  required_qty       int    CHECK (required_qty >= 0),  -- null = cantidad desconocida
  status             text   NOT NULL CHECK (status IN ('active','released')),
  inspection_id      bigint NOT NULL REFERENCES inspections,      -- última que la definió
  inspection_item_id bigint NOT NULL REFERENCES inspection_items,
  updated_at         timestamptz NOT NULL,
  PRIMARY KEY (work_order_id, bom_line_id)
);
-- regla 13: voided libera las líneas cuya necesidad vigente vino de esa inspección
CREATE INDEX needs_by_inspection ON needs (inspection_id) WHERE status = 'active';

-- Reservas: por pieza, no por ubicación.
CREATE TABLE reservations (
  reservation_id     bigserial PRIMARY KEY,
  work_order_id      bigint NOT NULL,
  bom_line_id        bigint NOT NULL,
  part_id            bigint NOT NULL REFERENCES parts,
  quantity           int    NOT NULL CHECK (quantity >= 1),
  fulfilled_quantity int    NOT NULL DEFAULT 0,
  status             text   NOT NULL CHECK (status IN ('active','fulfilled','cancelled')),
  inspection_id      bigint NOT NULL REFERENCES inspections,
  inspection_item_id bigint NOT NULL REFERENCES inspection_items,
  created_at         timestamptz NOT NULL,      -- hora del evento (FIFO determinista)
  updated_at         timestamptz NOT NULL,
  FOREIGN KEY (work_order_id, bom_line_id) REFERENCES needs,
  CHECK (fulfilled_quantity BETWEEN 0 AND quantity),
  CHECK (status <> 'fulfilled' OR fulfilled_quantity = quantity)
);
CREATE INDEX reservations_active_by_part ON reservations (part_id) WHERE status = 'active';
CREATE INDEX reservations_by_need        ON reservations (work_order_id, bom_line_id);

-- Liberar una reserva sin perder lo ya entregado: si algo se entregó, la reserva queda
-- 'fulfilled' con quantity = fulfilled_quantity; si no, 'cancelled'. Llamar con el lock
-- de la pieza. (voided / work_order.deleted, reglas 13 y 14)
CREATE FUNCTION release_reservation(p_id bigint, p_at timestamptz) RETURNS void
LANGUAGE sql AS $$
  UPDATE reservations
     SET quantity   = CASE WHEN fulfilled_quantity > 0 THEN fulfilled_quantity ELSE quantity END,
         status     = CASE WHEN fulfilled_quantity > 0 THEN 'fulfilled' ELSE 'cancelled' END,
         updated_at = p_at
   WHERE reservation_id = p_id AND status = 'active'
$$;

CREATE TABLE shortages (
  shortage_id        bigserial PRIMARY KEY,
  work_order_id      bigint NOT NULL,
  bom_line_id        bigint NOT NULL,
  part_id            bigint REFERENCES parts,   -- null = sin identificar
  name               text   NOT NULL,
  missing_quantity   int    CHECK (missing_quantity >= 1),  -- null = sin capturar
  resolved_quantity  int    NOT NULL DEFAULT 0,
  kind               text   NOT NULL CHECK (kind IN
                       ('insufficient','unidentified','unknown_qty','not_stocked')),
  status             text   NOT NULL CHECK (status IN ('open','resolved','closed')),
  inspection_id      bigint NOT NULL REFERENCES inspections,
  inspection_item_id bigint NOT NULL REFERENCES inspection_items,
  opened_at          timestamptz NOT NULL,
  closed_at          timestamptz,
  FOREIGN KEY (work_order_id, bom_line_id) REFERENCES needs,
  CHECK (missing_quantity IS NULL OR resolved_quantity <= missing_quantity),
  CHECK ((kind = 'unidentified') = (part_id IS NULL)),
  CHECK (kind = 'unidentified' OR (kind = 'unknown_qty') = (missing_quantity IS NULL))
);
CREATE UNIQUE INDEX shortages_one_open_per_need
  ON shortages (work_order_id, bom_line_id) WHERE status = 'open';
CREATE INDEX shortages_open_fifo
  ON shortages (part_id, opened_at, shortage_id) WHERE status = 'open';

-- ---------------------------------------------------------------------
-- 5. Libro mayor
-- ---------------------------------------------------------------------

CREATE TYPE movement_type AS ENUM
  ('receipt', 'issue', 'transfer_out', 'transfer_in', 'adjustment');

CREATE TABLE movements (
  movement_id      bigserial PRIMARY KEY,
  group_id         uuid          NOT NULL DEFAULT gen_random_uuid(),  -- une transfer_out/in
  movement_type    movement_type NOT NULL,
  part_id          bigint        NOT NULL REFERENCES parts,
  location_id      bigint        NOT NULL REFERENCES locations,
  qty              int           NOT NULL CHECK (qty <> 0),          -- con signo
  unit_cost        numeric,                     -- exacto, sin escala fija ("1850.00" vuelve igual)
  currency         text CHECK (currency IN ('MXN','USD')),
  work_order_id    bigint,
  purchase_line_id bigint,
  reservation_id   bigint REFERENCES reservations,
  reason           text,
  actor            text,                        -- issued_by / quien contó
  source_event_id  uuid,                        -- evento de entrada u outbox que lo originó
  occurred_at      timestamptz   NOT NULL,      -- hora de negocio, del evento
  recorded_at      timestamptz   NOT NULL DEFAULT now(),

  CHECK (CASE movement_type
           WHEN 'receipt'      THEN qty > 0
           WHEN 'transfer_in'  THEN qty > 0
           WHEN 'issue'        THEN qty < 0
           WHEN 'transfer_out' THEN qty < 0
           ELSE true END),
  CHECK (movement_type <> 'adjustment' OR length(btrim(coalesce(reason, ''))) > 0),
  CHECK (movement_type <> 'receipt'    OR (purchase_line_id IS NOT NULL AND unit_cost IS NOT NULL)),
  CHECK (movement_type <> 'issue'      OR work_order_id IS NOT NULL)
);
CREATE INDEX movements_part_loc ON movements (part_id, location_id);
CREATE INDEX movements_ledger   ON movements (part_id, occurred_at, movement_id);
CREATE UNIQUE INDEX movements_one_receipt_per_line
  ON movements (purchase_line_id) WHERE movement_type = 'receipt';

-- Inmutabilidad real (TRUNCATE no dispara triggers de fila: la reconstrucción funciona)
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'movements es inmutable: corrige con un nuevo movimiento';
END $$;

CREATE TRIGGER movements_immutable
  BEFORE UPDATE OR DELETE ON movements
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Red de seguridad: ninguna ubicación termina la transacción con on_hand negativo
CREATE FUNCTION check_non_negative() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT COALESCE(SUM(qty), 0) FROM movements
      WHERE part_id = NEW.part_id AND location_id = NEW.location_id) < 0 THEN
    RAISE EXCEPTION 'on_hand negativo: part % location %', NEW.part_id, NEW.location_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER movements_non_negative
  AFTER INSERT ON movements
  DEFERRABLE INITIALLY DEFERRED                 -- se evalúa al COMMIT (transferencia completa)
  FOR EACH ROW EXECUTE FUNCTION check_non_negative();

-- ---------------------------------------------------------------------
-- 6. Compras, políticas y sugerencias
-- ---------------------------------------------------------------------

-- Todas las recepciones; /unmatched-receipts es un filtro (id = purchase_line_id)
CREATE TABLE purchase_receipts (
  purchase_line_id    bigint PRIMARY KEY,       -- line_id del evento
  purchase_request_id bigint NOT NULL,
  request_number      text   NOT NULL,
  part_number         text   NOT NULL,          -- texto libre, tal como llegó
  part_number_norm    text GENERATED ALWAYS AS (normalize_sku(part_number)) STORED,
  description         text   NOT NULL,
  quantity            int    NOT NULL CHECK (quantity >= 1),
  unit_price          numeric NOT NULL,
  currency            text   NOT NULL CHECK (currency IN ('MXN','USD')),
  purpose             text   NOT NULL CHECK (purpose IN ('restock','customer_order')),
  work_order_code     text,
  received_at         timestamptz NOT NULL,
  match_status        text   NOT NULL CHECK (match_status IN
                        ('matched','unmatched','resolved','not_inventory')),
  unmatched_reason    text   CHECK (unmatched_reason IN ('no_match','ambiguous')),
  part_id             bigint REFERENCES parts,
  resolved_by         text,
  resolved_at         timestamptz,
  CHECK ((match_status IN ('matched','resolved')) = (part_id IS NOT NULL)),
  CHECK ((purpose = 'customer_order') = (match_status = 'not_inventory')),
  CHECK ((match_status = 'unmatched') = (unmatched_reason IS NOT NULL))
);
CREATE INDEX purchase_receipts_unmatched
  ON purchase_receipts (part_number_norm) WHERE match_status = 'unmatched';

-- Se cargan desde un archivo semilla versionado (ningún tópico las trae)
CREATE TABLE part_policies (
  part_id        bigint PRIMARY KEY REFERENCES parts,
  min_qty        int CHECK (min_qty >= 0),
  max_qty        int,
  reorder_qty    int CHECK (reorder_qty >= 1),
  lead_time_days int CHECK (lead_time_days >= 0),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (max_qty IS NULL OR min_qty IS NULL OR max_qty >= min_qty)
);

-- Última sugerencia anunciada (una por pieza)
CREATE TABLE reorder_suggestions (
  part_id            bigint PRIMARY KEY REFERENCES parts,
  suggested_quantity int      NOT NULL CHECK (suggested_quantity >= 1),
  work_order_ids     bigint[] NOT NULL,
  status             text     NOT NULL CHECK (status IN ('open','closed')),
  updated_at         timestamptz NOT NULL
);

-- ---------------------------------------------------------------------
-- 7. Vistas (proyecciones; nunca se desincronizan)
-- ---------------------------------------------------------------------

CREATE VIEW stock_on_hand AS
SELECT part_id, location_id, SUM(qty)::int AS on_hand
FROM movements
GROUP BY part_id, location_id;

-- Kardex: la API ordena DESC (occurred_at, movement_id). Va por fecha del evento, no por
-- orden de inserción: los avisos llegan desordenados (una compra de agosto puede guardarse
-- después de una de septiembre), y el kardex debe leerse en orden cronológico.
CREATE VIEW part_ledger AS
SELECT m.*,
       (SUM(qty) OVER (PARTITION BY part_id
                       ORDER BY occurred_at, movement_id))::int AS running_balance
FROM movements m;

-- Disponibilidad por pieza (reservas a nivel pieza; en la API reserved = 0 por ubicación)
CREATE VIEW part_availability AS
WITH oh AS (SELECT part_id, SUM(qty) AS on_hand FROM movements GROUP BY part_id),
     rs AS (SELECT part_id, SUM(quantity - fulfilled_quantity) AS reserved
            FROM reservations WHERE status = 'active' GROUP BY part_id)
SELECT p.part_id,
       COALESCE(oh.on_hand, 0)::int                            AS on_hand,
       COALESCE(rs.reserved, 0)::int                           AS reserved,
       (COALESCE(oh.on_hand, 0) - COALESCE(rs.reserved, 0))::int AS available
FROM parts p
LEFT JOIN oh USING (part_id)
LEFT JOIN rs USING (part_id);

-- Materiales por orden: una línea por necesidad vigente (GET /work-orders/{code}/materials)
CREATE VIEW work_order_materials AS
SELECT n.work_order_id, w.code, n.inspection_item_id, n.bom_line_id, n.part_id, n.name,
       n.required_qty AS required,
       COALESCE(SUM(r.quantity - r.fulfilled_quantity)
                FILTER (WHERE r.status = 'active'), 0)::int                      AS reserved,
       COALESCE(SUM(r.fulfilled_quantity)
                FILTER (WHERE r.status IN ('active','fulfilled')), 0)::int       AS issued,
       -- 0 si no hay faltante abierto; null si el faltante no tiene cantidad
       CASE WHEN EXISTS (SELECT 1 FROM shortages s
                          WHERE s.work_order_id = n.work_order_id
                            AND s.bom_line_id = n.bom_line_id AND s.status = 'open')
            THEN (SELECT s.missing_quantity - s.resolved_quantity
                    FROM shortages s
                   WHERE s.work_order_id = n.work_order_id
                     AND s.bom_line_id = n.bom_line_id AND s.status = 'open')
            ELSE 0 END                                                           AS missing
FROM needs n
JOIN work_orders w ON w.work_order_id = n.work_order_id
LEFT JOIN reservations r ON r.work_order_id = n.work_order_id AND r.bom_line_id = n.bom_line_id
WHERE n.status = 'active'
GROUP BY n.work_order_id, w.code, n.inspection_item_id, n.bom_line_id, n.part_id, n.name,
         n.required_qty;

CREATE VIEW reorder_calc AS
WITH s AS (
  SELECT part_id,
         COALESCE(SUM(missing_quantity - resolved_quantity)
                  FILTER (WHERE missing_quantity IS NOT NULL), 0) AS shortage_qty,
         array_agg(DISTINCT work_order_id ORDER BY work_order_id)  AS work_order_ids
  FROM shortages
  WHERE status = 'open' AND kind IN ('insufficient', 'unknown_qty')
  GROUP BY part_id
)
SELECT a.part_id,
       COALESCE(s.shortage_qty, 0)::int AS shortage_qty,
       (CASE WHEN pol.min_qty IS NOT NULL AND a.available < pol.min_qty
             THEN GREATEST(COALESCE(pol.max_qty, pol.min_qty) - a.available,
                           COALESCE(pol.reorder_qty, 0))
             ELSE 0 END)::int           AS replenish_qty,
       COALESCE(s.work_order_ids, '{}') AS work_order_ids
FROM part_availability a
JOIN parts p ON p.part_id = a.part_id AND p.active
LEFT JOIN part_policies pol ON pol.part_id = a.part_id
LEFT JOIN s ON s.part_id = a.part_id;

-- ---------------------------------------------------------------------
-- 8. Recalcular sugerencia y emitir solo si nace o cambia (regla 18)
--    Llamar al final de cada transacción que toque la pieza (con su lock).
--    p_emit = false en liberaciones (voided / deleted no emiten eventos).
-- ---------------------------------------------------------------------

CREATE FUNCTION refresh_reorder(p_part bigint, p_at timestamptz, p_emit boolean)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_qty   int;
  v_wos   bigint[];
  v_old   reorder_suggestions%ROWTYPE;
  v_found boolean;
BEGIN
  SELECT shortage_qty + replenish_qty, work_order_ids
    INTO v_qty, v_wos
    FROM reorder_calc WHERE part_id = p_part;

  SELECT * INTO v_old FROM reorder_suggestions WHERE part_id = p_part;
  v_found := FOUND;

  -- sin demanda: cerrar en silencio
  IF COALESCE(v_qty, 0) <= 0 THEN
    UPDATE reorder_suggestions SET status = 'closed', updated_at = p_at
     WHERE part_id = p_part AND status = 'open';
    RETURN;
  END IF;

  -- sin cambios: no hacer nada
  IF v_found AND v_old.status = 'open'
     AND v_old.suggested_quantity = v_qty AND v_old.work_order_ids = v_wos THEN
    RETURN;
  END IF;

  INSERT INTO reorder_suggestions (part_id, suggested_quantity, work_order_ids, status, updated_at)
  VALUES (p_part, v_qty, v_wos, 'open', p_at)
  ON CONFLICT (part_id) DO UPDATE
    SET suggested_quantity = EXCLUDED.suggested_quantity,
        work_order_ids     = EXCLUDED.work_order_ids,
        status             = 'open',
        updated_at         = EXCLUDED.updated_at;

  IF p_emit THEN
    INSERT INTO outbox (event_type, key, data, occurred_at)
    VALUES ('stock.reorder_suggested', 'part:' || p_part,
            jsonb_build_object('part_id', p_part,
                               'suggested_quantity', v_qty,
                               'work_order_ids', to_jsonb(v_wos)),
            p_at);
  END IF;
END $$;

COMMIT;

-- =====================================================================
-- Reconstrucción desde cero (regla 23):
--
--   TRUNCATE processed_events, pending_events, outbox,
--            movements, reservations, shortages, needs,
--            inspection_items, inspections, work_orders,
--            purchase_receipts, reorder_suggestions, part_policies,
--            bom_lines, models, locations, parts
--   RESTART IDENTITY CASCADE;
--
--   1. Releer shop.catalog hasta el final (regla 22).
--   2. Cargar part_policies desde el archivo semilla.
--   3. Releer shop.work_orders, shop.inspections y shop.purchasing.
-- =====================================================================
