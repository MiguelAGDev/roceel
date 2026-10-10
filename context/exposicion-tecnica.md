# Guion técnico para exponer el proyecto

## 1. Resumen para abrir la exposición

Estamos construyendo un servicio de inventario para un taller de reparación industrial. El
taller conserva sus sistemas y publica eventos; nuestro servicio consume esos eventos, mantiene
el inventario y las reservas, publica cambios de stock y ofrece una API para consultas y
operaciones de almacén. La solución busca cerrar el ciclo desde una inspección aprobada hasta
la reserva de materiales, la detección de faltantes, la recepción de compras y la salida de
piezas contra una orden de trabajo.

La ruta principal es:

```text
Simulador del taller → Redpanda/Kafka → consumidor de inventario → PostgreSQL
                                                ↓                    ↓
                                      inventory.events         API HTTP (:8000)
                                                                     ↓
                                                       interfaz de almacén/piso (pendiente)
```

El proyecto está organizado alrededor de un contrato versionado: los esquemas JSON, las reglas
del contrato y el OpenAPI del kit definen los formatos y comportamientos que el servicio debe
respetar. El kit es una dependencia del reto y no se modifica.

## 2. Estado verificado del repositorio

Esta descripción se basa en la lectura estática de los **67 archivos versionados** del
repositorio. No se presenta como una certificación de ejecución de las pruebas.

### Ya está implementado

- Backend Python con FastAPI, acceso a PostgreSQL y lógica compartida para inventario.
- Consumidor Kafka separado (`python -m app.consumer`) con deduplicación, eventos pendientes,
  reintentos y DLQ.
- Esquema relacional que guarda el catálogo, órdenes, inspecciones, necesidades, reservas,
  faltantes, recepciones, movimientos y outbox.
- API de disponibilidad, kardex, materiales por orden, faltantes, sugerencias, recepciones sin
  relacionar, salidas, transferencias y conteos.
- Simulador, dataset, contratos y pruebas suministrados en `kit/`.

### Todavía no está en el repositorio como producto propio

- No hay carpeta ni aplicación frontend. `context/frontend.md` describe la experiencia
  propuesta, pero no es una pantalla implementada.
- El `docker-compose.yml` raíz incluye el kit y PostgreSQL, y construye el contenedor `backend`;
  sin embargo, el `CMD` de `backend/Dockerfile` inicia únicamente Uvicorn. El consumidor Kafka
  no se inicia automáticamente con ese compose. Para la demo de extremo a extremo hay que
  arrancarlo por separado o agregar explícitamente su proceso al despliegue.
- El contrato exige consumir el catálogo completo antes de los demás tópicos al reconstruir.
  El consumidor actual se suscribe a todos los tópicos a la vez; la cola de pendientes ayuda
  con dependencias que llegan tarde, pero no implementa por sí sola la secuencia explícita de
  catálogo primero. No se debe afirmar que la reconstrucción cumple esa regla hasta corregirlo
  o verificar una estrategia equivalente.
- Las notas proponen discutir cómo inventariar la familia `SERVICIO` y si manejar kits como
  componentes, kit o ambos. El código trabaja con las líneas `buy` recibidas y no contiene una
  política explícita para excluir servicios ni una expansión de kits.
- Las políticas mínimo/máximo se contemplan en el esquema, pero no hay archivo semilla de
  políticas entre los archivos del repositorio.

Conviene exponer estos puntos como alcance pendiente, no como funcionalidades terminadas.

## 3. Decisiones técnicas y por qué

| Decisión | Qué resuelve | Por qué se eligió / beneficio |
|---|---|---|
| Usar eventos Kafka en vez de leer o llamar al sistema del taller | El servicio recibe el catálogo, órdenes, inspecciones y compras desde tópicos | Mantiene separados los sistemas y respeta el límite del reto: el inventario se alimenta de eventos, no de acceso directo a la base del taller |
| Tratar `kit/contract/` como fuente de verdad | Fija nombres, estructuras, tipos, claves, rutas y reglas | Evita que el backend y las pruebas interpreten distinto un evento; cuando una nota o el PDF difieren, se debe obedecer el contrato |
| PostgreSQL como almacenamiento persistente | Conserva eventos procesados, movimientos, reservas y estado de negocio | Sobrevive reinicios, permite transacciones y soporta reconstrucción e integridad referencial; la base no depende del estado en memoria del proceso |
| Libro mayor con movimientos inmutables | Las entradas y salidas se almacenan como movimientos con signo; el saldo se calcula sumándolos | Preserva auditoría e historia. Un error se corrige con un movimiento nuevo, en vez de reescribir el pasado |
| Vistas SQL para saldo y proyecciones | `stock_on_hand`, `part_availability`, `part_ledger` y `work_order_materials` derivan lecturas de los registros | Evita mantener varias copias de los saldos que podrían desincronizarse y mantiene el kardex trazable |
| Idempotencia por `event_id` dentro de la misma transacción | Registra el evento procesado y sus efectos juntos | Kafka entrega al menos una vez. Una reentrega no debe sumar stock ni volver a emitir sus efectos |
| Confirmar el offset después del commit en PostgreSQL | El consumidor no confirma el mensaje antes de persistir sus cambios | Si falla la base, el mensaje se procesa de nuevo; se evita marcar como consumido un evento cuyos efectos no llegaron a guardarse |
| Cola persistente de pendientes y DLQ | Conserva eventos que dependen de una pieza, orden o línea aún no recibida; errores agotados pasan a `inventory.dlq` | Entre tópicos no existe un orden global. Reintentar evita perder eventos válidos por llegar antes de sus dependencias; la DLQ separa lo que requiere investigación sin detener todo el consumo |
| Leer primero el catálogo al reconstruir | Se consume `shop.catalog` antes de órdenes, inspecciones y compras | Las referencias ya existen cuando se evalúan los eventos operativos; disminuyen falsas recepciones sin relacionar y errores de dependencia |
| Outbox transaccional para eventos de salida | El cambio de inventario y su evento se guardan en la misma transacción; un publicador envía luego el outbox | Evita confirmar una operación sin guardar el evento correspondiente, o publicar un evento de una operación que luego se revierte |
| Candado transaccional por pieza | Consumidor y API toman `pg_advisory_xact_lock` antes de ajustar stock/reservas | Serializa operaciones que compiten por la misma pieza y evita que dos órdenes reserven la misma existencia disponible |
| Tomar candados de varias piezas en orden ascendente | Conteos y aprobaciones pueden tocar múltiples piezas | Da un orden común de bloqueo y reduce el riesgo de interbloqueos |
| Necesidad identificada por `(work_order_id, bom_line_id)` y reemplazada | Una nueva aprobación actualiza la necesidad de la línea, sin duplicarla | Modela inspecciones rápidas/completas sobre el mismo requerimiento. Las líneas omitidas se conservan; una aprobación vacía no borra necesidades previas |
| Reservas por pieza, no por ubicación | `available = on_hand - reserved`; la API informa `reserved = 0` por ubicación | La reserva protege la cantidad total de la pieza, mientras las ubicaciones describen dónde está físicamente. La decisión coincide con el contrato |
| Registrar liberaciones sin evento dedicado | Anular inspección o dar de baja una orden libera la reserva y cierra faltantes | El contrato indica que la API refleja la liberación y que no se emite un evento de liberación |
| Relacionar compra con SKU normalizado, sin quitar signos | Se comparan mayúsculas y espacios exteriores/interiores redundantes; no se eliminan puntos, guiones o diagonales | Tolera diferencias inocuas de formato, pero evita asociar números distintos por una normalización demasiado agresiva |
| Mandar coincidencias ambiguas a revisión manual | Si hay cero o más de una pieza para el número de parte, queda recepción sin relacionar | Los SKU no son únicos; elegir automáticamente una pieza equivocada altera el stock. La relación manual permite resolverlo con intención |
| Recibir reabasto en `U-100` y distinguir `customer_order` | El reabasto aumenta el inventario y puede surtir faltantes; compra para cliente no ingresa al stock | Separa materiales propios de almacén de materiales comprados para revender/entregar a un cliente |
| Surtir primero la orden indicada y después los faltantes más antiguos | Una recepción relacionada puede atender una orden preferente y continuar FIFO con las demás | Respeta la relación explícita de la compra y define un desempate predecible para el resto |
| cantidades enteras e importes decimales exactos | La unidad es la unidad de la pieza; los importes se mantienen en decimal y se serializan como texto | Evita fracciones de unidades de inventario y errores de redondeo de `float` en precios |
| Fechas de negocio UTC | Eventos y respuestas utilizan timestamps UTC terminados en `Z` | Facilita comparar y ordenar datos entre sistemas y evita dependencias de zona horaria local |
| Mantener el simulador y contratos del kit intactos | El kit provee broker, simulador, casos y eventos | Son entradas de prueba y referencia común; modificarlos haría menos confiable la validación frente al reto |

### Casos que se deben explicar con cuidado

- Una línea `action = repair` no se convierte en compra/reserva. `condition = ok` tampoco crea
  necesidad. Una línea con `part_id: null` se reporta sin reserva.
- Si `quantity` es `null`, se usa `qty_per_unit` del BOM; si también es `null`, se mantiene un
  faltante de cantidad desconocida y no se reserva.
- Una recepción `customer_order` se conserva como recibo no inventariable. Una recepción de
  `restock` sin coincidencia única se deja pendiente de resolución manual.
- El conteo es la operación de ajuste de inventario y exige motivo. El esquema de base de datos
  protege el saldo por ubicación contra negativos al confirmar una transacción.
- `occurred_at` es tiempo del evento de negocio, no orden de llegada. La secuencia de Kafka y
  las colas resuelven entrega/orden; el kardex se consulta en orden cronológico.

## 4. Recorrido recomendado para una demo de cinco minutos

1. Mostrar en el simulador una orden y aprobar su inspección.
2. Consultar los materiales de la orden y explicar qué quedó reservado y qué quedó como
   faltante.
3. Mostrar disponibilidad total y por ubicación, y el kardex para explicar la trazabilidad.
4. Registrar una compra de reabasto relacionada; mostrar entrada a `U-100` y cómo cubre
   faltantes.
5. Ejecutar una salida contra la orden y mostrar el movimiento de egreso y la reducción del
   saldo.

La secuencia depende de que el consumidor Kafka esté activo además de la API. Si la demo usa
interfaz propia, esa parte requiere implementar y levantar el frontend, que hoy solo está
descrita en las notas.

## 5. Inventario revisado, archivo por archivo

### Raíz

| Archivo | Función y motivo |
|---|---|
| `.gitignore` | Excluye entornos, caches, archivos locales y artefactos generados; conserva explícitamente el dataset y contratos del kit |
| `LICENSE` | Define las condiciones de uso y distribución del repositorio |
| `docker-compose.yml` | Ensambla el kit, PostgreSQL y el backend para levantar el entorno. Nota: no inicia el consumidor, ver estado arriba |

### Backend

| Archivo | Función y motivo |
|---|---|
| `backend/Dockerfile` | Empaqueta Python 3.12, instala dependencias y ejecuta FastAPI/Uvicorn |
| `backend/requirements.txt` | Declara FastAPI, Uvicorn, psycopg y el cliente Kafka |
| `backend/app/__init__.py` | Marca `app` como paquete Python |
| `backend/app/config.py` | Centraliza URLs, brokers, tópicos, grupo, polling y reintentos configurables por entorno |
| `backend/app/consumer.py` | Consume eventos, valida sobres, llama handlers, confirma offsets tras persistir, activa reintentos y publica la DLQ |
| `backend/app/db.py` | Crea el pool PostgreSQL, da acceso a transacciones y ofrece ping de salud |
| `backend/app/dlq.py` | Publica eventos originales no procesables y drena pendientes agotados a `inventory.dlq` |
| `backend/app/domain.py` | Define constantes de dominio, ubicación de recepción, formato UTC, errores de dominio y funciones de claves |
| `backend/app/handlers.py` | Traduce cada evento de entrada a cambios de catálogo, orden, inspección, compra, necesidad y liberación |
| `backend/app/ledger.py` | Implementa candado por pieza, consulta de saldo y movimientos; registra recepciones y su evento |
| `backend/app/main.py` | Expone FastAPI, endpoints HTTP y traducción de errores al formato `{ "detail": ... }` |
| `backend/app/outbox.py` | Guarda/publica notificaciones de salida con patrón outbox |
| `backend/app/pending.py` | Hace idempotencia, mantiene dependencias pendientes, respeta orden por llave y agenda reintentos |
| `backend/app/repo.py` | Implementa consultas y escrituras de API en transacciones, como salidas, transferencias y conteos |
| `backend/app/reservations.py` | Calcula disponibilidad, reserva/libera, sincroniza faltantes y surte necesidades pendientes |
| `backend/app/schemas.py` | Valida cuerpos de escritura con Pydantic, cantidades y motivo obligatorio de conteo |

### Contexto y base de datos

| Archivo | Función y motivo |
|---|---|
| `context/README.md` | Índice de las notas y prioridad de fuentes de verdad |
| `context/reto.md` | Resume objetivo, ciclo de negocio, contrato, entregables y evaluación |
| `context/kit.md` | Explica el kit, sus servicios, dataset, escaneo y comandos de prueba |
| `context/database.md` | Expone principios y decisiones requeridas de persistencia |
| `context/backend.md` | Resume consumidor, reglas de negocio, API y orden de implementación |
| `context/frontend.md` | Especifica la interfaz propuesta, escaneo y rutas necesarias; es diseño, no código frontend |
| `context/ejemplos-reales.md` | Registra observaciones de eventos reales, duplicados y diferencias de tiempo |
| `context/exposicion-tecnica.md` | Este guion: decisiones justificadas, estado verificado y mapa del repositorio |
| `db/schema.sql` | Define tablas, constraints, funciones y vistas para el libro mayor, reservas, outbox y proyecciones |
| `db/manejo de variables back y front.md` | Define convenciones de nombres, tipos, nulos, enums y variables de entorno, con ejemplos TypeScript de referencia; algunas variables y archivos sugeridos allí todavía no existen en el backend Python actual |

### Kit: guía, infraestructura, simulador y pruebas

| Archivo | Función y motivo |
|---|---|
| `kit/README.md` | Instrucciones generales para levantar Redpanda, Console, simulador y pruebas |
| `kit/docker-compose.yml` | Define broker, Console, simulador y perfil para correr contract-tests |
| `kit/simulator/Dockerfile` | Construye el simulador en Python 3.12 junto con el dataset |
| `kit/simulator/requirements.txt` | Fija `confluent-kafka` para que el simulador use el cliente disponible en el entorno del reto |
| `kit/simulator/simulator.py` | Crea tópicos, reproduce el dataset y publica acciones nuevas desde un servidor HTTP de demo |
| `kit/simulator/panel.html` | Interfaz del simulador para órdenes, inspecciones y recepciones; no es el frontend del inventario |
| `kit/data/README.md` | Describe origen, volumen y casos intencionales del dataset |
| `kit/data/events.jsonl` | Secuencia de eventos de seis semanas para reproducir el escenario del taller |
| `kit/labels/etiquetas-demo.pdf` | Etiquetas Code 128 para probar el escaneo de demostración |
| `kit/tools/validate_events.py` | Valida un JSONL de eventos contra schemas y tópicos definidos |
| `kit/contract-tests/Dockerfile` | Construye la imagen aislada de pruebas de contrato |
| `kit/contract-tests/requirements.txt` | Fija dependencias de las pruebas (`confluent-kafka`, `jsonschema`) |
| `kit/contract-tests/README.md` | Explica escenarios, comandos, reconstrucción y límites de ejecución |
| `kit/contract-tests/run_tests.py` | Publica escenarios al broker y contrasta API y eventos de salida con el contrato |

### Kit: contrato compartido

| Archivo | Qué fija |
|---|---|
| `kit/contract/README.md` | Sobre, tópicos/llaves y las reglas funcionales exactas de entrada y salida |
| `kit/contract/openapi.yaml` | Rutas, cuerpos, respuestas y formatos de la API HTTP mínima |
| `kit/contract/schemas/index.json` | Mapea cada `event_type` a su tópico y schema |
| `kit/contract/schemas/common.schema.json` | Tipos compartidos: IDs, cantidades, fechas, importes, unidades y líneas de inspección |

#### Schemas de entrada

| Archivo | Evento que valida |
|---|---|
| `kit/contract/schemas/input/part.upserted.schema.json` | Alta/actualización del catálogo de piezas |
| `kit/contract/schemas/input/location.upserted.schema.json` | Alta/actualización de ubicaciones |
| `kit/contract/schemas/input/bom.upserted.schema.json` | Modelo y lista de materiales/BOM |
| `kit/contract/schemas/input/work_order.opened.schema.json` | Apertura de orden de trabajo |
| `kit/contract/schemas/input/work_order.stage_changed.schema.json` | Cambio de etapa de orden |
| `kit/contract/schemas/input/work_order.deleted.schema.json` | Baja de orden |
| `kit/contract/schemas/input/inspection.submitted.schema.json` | Envío de inspección aún sin aprobar |
| `kit/contract/schemas/input/inspection.approved.schema.json` | Aprobación que puede generar necesidades |
| `kit/contract/schemas/input/inspection.rejected.schema.json` | Rechazo de inspección |
| `kit/contract/schemas/input/inspection.discarded.schema.json` | Descarte de inspección |
| `kit/contract/schemas/input/inspection.voided.schema.json` | Anulación de inspección aprobada |
| `kit/contract/schemas/input/purchase.item_received.schema.json` | Recepción de línea de compra |

#### Schemas de salida

| Archivo | Evento que valida |
|---|---|
| `kit/contract/schemas/output/stock.received.schema.json` | Entrada de stock por recepción relacionada |
| `kit/contract/schemas/output/stock.unmatched_receipt.schema.json` | Recepción que requiere relación manual |
| `kit/contract/schemas/output/stock.reserved.schema.json` | Reserva de existencias para una orden |
| `kit/contract/schemas/output/stock.shortage_detected.schema.json` | Detección o cambio de faltante |
| `kit/contract/schemas/output/stock.shortage_resolved.schema.json` | Cantidad de faltante surtida |
| `kit/contract/schemas/output/stock.issued.schema.json` | Salida de stock contra una orden |
| `kit/contract/schemas/output/stock.transferred.schema.json` | Transferencia entre ubicaciones |
| `kit/contract/schemas/output/stock.adjusted.schema.json` | Ajuste derivado de un conteo |
| `kit/contract/schemas/output/stock.reorder_suggested.schema.json` | Sugerencia de reabasto creada o modificada |

## 6. Validación y preparación para presentar

El repositorio incluye pruebas que cubren recepción, idempotencia, saldos no negativos,
transferencias, conteo, kardex, reservas, faltantes, anulaciones, baja de orden, eventos
desordenados y concurrencia. Las pruebas también validan schemas de salida y claves Kafka.

Comandos documentados por el kit:

```bash
docker compose up -d --build
docker compose exec backend python -m app.consumer
docker compose run --rm contract-tests --api http://host.docker.internal:8000
```

El segundo comando debe quedarse ejecutando en una terminal aparte. Antes de probar la
reconstrucción, además hay que resolver la limitación de consumo catálogo-primero descrita
arriba.

Para esta revisión se contrastaron los archivos y las decisiones documentadas con el código,
el esquema de base de datos y los contratos. **No se ejecutó Docker ni la suite de contrato en
esta revisión**, así que no debe afirmarse que los escenarios pasan hasta correrlos con el
consumidor y la API activos.
