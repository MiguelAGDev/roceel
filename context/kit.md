# El kit de arranque (`kit/`)

Todo lo que da el reto para empezar. **No se modifica**: el simulador y el formato de los
eventos de entrada son intocables, y las pruebas de contrato esperan su comportamiento.

## Qué hay

| Carpeta / archivo | Qué es |
|---|---|
| `kit/docker-compose.yml` | Redpanda (Kafka), Redpanda Console, simulador y pruebas de contrato |
| `kit/contract/` | **Empezar aquí.** JSON Schema de cada evento (`schemas/input`, `schemas/output`), la API en `openapi.yaml` y las reglas exactas que revisan las pruebas (`README.md`) |
| `kit/data/events.jsonl` | Las seis semanas de operación en un archivo, para desarrollar sin broker |
| `kit/simulator/` | El simulador del taller y su panel web |
| `kit/contract-tests/` | Las pruebas de contrato (50 de los 100 puntos) |
| `kit/tools/validate_events.py` | Valida un archivo de eventos contra los schemas |
| `kit/labels/etiquetas-demo.pdf` | Etiquetas Code 128 para la demo con escaneo real |

## Levantarlo

Desde `kit/` y con Docker Desktop abierto ("Engine running"):

```bash
cd kit
docker compose up -d
```

| Qué | Dónde |
|---|---|
| Broker Redpanda | `localhost:19092` desde la máquina · `redpanda:9092` desde un contenedor |
| Redpanda Console (ver tópicos) | http://localhost:8080 |
| Panel del simulador | http://localhost:8090 |

El simulador crea los tópicos, publica primero el catálogo y luego reproduce seis semanas de
operación a una hora simulada por segundo (unos 17 minutos). Variables:

- `SPEED=0 docker compose up -d` → sin pausas. `SPEED=600` → otro ritmo.
- `RESET=1` → borra y recrea los tópicos para empezar de cero.

## El panel del simulador (`:8090`)

Es el flujo de la demo. Desde ahí se puede:

1. Recibir un equipo (abre una orden de cualquiera de los 5 modelos).
2. Capturar su inspección pieza por pieza y **aprobarla**, rechazarla, descartarla o anularla.
3. Cambiar la etapa de la orden o darla de baja.
4. Registrar la llegada de una compra, con o sin código de orden.

## Pruebas de contrato

Con el kit arriba y nuestro servicio escuchando en el puerto 8000:

```bash
docker compose run --rm contract-tests --api http://host.docker.internal:8000
```

Sin Docker (Python 3.12; `confluent-kafka` no tiene versión para 3.14):

```bash
uv run --python 3.12 --with confluent-kafka==2.6.1 --with jsonschema \
  contract-tests/run_tests.py --api http://localhost:8000
```

Opciones: `--only escenario1,escenario2`, `--timeout 20`, `--settle 3`. Conectar **un solo**
servicio de inventario al broker mientras corren, porque leen todo `inventory.events`.

| Libro mayor (25) | Integración con el taller (25) |
|---|---|
| `recepcion_basica` | `reserva_faltante_compra_y_salida` |
| `idempotencia` | `lineas_que_no_reservan` |
| `salida_sin_negativos` | `compra_para_cliente` |
| `transferencia_y_conteo` | `recepcion_sin_relacionar` |
| `kardex` | `necesidad_se_reemplaza` |
| | `rechazo_y_anulacion` |
| | `baja_de_orden` |
| | `desorden` |
| | `concurrencia` |

Además, cada evento de salida debe cumplir su JSON Schema y traer la `key` que pide el
contrato. **Reconstrucción** (la corre el jurado): `snapshot` guarda el saldo, el equipo
borra su base y relee los tópicos, y `compare` verifica que el `on_hand` por pieza y
ubicación sea el mismo. Las reservas no se comparan.

## El dataset (`kit/data/events.jsonl`)

1,742 entregas (65 son reentregas de un `event_id`), 255 piezas, 67 ubicaciones (54 del
taller, recepción `U-100` y estantes `U-101`…`U-112`), 5 modelos con lista de partes, 36
órdenes, 88 inspecciones aprobadas y 854 líneas de compra (18 `customer_order`). El inventario
inicial entra como una compra de arranque sin orden, dos días antes de la primera orden.

Una línea por entrega: `{"topic": ..., "replay_at": ..., "event": {...}}`. `replay_at` solo
sirve para el ritmo del simulador; el servicio no debe depender de él.

## Etiquetas (escaneo en piso)

Todas son **Code 128**:

| Etiqueta | Contenido |
|---|---|
| Ubicación | su `code`, ej. `U-101` |
| Pieza con `sku` | el `sku` tal cual, ej. `7014 CTA/P4` |
| Pieza sin `sku` | `P-` + `part_id`, ej. `P-24` |

Los `sku` reales traen espacios, puntos, comas y diagonales: el lector debe aceptarlos sin
alterarlos. Si un mismo `sku` es de dos piezas, hay que pedir elegir cuál.

## Validar un archivo de eventos

```bash
uv run --with jsonschema kit/tools/validate_events.py kit/data/events.jsonl
```

Sirve también para validar los eventos que genere nuestro servicio.
