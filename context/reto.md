# El reto: almacén inteligente para taller

Resumen del PDF del reto (Hackathon, Fernando Vazquez, 6 oct 2026). Si algo contradice a
`kit/contract/`, **gana el contrato**.

## Objetivo

Construir el **servicio de inventario** de un taller que repara equipo industrial (husillos,
motores eléctricos). El taller ya existe y manda eventos por Kafka; nosotros construimos el
inventario que los consume y responde existencias, reservas y faltantes en tiempo real. No
leemos la base del taller ni llamamos a su API: todo llega por los tópicos.

## El ciclo que hay que cerrar

1. Una **inspección aprobada** pide piezas para una orden de trabajo.
2. Si hay existencia, se **reserva** para esa orden.
3. Si no alcanza, se registra un **faltante** y se sugiere una compra.
4. Cuando llega la compra, entra al almacén y se surten las reservas pendientes.
5. El técnico **retira** la pieza contra su orden y el stock baja.

## Arquitectura

```
Simulador del taller → Redpanda (Kafka) → Servicio de inventario → inventory.events
                                                                  → API HTTP (:8000)
                                                                  → Pantallas
```

| Tópico de entrada | Eventos | `key` |
|---|---|---|
| `shop.catalog` | `part.upserted`, `location.upserted`, `bom.upserted` | `part:305`, `location:14`, `model:4` |
| `shop.work_orders` | `work_order.opened`, `.stage_changed`, `.deleted` | código de la orden |
| `shop.inspections` | `inspection.submitted`, `.approved`, `.rejected`, `.discarded`, `.voided` | código de la orden |
| `shop.purchasing` | `purchase.item_received` | `PR-` + número de requisición |

Todos usan el mismo sobre: `event_id`, `event_type`, `event_version`, `occurred_at`,
`source`, `key`, `data`.

**Garantías de entrega:** al menos una vez (llegan duplicados, hay que deduplicar por
`event_id`); orden solo por llave dentro de un tópico (entre tópicos no hay orden); retención
completa (se puede releer todo); lo que no se pueda procesar va a `inventory.dlq`.

## Reglas de negocio importantes

- **Libro mayor:** el stock nunca se edita; es la suma de movimientos inmutables.
- **Necesidad por (orden, `bom_line_id`):** solo `inspection.approved` crea necesidad. Una
  aprobación posterior de la misma línea **reemplaza** la cantidad (sube → reservar la
  diferencia; baja → liberar el excedente). Las líneas no mencionadas conservan su necesidad,
  así que una inspección `full` con `items: []` no cambia nada.
- **No reservan:** `action = repair` y `condition = ok` (pieza del cliente); `part_id: null`
  (faltante sin identificar).
- **`quantity: null` con `buy`:** usar `qty_per_unit` de la línea; si también es null,
  faltante con `missing_quantity: null` y sin reserva.
- **Reservar** `min(disponible, necesidad)`; el resto es faltante. `available` nunca baja de 0.
- **Compras:** `customer_order` no entra ni emite nada. `restock` se relaciona
  `part_number` ↔ `sku` (ignorando mayúsculas y espacios en los extremos); si no coincide, o
  coincide con varias piezas, queda como recepción sin relacionar. Entra a la ubicación
  **`U-100`** (`location_id` 100) y surte faltantes (primero la orden de `work_order_code`,
  luego los más antiguos).
- **Liberación:** `inspection.voided` y `work_order.deleted` cancelan reservas activas y
  cierran faltantes (no emiten evento).
- **Retiro (`/issues`):** consume primero la reserva de esa orden; si no alcanza el saldo de
  la ubicación, 409. **Conteo (`/counts`):** sin motivo, 422; es la única forma de dejar
  `available` negativo.
- **Desorden:** si un evento referencia algo que aún no se conoce (pieza, orden, línea de la
  lista de partes), se reintenta o se encola, no se descarta.
- **Reconstruible:** borrar la base y releer los tópicos debe dar el mismo `on_hand`. Al
  reconstruir, leer `shop.catalog` completo **antes** de los demás tópicos.
- **Concurrencia:** dos aprobaciones simultáneas no pueden reservar la misma última pieza.

## Lo que debe salir

**Eventos en `inventory.events`** (`source: "inventory"`): `stock.received`,
`stock.unmatched_receipt`, `stock.reserved`, `stock.shortage_detected`,
`stock.shortage_resolved`, `stock.issued`, `stock.transferred`, `stock.adjusted`,
`stock.reorder_suggested`. Nombres y campos exactos: `kit/contract/schemas/output/`.

**API HTTP (puerto 8000)**, rutas exactas en `kit/contract/openapi.yaml`:
`GET /parts/{id}/availability`, `GET /parts/{id}/ledger`, `GET /work-orders/{code}/materials`,
`GET /shortages`, `GET /reorder-suggestions`, `GET /unmatched-receipts`,
`POST /unmatched-receipts/{id}/resolve`, `POST /issues`, `POST /transfers`, `POST /counts`.
Las listas responden `{"items": [...]}` y los errores `{"detail": "..."}`.

**Pantallas:** almacén (existencias, faltantes, sugerencias), orden de trabajo (reservado,
entregado, pendiente), piso móvil (escanear ubicación y pieza para retirar, transferir o
contar, con la cámara del celular) y kardex de una pieza.

## Datos "sucios" a propósito

Los duplicados, el desorden y los datos incompletos del dataset están **a propósito**
(`kit/data/README.md`): piezas sin `sku`, piezas distintas con el mismo `sku`, líneas sin
`part_id` o sin cantidad, kits por `group_name` o por `name`, inspecciones que llegan antes
que su pieza o su orden, rechazos, anulaciones, órdenes dadas de baja con reservas vivas.

## Entregables

1. Repositorio con código y un README que lo levante **con un comando** sobre el kit.
2. Documento de decisiones de **máximo una página**: cómo relacionan compras con el catálogo,
   cómo manejan kits, cómo evitan reservas dobles y cómo garantizan idempotencia.
3. Demo en vivo de 5 minutos: el jurado aprueba una inspección en el simulador y mostramos la
   reserva, el faltante, la llegada de la compra y la salida escaneada.

## Evaluación (100 puntos)

| Criterio | Pts | Cómo se mide |
|---|---|---|
| Correctitud del libro mayor | 25 | Pruebas de contrato: saldos, idempotencia, sin negativos, reconstrucción |
| Integración con el taller | 25 | Pruebas de contrato: reservas, faltantes, recepciones, bajas |
| Experiencia en piso | 20 | Jurado: escaneo con celular, pocos pasos, claridad de la vista por orden |
| Decisiones justificadas | 15 | Jurado: documento de decisiones |
| Extras | 15 | Pronóstico de demanda, costo promedio, rotación, lag y errores del consumidor |

Niveles: **Base** (libro mayor, recepción, salida con escaneo, kardex, saldos por ubicación) →
**Intermedio** (reservas y faltantes, mínimos y máximos, conteo, recepciones sin relacionar) →
**Avanzado** (los extras).

## Reglas del hackathon

- No se modifica el simulador ni el formato de los eventos de entrada.
- Los eventos y rutas de la sección 5 del PDF respetan exactamente sus nombres y campos; se
  pueden agregar más, pero no cambiar esos.
- Lenguaje, base de datos y framework de pantallas son libres.
