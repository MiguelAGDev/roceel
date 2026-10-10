# Almacén inteligente para taller

Servicio de inventario de un taller de reparación: lee lo que pasa en el taller por eventos (Redpanda/Kafka),
lleva un libro mayor de movimientos en Postgres, reserva piezas para las órdenes, registra faltantes y
sugiere compras. Expone una API HTTP en el puerto 8000 y publica sus propios eventos `stock.*`.

Reglas y contrato del reto: [`kit/contract/`](kit/contract/README.md) · explicación del reto y de cada parte: [`context/`](context/README.md).

## Levantarlo con un comando

Necesitas Docker. Desde la raíz del repositorio:

```bash
docker compose up -d --build
```

Levanta el kit (Redpanda, consola y simulador del taller), Postgres, la API y el consumidor.

| Qué | Dónde |
|---|---|
| API HTTP | http://localhost:8000 (documentación interactiva en `/docs`) |
| Consola de Redpanda (ver tópicos) | http://localhost:8080 |
| Panel del simulador | http://localhost:8090 |
| Postgres | `localhost:5432`, usuario `inv`, contraseña `inv`, base `inventory` |

Comprobar que está vivo:

```bash
curl http://localhost:8000/health          # {"db":true}
docker compose logs -f consumer            # debe verse "Catálogo primero" y luego los mensajes procesados
```

> Si ya tenías el kit corriendo por separado (`cd kit && docker compose up`), apágalo antes: comparten puertos.
> Debe haber **un solo** consumidor conectado. La API necesita al consumidor corriendo, porque es él quien
> publica en `inventory.events` los avisos que generan las operaciones de la API.

## Probarlo

Pruebas de contrato oficiales (con todo arriba):

```bash
docker compose run --rm contract-tests --api http://backend:8000
```

O desde tu máquina, con Python:

```bash
python -m pip install confluent-kafka jsonschema
python kit/contract-tests/run_tests.py
```

## Reconstruir desde cero

El estado se puede borrar y regenerar releyendo los tópicos. Al arrancar, el consumidor detecta una base vacía y
relee todo desde el inicio, leyendo primero `shop.catalog`. Para probarlo:

```bash
python kit/contract-tests/run_tests.py snapshot --out saldo.json
docker compose exec postgres psql -U inv -d inventory -c "TRUNCATE processed_events, pending_events, outbox, movements, reservations, shortages, needs, inspection_items, inspections, work_orders, purchase_receipts, reorder_suggestions, part_policies, bom_lines, models, locations, parts RESTART IDENTITY CASCADE"
docker compose restart consumer
python kit/contract-tests/run_tests.py compare --out saldo.json
```

(Solo se compara el `on_hand` por pieza y ubicación; las operaciones hechas por la API no vienen de los tópicos y no se reconstruyen.)

## Desarrollo sin Docker para el backend

Con el kit y Postgres ya levantados (`docker compose up -d redpanda postgres`), en dos terminales:

```bash
cd backend
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt     # (en Linux/Mac: .venv/bin/pip)
export DATABASE_URL=postgresql://inv:inv@localhost:5432/inventory          # (PowerShell: $env:DATABASE_URL = "...")
.venv/Scripts/python -m uvicorn app.main:app --port 8000                   # terminal 1: la API
.venv/Scripts/python -m app.consumer                                       # terminal 2: el consumidor
```

El consumidor desde tu máquina usa el broker `localhost:19092` (el valor por omisión). Variables en
[`backend/.env.example`](backend/.env.example).

## Para quien trabaja en el frontend

- La API está en `http://localhost:8000` y acepta llamadas desde otro origen (CORS abierto en desarrollo;
  para restringirlo, variable `CORS_ORIGINS` con orígenes separados por coma).
- Rutas, cuerpos y errores exactos: [`kit/contract/openapi.yaml`](kit/contract/openapi.yaml). Las listas responden
  `{"items": [...]}` y los errores `{"detail": "..."}` (404 no existe, 409 conflicto, 422 cuerpo inválido).
- La cámara del celular solo funciona con HTTPS o en `localhost`; si pruebas desde el teléfono, sirve el frontend
  por HTTPS y llama a la API por el proxy del servidor de desarrollo.
- Para ver datos: `GET /parts/{id}/availability`, `GET /shortages`, `GET /reorder-suggestions`,
  `GET /work-orders/{código}/materials`. Los ids y códigos reales salen del simulador (panel en :8090 o consola en :8080).
