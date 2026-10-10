# Backend: contexto y qué hay que hacer

Python 3.12 + FastAPI + Postgres + `confluent-kafka`, en `backend/`. Es la parte que más
puntos da: **50 de 100** salen de las pruebas de contrato (libro mayor 25, integración 25).
Reglas exactas: `kit/contract/README.md`. Si algo contradice al PDF, gana el contrato.

## Qué es

Un solo servicio con dos mitades que comparten la base de datos:

1. **Consumidor de Kafka:** lee los cuatro tópicos del taller, procesa cada evento y publica
   los eventos de salida en `inventory.events`.
2. **API HTTP (puerto 8000):** consultas y operaciones (retirar, transferir, contar).

## Consumidor

- **Catálogo primero.** Al arrancar y al reconstruir, leer `shop.catalog` completo *antes* de
  los demás tópicos; si no, las compras llegan antes que sus piezas y se van a revisión manual.
- **Idempotencia.** Cada evento se procesa en una transacción que inserta su `event_id` y
  aplica sus efectos. Duplicado → no cambia nada ni emite salidas.
- **Desorden.** Si un evento referencia algo que aún no existe (pieza, orden, línea de la
  lista de partes), va a una cola de pendientes y se reintenta cuando llegue.
- **Errores.** Lo que falla tras reintentar va a `inventory.dlq` sin detener el consumo.
- **Salidas** con el mismo sobre del contrato, `source: "inventory"` y la `key` que pide
  `kit/contract/README.md` §2.

### Qué hace cada evento de entrada

| Evento | Qué hacer |
|---|---|
| `part.upserted`, `location.upserted`, `bom.upserted` | Guardar o actualizar catálogo y listas de partes |
| `work_order.opened` / `.stage_changed` | Guardar la orden y su etapa |
| `work_order.deleted` | Liberar sus reservas activas y cerrar sus faltantes |
| `inspection.submitted`, `.rejected`, `.discarded` | No mueven inventario |
| `inspection.approved` | Fijar la necesidad por (orden, `bom_line_id`), reservar y registrar faltantes |
| `inspection.voided` | Liberar reservas y cerrar faltantes de las líneas cuya necesidad vigente venía de esa inspección |
| `purchase.item_received` | `customer_order`: ignorar. `restock`: relacionar con el catálogo, dar entrada en `U-100` y surtir faltantes |

## Reglas que más puntos mueven

- **Necesidad por (orden, `bom_line_id`) y se reemplaza**, no se suma: si sube, reservar la
  diferencia; si baja, liberar el excedente. Las líneas no mencionadas conservan su necesidad
  (por eso una `full` con `items: []` no cambia nada).
- **No reservan:** `action = repair`, `condition = ok` y `part_id: null` (este último es un
  faltante sin identificar).
- **`quantity: null` con `buy`:** usar `qty_per_unit` de la línea; si también es null,
  faltante con `missing_quantity: null` y sin reserva.
- **Reservar** `min(disponible, necesidad)`; el resto es faltante.
- **Relación de compras:** `part_number` ↔ `sku` ignorando mayúsculas y espacios en los
  extremos. Sin coincidencia, o con varias piezas, queda sin relacionar y emite
  `stock.unmatched_receipt`.
- **Entrada** en `U-100` (`location_id` 100); surtir primero la orden de `work_order_code`
  (si sigue viva) y luego los faltantes más antiguos. Cada surtido emite `stock.reserved` y
  `stock.shortage_resolved`.
- **`available` nunca baja de 0**, ni con aprobaciones simultáneas: un lock por pieza.
- **Sugerencias:** `suggested_quantity` ≥ suma de lo que falta, con las órdenes que lo piden;
  emitir `stock.reorder_suggested` cuando nace o cambia.

## API (nombres y formas fijos)

Detalle completo en `kit/contract/openapi.yaml`. Las listas responden `{"items": [...]}` y los
errores `{"detail": "..."}`.

| Ruta | Notas |
|---|---|
| `GET /parts/{id}/availability` | `on_hand`, `reserved`, `available` totales y por ubicación |
| `GET /parts/{id}/ledger` | Kardex del más reciente al más antiguo, con `balance` corrido |
| `GET /work-orders/{code}/materials` | Por línea: requerido, reservado, entregado, falta |
| `GET /shortages` | Faltantes abiertos; filtros `work_order_code` y `part_id` |
| `GET /reorder-suggestions` | Sugerencias vigentes |
| `GET /unmatched-receipts`, `POST /unmatched-receipts/{id}/resolve` | Resolver registra la entrada como si hubiera coincidido |
| `POST /issues` | Baja saldo y consume primero la reserva de la orden; **409** si no alcanza |
| `POST /transfers` | Emite `stock.transferred`; **409** si no alcanza |
| `POST /counts` | Un ajuste por cada diferencia; **422** si falta el motivo |

### Rutas extra para el frontend (permitido agregar, no cambiar las del contrato)

El frontend necesita listar piezas con buscador y totales, traducir un código escaneado (SKU,
`P-24` o `U-101`) a `part_id` o `location_id` (puede haber varias piezas con el mismo SKU) y
obtener los nombres de las ubicaciones. Acordar las formas con quien haga las pantallas.

## Orden de trabajo sugerido

1. Esquema de la base y conexión (`context/database.md`), Postgres en el compose.
2. Consumidor con idempotencia y catálogo primero → pasar `recepcion_basica`, `idempotencia`.
3. Libro mayor: entrada, salida, transferencia, conteo, kardex → `salida_sin_negativos`,
   `transferencia_y_conteo`, `kardex`.
4. Reservas y faltantes → `reserva_faltante_compra_y_salida`, `lineas_que_no_reservan`,
   `necesidad_se_reemplaza`, `concurrencia`.
5. Liberaciones, compras para cliente y sin relacionar, desorden → `rechazo_y_anulacion`,
   `baja_de_orden`, `compra_para_cliente`, `recepcion_sin_relacionar`, `desorden`.
6. Sugerencias de compra y, si hay tiempo, políticas mínimo/máximo.
7. Reconstrucción desde cero (borrar la base y releer) y `DECISIONS.md`.

## Cómo probar

Con el kit arriba y el servicio en el puerto 8000 (detalle en `context/kit.md`):

```bash
docker compose run --rm contract-tests --api http://host.docker.internal:8000
```

Mientras corren, conectar **un solo** servicio de inventario al broker.
