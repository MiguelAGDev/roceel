# Stack tecnológico: qué usamos y por qué

## Introducción

Construimos un servicio de inventario para un taller de reparación industrial. El taller no
nos da acceso a su base de datos: publica eventos (catálogo, órdenes, inspecciones, compras) y
nuestro servicio los consume, mantiene existencias y reservas, publica los cambios de stock y
ofrece una API para las operaciones de almacén.

```text
Simulador del taller → Redpanda (Kafka) → Consumidor Python → PostgreSQL
                                                ↓                 ↓
                                        inventory.events     API FastAPI (:8000)
```

A continuación, cada tecnología y la razón de elegirla.

---

## 1. Redpanda / Apache Kafka — mensajería por eventos

**Qué es:** Kafka es una plataforma de mensajería basada en tópicos; Redpanda es una
implementación compatible con el protocolo de Kafka, más ligera de levantar.

**Para qué la usamos:** Recibir los eventos del taller (`shop.catalog`, órdenes, inspecciones,
compras) y publicar los nuestros (`inventory.events`, `inventory.dlq`).

**Por qué:**
- Desacopla los sistemas: el taller y el inventario no se llaman entre sí ni comparten base de
  datos, que es justo la restricción del reto.
- Los mensajes quedan guardados en el tópico, así que podemos reconstruir el inventario
  volviendo a leerlos desde el inicio.
- Las llaves de mensaje garantizan orden por entidad (por ejemplo, por orden de trabajo).
- Redpanda viene incluido en el kit del reto, junto con **Redpanda Console** para ver tópicos y
  mensajes durante la demo.

## 2. Python 3.12 — lenguaje del backend

**Por qué:**
- Es el lenguaje del simulador y de las pruebas del kit, así que compartimos ecosistema y
  cliente Kafka con el entorno del reto.
- Desarrollo rápido y bibliotecas maduras para HTTP, PostgreSQL y Kafka.

## 3. FastAPI + Uvicorn — API HTTP

**Qué es:** FastAPI es un framework web para Python; Uvicorn es el servidor que lo ejecuta.

**Para qué la usamos:** Exponer disponibilidad, kardex, materiales por orden, faltantes,
sugerencias de reabasto, salidas, transferencias y conteos.

**Por qué:**
- Genera documentación OpenAPI automáticamente, lo que facilita comparar nuestra API con el
  `openapi.yaml` del contrato.
- Validación de entradas integrada mediante Pydantic.
- Rendimiento alto y código breve.

## 4. Pydantic — validación de datos

**Para qué la usamos:** Validar los cuerpos de las peticiones de escritura (cantidades
enteras positivas, motivo obligatorio en conteos, etc.).

**Por qué:** Los datos inválidos se rechazan antes de tocar la base de datos, con mensajes de
error claros en formato `{ "detail": ... }`.

## 5. PostgreSQL — base de datos

**Para qué la usamos:** Guardar catálogo, órdenes, inspecciones, necesidades, reservas,
faltantes, recepciones, movimientos, eventos procesados y el outbox.

**Por qué:**
- **Transacciones ACID:** un evento, sus movimientos de stock y su evento de salida se guardan
  todos juntos o ninguno.
- **Integridad:** llaves foráneas y restricciones que impiden saldos negativos por ubicación.
- **Vistas SQL** (`stock_on_hand`, `part_availability`, `part_ledger`): el saldo se calcula a
  partir de los movimientos en lugar de guardarse en varias copias que podrían desincronizarse.
- **Candados consultivos** (`pg_advisory_xact_lock`): evitan que dos operaciones reserven la
  misma existencia al mismo tiempo.
- Persistencia real: el estado sobrevive reinicios del servicio.

## 6. psycopg — conexión Python ↔ PostgreSQL

**Por qué:** Es el driver estándar de PostgreSQL para Python; usamos su pool de conexiones para
atender varias peticiones sin abrir una conexión nueva cada vez.

## 7. JSON Schema y OpenAPI — contrato del reto

**Para qué los usamos:** Los esquemas JSON definen la forma exacta de cada evento de entrada y
salida; el OpenAPI define las rutas y respuestas de la API.

**Por qué:** Son la fuente de verdad compartida. El backend, el simulador y las pruebas
interpretan los datos de la misma manera, y las pruebas de contrato (con la biblioteca
`jsonschema`) validan automáticamente que lo que publicamos cumple el formato.

## 8. Docker y Docker Compose — despliegue

**Para qué los usamos:** Levantar Redpanda, Console, el simulador, PostgreSQL y el backend con
un solo comando.

**Por qué:**
- El entorno es idéntico en cualquier computadora del equipo y en la evaluación.
- No hay que instalar Kafka ni PostgreSQL localmente.
- Las pruebas de contrato corren en un contenedor aislado.

> Nota para la demo: el contenedor del backend arranca solo la API. El consumidor se inicia
> aparte con `docker compose exec backend python -m app.consumer`.

## 9. Patrones de diseño que apoyan a estas tecnologías

No son bibliotecas, pero explican cómo usamos Kafka y PostgreSQL juntos:

| Patrón | Por qué |
|---|---|
| **Idempotencia por `event_id`** | Kafka puede entregar un mensaje más de una vez; registrar el ID evita sumar stock dos veces |
| **Confirmar offset después de guardar** | Si la base falla, el mensaje se vuelve a procesar en lugar de perderse |
| **Outbox transaccional** | El cambio de inventario y el evento que lo anuncia se guardan en la misma transacción; después se publican a Kafka |
| **Cola de pendientes + DLQ** | Si un evento llega antes que la pieza u orden de la que depende, se reintenta; si nunca se puede procesar, va a `inventory.dlq` sin detener el consumo |
| **Libro mayor inmutable (kardex)** | Cada entrada o salida es un movimiento nuevo; nada se sobrescribe, así se conserva la auditoría |

## 10. Escaneo con códigos de barras Code 128

El kit incluye etiquetas Code 128 para identificar piezas y ubicaciones. Se eligió porque es un
estándar alfanumérico que leen casi todos los lectores de almacén.

---

## Cierre

En resumen: **Kafka** para comunicarnos con el taller sin acoplarnos, **PostgreSQL** para
garantizar que el inventario sea correcto y auditable, **FastAPI** para exponerlo de forma
validada y documentada, y **Docker** para que todo se levante igual en cualquier lugar. El
contrato en **JSON Schema/OpenAPI** asegura que todas las piezas hablen el mismo idioma.

Pendiente: la interfaz de almacén/piso está diseñada pero aún no implementada.
