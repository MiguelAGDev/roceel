# Contrato

Este folder es la referencia exacta de lo que entra y sale de su servicio. Las pruebas de
contrato se escriben contra esto. Si algo aquí contradice al documento del reto, gana esto.

| Archivo | Qué es |
|---|---|
| `schemas/input/*.schema.json` | Un JSON Schema por evento que publica el taller |
| `schemas/output/*.schema.json` | Un JSON Schema por evento que publica su servicio |
| `schemas/common.schema.json` | Tipos compartidos (IDs, fechas, importes, etapas) |
| `schemas/index.json` | Evento → tópico → schema |
| `openapi.yaml` | La API HTTP mínima |

Para revisar un archivo de eventos contra el contrato (sus salidas incluidas):

```bash
uv run --with jsonschema tools/validate_events.py data/events.jsonl
```

## 1. Sobre

Todos los eventos, de entrada y de salida, usan el mismo sobre:

```json
{
  "event_id": "0b9f3c1e-7a42-4c1d-9e0a-5d2f8b61c7aa",
  "event_type": "inspection.approved",
  "event_version": 1,
  "occurred_at": "2026-10-06T16:42:11Z",
  "source": "shop-floor",
  "key": "R061026012",
  "data": { }
}
```

- `event_id`: UUID, único por evento. Sirve para deduplicar.
- `occurred_at`: cuándo pasó en el taller, ISO 8601 UTC. **No** es el orden de llegada.
- `source`: `shop-floor` en las entradas, `inventory` en las salidas.
- IDs enteros; importes como texto decimal (`"1850.00"`); cantidades enteras en la unidad de la pieza.
- En la entrada, todos los campos de `data` vienen siempre (los opcionales llegan como `null`)
  y no llegan campos extra. En la salida pueden agregar campos; los pedidos son obligatorios.

## 2. Tópicos y llaves

| Tópico | Eventos | `key` |
|---|---|---|
| `shop.catalog` | `part.upserted`, `location.upserted`, `bom.upserted` | `part:305`, `location:14`, `model:4` |
| `shop.work_orders` | `work_order.opened`, `.stage_changed`, `.deleted` | código de la orden (`R061026012`) |
| `shop.inspections` | `inspection.submitted`, `.approved`, `.rejected`, `.discarded`, `.voided` | código de la orden |
| `shop.purchasing` | `purchase.item_received` | `PR-` + `request_number` (`PR-2044`) |
| `inventory.events` (salida) | los 9 `stock.*` | código de la orden en los que tienen `work_order_id`; `part:<id>` en `received`, `transferred`, `adjusted`, `reorder_suggested`; `purchase_line:<id>` en `unmatched_receipt` |
| `inventory.dlq` (salida) | el evento original que no pudieron procesar | la misma del original |

Garantías de entrega:

- **Al menos una vez.** El mismo `event_id` puede llegar dos o más veces.
- **Orden por llave dentro de un tópico.** Los eventos de una misma orden en `shop.inspections`
  llegan en el orden en que pasaron. Entre tópicos distintos no hay orden: una inspección puede
  llegar antes que el `work_order.opened` de su orden o que el `part.upserted` de su pieza.
- **Retención completa.** Releer desde el inicio debe dejar el mismo saldo.

## 3. Reglas de negocio que revisan las pruebas

### Necesidad de una orden

1. Solo `inspection.approved` crea necesidad. `submitted`, `rejected` y `discarded` no mueven
   inventario.
2. La necesidad vive por **(orden, `bom_line_id`)**. Cada renglón aprobado con `action = buy`
   fija la necesidad de su línea. Si una aprobación posterior de la misma orden vuelve a traer
   esa línea, **reemplaza** la cantidad, no la suma: si sube, reservan la diferencia; si baja,
   liberan el excedente.
3. Una línea que una aprobación posterior no menciona conserva su necesidad. Por eso una
   inspección `full` con `items: []` no cambia nada.
4. `action = repair` y `condition = ok` no generan necesidad: es pieza del cliente.
5. `quantity: null` con `action = buy`: usen el `qty_per_unit` de esa línea en la lista de
   partes vigente del modelo. Si también es null, es faltante con `missing_quantity: null` y
   no se reserva nada.
6. `part_id: null`: faltante sin identificar (`stock.shortage_detected` con `part_id: null`),
   nunca reserva.

### Reserva y faltante

7. Al crear o subir una necesidad reservan `min(disponible, necesidad)` y lo que no alcance
   es faltante. Cada reserva emite `stock.reserved`; cada faltante, `stock.shortage_detected`.
8. `available = on_hand - reserved` nunca baja de cero, ni con aprobaciones simultáneas.

### Recepciones

9. `purpose = customer_order`: es material para revender a un cliente. No entra al
   inventario, no surte faltantes y no emite nada.
10. `purpose = restock`: relacionen `part_number` con el `sku` del catálogo. Como mínimo,
    ignorando mayúsculas y espacios al inicio y al final. Si no coincide con ninguna pieza, o
    coincide con más de una, emiten `stock.unmatched_receipt` y queda para revisión manual
    (`POST /unmatched-receipts/{id}/resolve`). Reglas de relación más listas son bienvenidas:
    explíquenlas en su documento de decisiones.
11. La entrada se registra en la ubicación de recepción **`U-100` (`location_id` 100)** y
    emite `stock.received`.
12. Con la entrada surten faltantes de esa pieza: primero los de la orden en
    `work_order_code` (si viene y la orden sigue viva) y después los demás, del más antiguo al
    más nuevo. Cada uno emite `stock.reserved` + `stock.shortage_resolved`.

### Cancelaciones

13. `inspection.voided`: liberan las reservas activas y cierran los faltantes de las líneas
    cuya necesidad vigente venía de esa inspección.
14. `work_order.deleted`: liberan todas las reservas activas de la orden y cierran sus
    faltantes. Si después llega una compra con ese `work_order_code`, entra como existencia
    general.
15. Liberar una reserva no emite un evento propio en esta versión; se refleja en la API.

### Salida, transferencia y conteo

16. `POST /issues` baja el saldo de la ubicación y consume primero la reserva de esa orden
    para esa pieza; cuando se entrega toda, la reserva pasa a `fulfilled`. Si no alcanza el
    saldo de la ubicación, responde 409 y no mueve nada.
17. `POST /counts` registra un ajuste por cada diferencia, con motivo obligatorio (422 sin
    motivo). Es la única forma de dejar `available` negativo.

### Sugerencias de compra

18. Una pieza con faltantes abiertos (o bajo su mínimo, si configuran políticas) tiene una
    sugerencia vigente con `suggested_quantity` ≥ la suma de lo que falta y las órdenes que lo
    piden en `work_order_ids`. Emiten `stock.reorder_suggested` cuando la sugerencia nace o
    cambia.

### Idempotencia, desorden y errores

19. Procesar dos veces el mismo `event_id` no cambia nada ni emite salidas nuevas.
20. Un evento que referencia algo que aún no conocen (pieza, orden, línea de la lista de
    partes) no se descarta: se reintenta o se encola hasta que llegue lo que falta.
21. Lo que no puedan procesar después de reintentar va a `inventory.dlq`, sin detener el
    consumo.
22. Al arrancar, y siempre que reconstruyan desde cero, consuman `shop.catalog` hasta el
    final **antes** de procesar los demás tópicos. Si no, al releer, las compras llegan antes
    que sus piezas y todas se van a revisión manual. Una compra que no coincide con el
    catálogo ya cargado sí va a revisión manual (regla 10).

### Reconstrucción

23. Borrando su base y releyendo los tópicos desde el inicio deben llegar a la misma
    existencia (`on_hand`) por pieza y ubicación. El jurado lo revisa con
    `run_tests.py snapshot` / `compare` sobre las piezas del dataset, antes de la demo. Las
    reservas no se comparan: dependen de cómo se intercalen los tópicos al releer.

## 4. Lo que el catálogo trae de verdad

- Piezas con `sku: null` (claves pendientes) y piezas distintas con el **mismo** `sku`.
- Familia `SERVICIO`: servicios (cromado, rectificado) que también aparecen en listas de
  partes con `action = buy`. Decidan si se inventarían.
- Kits: líneas con el mismo `group_name` (o el mismo `name` si `group_name` es null).
- Ubicaciones: mesas de trabajo (`is_workbench: true`), racks de equipo, recepción `U-100` y
  estantes de refacciones `U-101`…`U-112`.

## 5. Etiquetas (escaneo en piso)

Todas las etiquetas son **Code 128**, el mismo formato que ya usa el taller:

| Etiqueta | Contenido del código |
|---|---|
| Ubicación | su `code`, ej. `U-101` |
| Pieza con `sku` | el `sku` tal cual, ej. `7014 CTA/P4` |
| Pieza sin `sku` | `P-` + `part_id`, ej. `P-24` |

Los `sku` reales traen espacios, puntos, comas y diagonales: su lector debe aceptarlos sin
alterarlos. Un mismo `sku` puede ser de dos piezas: si pasa, pidan elegir cuál.

`labels/etiquetas-demo.pdf` trae las etiquetas de la demo final: recepción `U-100`, los
estantes `U-101`…`U-112` y las piezas de los modelos GROB MSP-04 y DOOSAN DNM400 (hoja carta,
Avery 5162). Para desarrollar, pueden escanearlas desde la pantalla con el celular.
