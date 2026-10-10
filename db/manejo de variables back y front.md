Manejo de variables en backend y frontend

Oct 10, 2026 · @Azu

Reglas generales

El contrato (kit/contract/) define cada nombre y cada tipo que viaja; backend y frontend lo respetan sin traducir. Los ejemplos van en TypeScript porque sirve en ambos lados, pero las reglas aplican a cualquier lenguaje.

1\.	Los nombres del contrato se usan tal cual, en snake\_case, de punta a punta. Base, eventos, API y pantallas dicen part\_id, nunca partId. Sin capa de traducción no hay errores de traducción.

2\.	Cantidades e IDs son enteros. Nunca float.

3\.	Dinero es texto decimal ("1850.00") en JSON y numeric en Postgres. Nunca number ni float.

4\.	Fechas en UTC con Z. Se guardan como timestamptz, se convierten a hora local solo al mostrarlas.

5\.	null significa algo concreto en cada campo (sección de nulos). Nunca se reemplaza por 0, "" o undefined.

Tipos

Cada dato tiene un solo tipo en cada capa; la tabla dice cuál.

Dato	Ejemplo	JSON (contrato)	Postgres	Backend (TS)	Frontend

IDs (part\_id, work\_order\_id, location\_id…)	305	integer	bigint	number	number

event\_id	"0b9f…c7aa"	string UUID	uuid	string	no se usa

Cantidades (quantity, on\_hand, delta…)	4, -1	integer	int	number (entero)	number

Dinero (unit\_price, unit\_cost)	"1850.00"	string decimal	numeric	string	string, solo se formatea

currency	"MXN"	enum	text + CHECK	unión 'MXN' | 'USD'	etiqueta

Fechas (occurred\_at, received\_at)	"2026-10-08T15:10:00Z"	string ISO UTC	timestamptz	string ISO	Date solo al mostrar

Código de orden	"R061026012"	string ^R\\d{9}(-\\d+)?$	text	string	string

sku / part\_number	"7014 CTA/P4"	string tal cual	text + sku\_norm	string sin alterar	string sin alterar

Código de ubicación	"U-101"	string ^U-\\d{3}$	text	string	string

issued\_by	7 o "ana"	integer o string	text	string	string

Cuidado con el driver de Postgres. node-postgres devuelve bigint y numeric como texto para no perder precisión. Los IDs del reto caben en un entero de JavaScript, así que se convierte bigint (OID 20) a number; numeric se deja como texto porque es dinero:

import { types } from 'pg';

types.setTypeParser(20, (v) => parseInt(v, 10)); // bigint → number

// numeric (1700) se queda como string: es dinero

Las vistas del esquema ya convierten las sumas a int, así que on\_hand, reserved y available llegan como número.

Nombres y nulos

Un mismo dato se llama igual en la tabla, el evento, la API y la pantalla.

•	Columnas, campos JSON y propiedades de objetos: snake\_case del contrato (work\_order\_code, missing\_quantity).

•	Variables locales y funciones del código: la convención del lenguaje (camelCase en TS), pero nunca para datos que viajan.

•	Tipos y componentes: PascalCase (Reservation, ShortageList).

•	Constantes: UPPER\_SNAKE\_CASE (RECEIVING\_LOCATION\_ID).

•	Cuando el contrato y la base difieren, el nombre del contrato manda en el JSON. Ejemplo: la columna movements.movement\_type sale como type, y movements.qty sale como quantity.

Cada null tiene un significado; no se rellena:

Campo	null significa	Qué se hace

part\_id en línea de inspección	Pieza sin identificar	Faltante unidentified, nunca reserva. Pantalla: "Sin identificar".

quantity en línea buy	El técnico no la capturó	Usar qty\_per\_unit del BOM.

qty\_per\_unit en BOM	El BOM tampoco la sabe	Faltante con missing\_quantity: null. Pantalla: "Cantidad por definir".

missing en materiales	Faltante abierto sin cantidad	Distinto de 0, que significa "no falta nada".

sku en pieza	Clave pendiente	La etiqueta usa P- + part\_id.

work\_order\_code en compra	Compra general	Surte faltantes por antigüedad.

action en línea	condition = ok	No crea necesidad.

En TypeScript, los opcionales se declaran como number | null, nunca con ?: el contrato dice que el campo siempre viene, a veces en null.

Enums y constantes

Los valores cerrados viven en un solo archivo (shared/domain.ts) que importan backend y frontend. Son los mismos que los CHECK de schema.sql; si uno cambia, cambian los dos en el mismo commit.

// shared/domain.ts — fuente única de valores cerrados

export const RECEIVING\_LOCATION\_ID = 100;          // U-100 (regla 11)

export const PART\_LOCK\_NAMESPACE = 1;              // pg\_advisory\_xact\_lock(1, part\_id)



export const MOVEMENT\_TYPES   = \['receipt','issue','transfer\_out','transfer\_in','adjustment'] as const;

export const RESERVATION\_STATUS = \['active','fulfilled','cancelled'] as const;

export const SHORTAGE\_STATUS  = \['open','resolved','closed'] as const;

export const SHORTAGE\_KIND    = \['insufficient','unidentified','unknown\_qty','not\_stocked'] as const;

export const MATCH\_STATUS     = \['matched','unmatched','resolved','not\_inventory'] as const;

export const PURPOSE          = \['restock','customer\_order'] as const;

export const CURRENCY         = \['MXN','USD'] as const;



export type MovementType = typeof MOVEMENT\_TYPES\[number];

export type ShortageKind = typeof SHORTAGE\_KIND\[number];

// … un type por cada lista



// Llaves de los eventos de salida (contrato, sección 2)

export const keyForOrder        = (code: string) => code;

export const keyForPart         = (part\_id: number) => `part:${part\_id}`;

export const keyForPurchaseLine = (line\_id: number) => `purchase\_line:${line\_id}`;

Las etiquetas en español para pantalla ("Activa", "Entregada", "Sin identificar") van en un diccionario aparte del frontend. El valor que viaja siempre es el del contrato.

Configuración

Todo lo que cambia entre la máquina de cada quien y la demo va en variables de entorno, con un .env.example en el repositorio. Nada de esto se escribe en el código.

Variable	Valor local	Para qué

DATABASE\_URL	postgres://inv:inv@localhost:5432/inventory	Conexión a Postgres

KAFKA\_BROKERS	localhost:19092 (o redpanda:9092 desde un contenedor)	Broker del kit

KAFKA\_GROUP\_ID	inventory-service	Grupo del consumidor; cambiarlo relee todo desde el inicio

TOPICS\_IN	shop.catalog,shop.work\_orders,shop.inspections,shop.purchasing	Tópicos de entrada

TOPIC\_OUT	inventory.events	Eventos de salida

TOPIC\_DLQ	inventory.dlq	Eventos que no se pudieron procesar

PORT	8000	Puerto de la API; las pruebas usan 8000

PENDING\_MAX\_ATTEMPTS	10	Reintentos antes de mandar a la DLQ

OUTBOX\_POLL\_MS	200	Cada cuánto publica el outbox

POLICIES\_SEED	./seed/part\_policies.csv	Archivo semilla de políticas

VITE\_API\_URL	http://localhost:8000	URL de la API para el frontend

RECEIVING\_LOCATION\_ID = 100 no es variable de entorno: es regla del contrato y vive en shared/domain.ts.

Backend

Cada evento y cada POST es una sola transacción; ninguna variable de estado vive en memoria entre mensajes.

async function handleEvent(env: Envelope, topic: string) {

&#x20; await db.tx(async (t) => {

&#x20;   // 1. Atajo: si ya se procesó, no hace nada (regla 19)

&#x20;   if (await alreadyProcessed(t, env.event\_id)) return;



&#x20;   // 2. Referencias faltantes → pendientes (regla 20). El evento NO se marca como

&#x20;   //    procesado: así el reintento lo vuelve a ejecutar completo.

&#x20;   const missing = await findMissingRefs(t, env);

&#x20;   if (missing) return enqueuePending(t, env, topic, missing); // INSERT … ON CONFLICT DO NOTHING



&#x20;   // 3. Locks por pieza, ascendente

&#x20;   for (const part\_id of partIdsOf(env).sort((a, b) => a - b))

&#x20;     await t.query('SELECT pg\_advisory\_xact\_lock($1,$2)', \[PART\_LOCK\_NAMESPACE, part\_id]);



&#x20;   // 4. Marcar como procesado (a prueba de carreras): si otro ya lo marcó, no hace nada

&#x20;   const fresh = await t.query(

&#x20;     `INSERT INTO processed\_events (event\_id, event\_type, topic)

&#x20;      VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1`,

&#x20;     \[env.event\_id, env.event\_type, topic]);

&#x20;   if (fresh.rowCount === 0) return;



&#x20;   // 5-7. Efectos, refresh\_reorder, outbox

&#x20;   await HANDLERS\[env.event\_type](t, env.data, env.occurred\_at);

&#x20;   await t.query('DELETE FROM pending\_events WHERE event\_id = $1', \[env.event\_id]); // si venía de pendientes

&#x20; });

}

Reglas para las variables del backend:

•	occurred\_at del sobre es la hora de negocio de todo lo que escribe el evento (created\_at, opened\_at, occurred\_at del movimiento). Para operaciones de la API, la hora es new Date().toISOString() del momento de la petición.

•	Valida la petición antes de abrir la transacción. Cantidades enteras ≥ 1, reason no vacío, IDs enteros. Falla → 422 {"detail": "..."}.

•	Lee los saldos dentro de la transacción, después del lock. Un available leído antes del lock puede estar viejo.

•	POST /issues: consume primero la reserva activa de esa orden y pieza (la más antigua). Lo que exceda la reserva debe caber en available. Si no alcanza el saldo de la ubicación o lo disponible → 409, sin mover nada.

•	Códigos HTTP: 200/201 éxito, 404 no existe, 409 conflicto (sin saldo, ya resuelto), 422 cuerpo inválido. Siempre {"detail": "mensaje"}.

•	Respuestas de lista: siempre {"items": \[...]}, aunque esté vacía.

•	Eventos de salida: source: "inventory", event\_version: 1, event\_id nuevo (lo genera la columna del outbox) y la key de shared/domain.ts. El publicador marca published\_at solo después de que Kafka confirma.

•	Errores irrecuperables: si un pendiente supera PENDING\_MAX\_ATTEMPTS, se publica el sobre original en inventory.dlq con su misma key y se borra de pending\_events. El consumo no se detiene.

Frontend

El frontend nunca calcula saldos: los pide a la API y los muestra. Su estado propio es solo lo que el usuario está capturando.

Estado.

•	Datos del servidor (availability, materials, shortages): se guardan tal como llegan y se vuelven a pedir después de cada POST exitoso. No se "restan" a mano.

•	Formulario de piso: location\_id, part\_id, quantity (entero), work\_order\_code, issued\_by. Se limpia solo después de un 201.

•	Mientras una petición está en curso, el botón queda deshabilitado. Un doble toque en el celular no debe mandar dos salidas.

Escaneo (Code 128).

•	El texto leído se guarda sin alterar: los sku traen espacios, puntos, comas y diagonales.

•	Si coincide con ^U-\\d{3}$, es una ubicación: se busca su location\_id.

•	Si coincide con ^P-(\\d+)$, es una pieza sin sku: part\_id = el número.

•	Si no, es un sku: se busca con la misma normalización del backend. Si regresa más de una pieza, la pantalla pide elegir; nunca se toma la primera.

•	Para esa búsqueda hace falta una ruta extra, por ejemplo GET /parts?sku=... y GET /locations?code=.... El contrato permite agregar rutas.

Formato al mostrar.

•	Dinero: se recibe como texto y solo se formatea, nunca se suma en el navegador. new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(Number(unit\_cost)).

•	Fechas: new Date(occurred\_at).toLocaleString('es-MX', { timeZone: 'America/Monterrey' }). Se guardan y envían en UTC.

•	null se muestra con texto explícito ("Sin identificar", "Cantidad por definir"), nunca como 0 ni vacío.

Errores. Se muestra el detail que manda la API. Un 409 en una salida significa "no alcanza en esa ubicación"; la pantalla sugiere escanear otra ubicación.

Errores comunes a evitar

Error	Consecuencia	En su lugar

parseFloat("1850.00") para sumar dinero	Centavos perdidos por redondeo binario	Sumar en Postgres (numeric) o con una librería decimal

Devolver "5" en vez de 5	Falla el JSON Schema de la prueba	Convertir bigint y usar las vistas con ::int

quantity ?? 0 en una línea buy	Se pierde el faltante sin cantidad	Usar qty\_per\_unit; si es null, faltante unknown\_qty

now() en un evento de entrada	La reconstrucción da otro kardex	occurred\_at del sobre

Normalizar el sku al guardarlo	La etiqueta escaneada ya no coincide	Guardar el original; comparar contra sku\_norm

Tomar la primera pieza de un sku repetido	Stock a la pieza equivocada	Revisión manual o pedir elegir

Leer available antes del lock	Dos órdenes se llevan la última pieza	Lock primero, lectura después

Un Set en memoria para event\_id	Reprocesa todo tras un reinicio	processed\_events en la misma transacción

Publicar a Kafka dentro del handler	Evento sin cambio, o cambio sin evento	Escribir en outbox; publica otro proceso

Restar el saldo en el frontend después de un POST	La pantalla miente si otro usuario movió algo	Volver a pedir los datos a la API





