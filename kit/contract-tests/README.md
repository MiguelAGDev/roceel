# Pruebas de contrato

Publican escenarios conocidos en los tópicos del taller y revisan los eventos que su
servicio publica en `inventory.events` y las respuestas de su API. Valen 50 de los 100
puntos: 25 por el libro mayor y 25 por la integración con el taller.

Cada corrida usa IDs, SKUs y códigos de orden propios. Pueden correrlas cuantas veces
quieran, con o sin el dataset cargado, sin reiniciar nada.

## Correrlas

Con el kit arriba (`docker compose up -d`) y su servicio escuchando en el puerto 8000:

```bash
docker compose run --rm contract-tests --api http://host.docker.internal:8000
```

O sin Docker (Python 3.12; `confluent-kafka` aún no tiene versión para 3.14):

```bash
uv run --python 3.12 --with confluent-kafka==2.6.1 --with jsonschema \
  contract-tests/run_tests.py --api http://localhost:8000
```

Opciones:

| Opción | Para qué |
|---|---|
| `--only reserva_faltante_compra_y_salida,concurrencia` | Correr solo algunos escenarios |
| `--timeout 20` | Segundos máximos de espera por cada resultado |
| `--settle 3` | Segundos de espera para confirmar que algo **no** pasó |

Mientras corren, conecten un solo servicio de inventario al broker: las pruebas leen
todo lo que llega a `inventory.events`.

## Qué revisan

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

Cada escenario explica en su docstring qué revisa. Además, todo
evento de salida debe cumplir su JSON Schema y traer la `key` que pide el contrato. Si no,
aparece al final del reporte.

## Reconstrucción (la corre el jurado)

```bash
docker compose run --rm -v "$PWD:/out" contract-tests snapshot --out /out/saldo.json --api http://host.docker.internal:8000
# el equipo borra su base y vuelve a consumir los tópicos desde el inicio
docker compose run --rm -v "$PWD:/out" contract-tests compare  --out /out/saldo.json --api http://host.docker.internal:8000
```

`compare` espera a que su servicio termine de releer (hasta `--rebuild-timeout`, 300 s) y
compara la existencia por pieza y ubicación de las piezas del dataset.
