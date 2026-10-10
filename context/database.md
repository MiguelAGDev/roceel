# Idea de la base de datos

Postgres. Borrador para la hora 0-1 del hackathon: se ajusta entre todos antes de programar.
Todo lo de abajo es **propuesta**, no contrato; el contrato está en `kit/contract/`.

## Principios

1. **Libro mayor.** El stock nunca se edita. `on_hand` es la suma de `movements`.
2. **Idempotencia en la misma transacción.** Cada evento se procesa en una transacción que
   inserta su `event_id` en `processed_events` *y* aplica sus efectos. Si el `INSERT` choca
   (clave duplicada), se descarta el evento sin tocar nada ni emitir salidas.
3. **Un lock por pieza.** `pg_advisory_xact_lock(part_id)` antes de reservar, surtir, retirar
   o contar. El consumidor y la API usan el mismo lock. Si una operación toca varias
   piezas, se toman en orden ascendente de `part_id` para evitar interbloqueos.
4. **Los eventos de salida salen de un outbox**, escritos en la misma transacción que el
   cambio, y un publicador los manda a `inventory.events`. Así nunca hay un cambio sin su
   evento ni un evento sin su cambio.
5. **Reconstruible.** Todo (incluido `processed_events`) se puede borrar y regenerar
   releyendo los tópicos, leyendo `shop.catalog` primero.

## Tablas

### Control del consumidor
| Tabla | Campos clave | Para qué |
|---|---|---|
| `processed_events` | `event_id` PK, `topic`, `event_type`, `processed_at` | Deduplicar |
| `pending_events` | `id`, `event_id`, `topic`, `key`, `payload` jsonb, `reason`, `attempts`, `next_retry_at` | Eventos que referencian algo que aún no llega (pieza, orden, línea de la lista de partes) |
| `outbox` | `id`, `key`, `event_type`, `payload` jsonb, `published_at` null | Salidas pendientes de publicar |

Lo que falla tras reintentar va a `inventory.dlq` y se marca en `pending_events`.

### Catálogo (lo llena `shop.catalog`)
| Tabla | Campos clave |
|---|---|
| `parts` | `part_id` PK, `sku` null, `sku_norm` (mayúsculas y sin espacios en los extremos), `name`, `family`, `group`, `subgroup`, `unit`, `active` |
| `locations` | `location_id` PK, `code` único, `name`, `is_workbench`, `active`. Debe existir `U-100` con id 100 (recepción) |
| `models` | `model_id` PK, `model_name`, `brand` |
| `bom_lines` | `bom_line_id` PK, `model_id`, `part_id` null, `name`, `group_name` null, `unit`, `qty_per_unit` null, `sort_order` |

`sku_norm` no es único: hay piezas distintas con el mismo `sku`.

### Taller (lo llenan `shop.work_orders` y `shop.inspections`)
| Tabla | Campos clave |
|---|---|
| `work_orders` | `work_order_id` PK, `code` único, `model_id`, `department`, `stage`, `received_at`, `deleted_at` null |
| `inspections` | `inspection_id` PK, `work_order_id`, `kind`, `status` (`submitted`/`approved`/`rejected`/`discarded`/`voided`), `approved_at` |
| `needs` | **PK (`work_order_id`, `bom_line_id`)**, `inspection_id` (la aprobación vigente), `inspection_item_id`, `part_id` null, `name`, `required_qty` null |

`needs` guarda la **necesidad vigente** de cada línea. Una aprobación posterior de la misma
línea la **reemplaza**; no la suma. Una línea que no se menciona conserva su necesidad.
Solo entran líneas con `action = buy`.

### Inventario
| Tabla | Campos clave |
|---|---|
| `movements` | `movement_id` bigserial, `part_id`, `location_id`, `quantity` (con signo), `type` (`receipt`/`issue`/`transfer_out`/`transfer_in`/`adjustment`), `reference`, `unit_cost`, `currency`, `source_event_id` null, `occurred_at`. **Solo se inserta, nunca se actualiza.** |
| `balances` | PK (`part_id`, `location_id`), `on_hand`. Proyección de `movements`, actualizada en la misma transacción |
| `reservations` | `reservation_id` PK, `work_order_id`, `bom_line_id`, `inspection_item_id`, `part_id`, `quantity`, `fulfilled_quantity`, `status` (`active`/`fulfilled`/`cancelled`) |
| `shortages` | `shortage_id` PK, `work_order_id`, `bom_line_id`, `inspection_item_id`, `part_id` null, `name`, `missing_quantity` null, `status` (`open`/`closed`), `opened_at`, `closed_at` |
| `unmatched_receipts` | `id` PK, `purchase_line_id`, `part_number`, `description`, `quantity`, `unit_price`, `currency`, `work_order_code` null, `received_at`, `status` (`pending`/`resolved`), `resolved_part_id` null |
| `reorder_suggestions` | `part_id` PK, `suggested_quantity`, `work_order_ids` int[], `updated_at` |
| `part_policies` | `part_id` PK, `min_qty`, `max_qty`, `reorder_qty`, `lead_time_days` (opcional, nivel intermedio) |

Las reservas se hacen **por pieza**, no por ubicación. Por eso `available` se calcula como
`SUM(balances.on_hand) - SUM(reservations.quantity - fulfilled_quantity)` de las activas, y
`reserved` va en 0 por ubicación en la API (lo permite `kit/contract/openapi.yaml`).

## Invariantes (las pruebas de contrato las revisan)

- `available = on_hand - reserved` nunca baja de 0, salvo por un ajuste de conteo.
- Retirar (`/issues`) consume primero la reserva de esa orden y pieza; cuando se entrega toda,
  la reserva pasa a `fulfilled`. Si no alcanza el saldo de la ubicación: 409 y no se mueve nada.
- Reservar = `min(available, necesidad)`; lo que falta es un faltante abierto.
- Al subir una necesidad se reserva solo la diferencia; al bajar, se libera el excedente.
- Liberar (`inspection.voided`, `work_order.deleted`) cancela las reservas activas y cierra
  los faltantes. No emite evento.
- `purpose = customer_order` no toca el inventario ni emite nada.
- Recepción `restock`: se busca `sku_norm = upper(trim(part_number))`. Si coincide con **una
  sola** pieza, entra a `U-100` y surte faltantes (primero la orden de `work_order_code`,
  luego los más antiguos). Si no coincide, o coincide con varias, queda en
  `unmatched_receipts` y emite `stock.unmatched_receipt`.

## Preguntas abiertas (decidir en la hora 0-1)

- **Kits:** ¿inventariamos los componentes, el kit o ambos? Propuesta inicial: solo componentes.
- **Familia `SERVICIO`** (cromado, rectificado): ¿se inventaría? Propuesta inicial: no; se
  reporta como faltante sin reservar.
- ¿`balances` como tabla o como vista sobre `movements`? Tabla es más rápida; la vista es más
  simple y no puede desincronizarse.
- Reglas de relación de SKU más listas que "mayúsculas y espacios" (documentarlas en
  `DECISIONS.md`).
