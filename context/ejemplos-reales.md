# Lo que se ve en el Console (ejemplos reales)

Observaciones tomadas de Redpanda Console (http://localhost:8080) con el simulador corriendo.
Sirven para saber cómo llegan los eventos de verdad antes de escribir el consumidor.

## `shop.catalog`

- Unos 345 mensajes: piezas (`part.upserted`), ubicaciones (`location.upserted`) y listas de
  partes (`bom.upserted`). Llegan **primero**, al arrancar.
- La `key` es `part:66`, `location:43`, `model:4`.
- Ejemplo de pieza: `sku: "BCC055E"`, `family: "REFACCIÓN"`, `group: "SISTEMA DE
  RETROALIMENTACION"`, `unit: {id: 1, name: "PIEZA"}`, `image_url: null`, `active: true`.
- Ejemplo de ubicación: `location_id: 43`, `code: "U-043"`, `name: "Husillos Desensamble
  Rack 1 Nivel 3"`.

## `shop.inspections`

La `key` es el código de la orden (`R220826001`). Cosas que ya se ven en los datos reales:

- **Duplicado real.** El evento `2c5d3c7d-4319-4bd1-b64a-bc953b86cc5d`
  (`inspection.submitted`, inspección 469, orden `R220826001`) aparece **dos veces** en el
  topic. Es justo lo que hay que deduplicar por `event_id`.
- **Inspección completa sin piezas.** La inspección 466 (`kind: "full"`, orden `R210826000`)
  trae `"items": []` y aun así se aprueba (`approved_by: 15`). No genera reservas.
- **Varias aprobadas por orden.** `R210826000` tiene la inspección 465 (completa, con piezas)
  y la 466 (completa, vacía). `R220826001` tiene la 468 (rápida) y luego la 469 (completa).
  Ahí aplica la regla de que la necesidad se **reemplaza** por (orden, `bom_line_id`).
- **`submitted` vs `approved`.** El `approved` trae lo mismo que el `submitted` más
  `approved_by` y `approved_at`. Solo el `approved` dispara reservas.
- **Tamaño.** Un `approved` con piezas pesa unos 7 KiB; uno vacío, menos de 400 B.

## Dos tiempos distintos

- La columna **Timestamp** del Console es cuándo Kafka recibió el mensaje (10/10/2026).
- `occurred_at` dentro del evento es cuándo pasó en el taller (ej. `2026-08-24T16:56:13Z`).

No son el mismo orden. El contrato dice que `occurred_at` **no** es el orden de llegada.

## Filtros del Console

El cuadro "Filter table content" busca texto dentro de los eventos. Para encontrar una orden,
filtrar por su código (`R101026901`) en `shop.work_orders` o `shop.inspections`.
