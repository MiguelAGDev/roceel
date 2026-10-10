# Consideraciones principales de la base de datos

Postgres. Esto es solo lo que importa decidir **antes de programar**; el esquema completo se
define en equipo en la hora 0-1. El contrato (`kit/contract/`) gana si hay diferencias.

## Principios

1. **Libro mayor.** El stock nunca se edita: `on_hand` es la suma de movimientos inmutables.
   Un error se corrige con otro movimiento.
2. **Idempotencia en la misma transacción.** Cada evento inserta su `event_id` en una tabla de
   eventos procesados *y* aplica sus efectos. Si el `event_id` ya existe, se descarta sin
   cambiar nada ni emitir salidas. Una tabla (no un set en memoria) sobrevive reinicios y
   permite reconstruir.
3. **Un lock por pieza** (`pg_advisory_xact_lock(part_id)`) antes de reservar, surtir, retirar
   o contar. Lo usan el consumidor y la API. Si se tocan varias piezas, tomarlos en orden de
   `part_id` para evitar interbloqueos. Esto evita que dos aprobaciones reserven la misma
   última pieza.
4. **Eventos de salida desde un outbox**, escritos en la misma transacción que el cambio, y un
   publicador los manda a `inventory.events`. Nunca hay un cambio sin su evento.
5. **Reconstruible.** Todo se puede borrar y regenerar releyendo los tópicos, con
   `shop.catalog` completo antes que los demás.
6. **Eventos que llegan antes de lo que referencian** (pieza, orden, línea de la lista de
   partes) van a una cola de pendientes y se reintentan; lo que falla tras reintentar va a
   `inventory.dlq`.

## Entidades principales

Catálogo (piezas, ubicaciones, listas de partes) · órdenes e inspecciones · **necesidades**
vigentes por (orden, `bom_line_id`) · **movimientos** y saldos · reservas · faltantes ·
recepciones sin relacionar · sugerencias de compra · eventos procesados / pendientes / outbox.

## Consideraciones que afectan el diseño

- **La necesidad se guarda por (orden, `bom_line_id`) y se reemplaza**, no se suma. Una
  aprobación posterior de la misma línea ajusta la reserva por diferencia.
- **Las reservas son por pieza, no por ubicación.** `available` = suma de `on_hand` de todas
  las ubicaciones menos lo reservado activo. En la API, `reserved` va en 0 por ubicación.
- **`sku` no es único** en el catálogo (hay piezas distintas con el mismo `sku`): la relación
  de compras debe tratar más de una coincidencia como "sin relacionar".
- **Recepción en `U-100`** (`location_id` 100) para las compras `restock`.
- **`available` nunca baja de 0**, salvo un ajuste de conteo.
- **Liberar** (`inspection.voided`, `work_order.deleted`) cancela reservas y cierra faltantes;
  no emite evento.

## Preguntas abiertas (decidir en la hora 0-1)

- **Kits:** ¿componentes, kit o ambos? Propuesta inicial: solo componentes.
- **Familia `SERVICIO`:** ¿se inventaría? Propuesta inicial: no; faltante sin reservar.
- ¿Saldos como tabla (más rápido) o como vista sobre los movimientos (más simple, no se
  desincroniza)?
