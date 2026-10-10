# Dataset: `events.jsonl`

Seis semanas de operación de un taller de reparación de husillos (3 ago – 14 sep 2026),
en el orden en que se las entregaría el broker. Es lo mismo que reproduce el simulador; sirve
para desarrollar sin broker.

## Formato

Una línea por entrega:

```json
{"topic": "shop.inspections", "replay_at": "2026-08-05T19:02:11Z", "event": { ...sobre del evento... }}
```

- `topic`: el tópico donde llegaría.
- `replay_at`: cuándo lo entrega el simulador. Solo sirve para reproducir el ritmo; su
  servicio no debe depender de él.
- `event`: el evento tal cual, con el sobre del contrato (`contract/README.md`).

El archivo ya viene con duplicados y desorden: consumirlo de arriba abajo equivale a
consumir los tópicos.

## Qué trae

| | |
|---|---|
| Entregas | 1,742 (65 son reentregas de un `event_id` ya enviado) |
| Piezas | 255 al arrancar + 1 nueva a media operación |
| Ubicaciones | 67 (54 del taller + recepción `U-100` + 12 estantes de refacciones) |
| Modelos con lista de partes | 5 (de 4 a 64 líneas cada uno) |
| Órdenes de trabajo | 36 |
| Inspecciones aprobadas | 88 (rápidas y completas) |
| Líneas de compra recibidas | 854, de ellas 18 para clientes (`customer_order`) |

El catálogo de piezas, ubicaciones y listas de partes viene de un taller real, igual que la
proporción de piezas bien, dañadas y faltantes. Las órdenes, inspecciones, compras y precios
son sintéticos.

## Lo que van a encontrar

Todo esto está a propósito, porque así llegan los datos reales:

- Inspecciones rechazadas, descartadas y anuladas antes o después de aprobarse; órdenes dadas
  de baja con reservas vivas.
- Inspecciones completas sin piezas (`items: []`) y otras que vuelven a pedir una línea que
  ya pidió la rápida, con otra cantidad.
- Renglones a comprar sin cantidad y renglones sin pieza identificada.
- Kits por `group_name` y por `name`, y un grupo que se renombra a media operación.
- Compras con el número de parte escrito de varias formas, con números de proveedor que no
  existen en el catálogo, y piezas que comparten el mismo `sku`.
- Una pieza que recibe su `sku` semanas después de haberse comprado, y otra que se da de baja.
- Una pieza nueva cuyas inspecciones llegan **antes** que su `part.upserted`, y órdenes cuyas
  inspecciones llegan antes que su `work_order.opened`.
- El inventario inicial entra como una compra de arranque (sin orden) dos días antes de la
  primera orden.
