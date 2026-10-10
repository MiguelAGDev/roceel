# Kit de arranque: almacén inteligente para taller

Todo lo que necesitan para construir el servicio de inventario del reto.

```bash
docker compose up -d
```

Con eso levantan:

| Qué | Dónde |
|---|---|
| Broker Redpanda (API de Kafka) | `localhost:19092` desde su máquina · `redpanda:9092` desde un contenedor |
| Redpanda Console, para ver los tópicos | http://localhost:8080 |
| Simulador del taller | http://localhost:8090 |

El simulador crea los tópicos y reproduce seis semanas de operación del taller, una hora
simulada por segundo (unos 17 minutos). Para otro ritmo usen `SPEED=0 docker compose up -d`
(sin pausas) o `SPEED=600`. Para empezar de cero, `RESET=1` borra y recrea los tópicos.

## Qué hay

| Carpeta | Qué es |
|---|---|
| `contract/` | El contrato: JSON Schema de cada evento, la API en OpenAPI y las reglas que revisan las pruebas. **Empiecen aquí.** |
| `data/events.jsonl` | Las mismas seis semanas en un archivo, para desarrollar sin broker |
| `simulator/` | El simulador y su panel |
| `contract-tests/` | Las pruebas de contrato (50 de los 100 puntos) |
| `labels/etiquetas-demo.pdf` | Etiquetas Code 128 de la demo (estándar en `contract/README.md` §5) |
| `tools/validate_events.py` | Valida cualquier archivo de eventos contra el contrato, incluidos los suyos |

## El panel del simulador

En http://localhost:8090 el jurado (y ustedes, para probar) pueden:

1. Recibir un equipo: abre una orden de trabajo de cualquiera de los 5 modelos.
2. Capturar su inspección pieza por pieza y aprobarla, rechazarla, descartarla o anularla.
3. Cambiar la etapa de la orden o darla de baja.
4. Registrar la llegada de una compra, con o sin código de orden.

Es el flujo de la demo final: el jurado aprueba una inspección aquí y ustedes muestran la
reserva, el faltante, la llegada de la compra y la salida escaneada.

## Pruebas de contrato

```bash
docker compose run --rm contract-tests --api http://host.docker.internal:8000
```

Detalle en [`contract-tests/README.md`](contract-tests/README.md).
