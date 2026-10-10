# Plan de diseño y desarrollo del Frontend — Almacén inteligente para taller

> **Fuentes.** No se pudo leer el PDF directamente (en esta máquina no está `pdftoppm` ni `pypdf`).
> El plan se basa en `context/reto.md` (el resumen del PDF que hizo el equipo), `kit/contract/README.md` (§3 y §5),
> `kit/contract/openapi.yaml`, `context/frontend.md` y `db/manejo de variables back y front.md`.
> Orden de autoridad: **contrato → PDF → notas**.
> La arquitectura es la que definió el equipo (FastAPI sirve `/ui`, HashRouter, estructura plana).

---

## Contexto

El backend (consumidor + API FastAPI en `:8000`) ya existe; **todavía no hay `frontend/`**. El frontend vale
**20 pts** (“Experiencia en piso”), es el escenario de la **demo de 5 minutos** y es donde se ven los **Extras
(15 pts)**: pronóstico, costo promedio, rotación, lag y errores del consumidor.

Decisiones tomadas:
- **Una sola app en React 18 + TS + Vite**, compilada y **servida por la misma FastAPI en `/ui`**. Un puerto, mismo
  origen, sin CORS y sin imagen nueva (solo se reusa la del backend).
- **El build entra a la imagen con una etapa de Node en `backend/Dockerfile`.** Así `docker compose up -d --build`
  sigue siendo un solo comando.
- **Sin túnel.** El HTTPS para la cámara del celular sale de un **certificado autofirmado** que se genera en la misma
  imagen. Un servicio `backend-https` en el compose reusa esa imagen y sirve la misma API con TLS en `:8443`. El
  `:8000` sigue en HTTP para las pruebas de contrato.
- **Sin archivos `.env` ni Docker nuevos.**

---

## 1. Resumen del reto

- El frontend solo habla con la API y **nunca calcula saldos**: los pide y los muestra, y los vuelve a pedir después
  de cada POST.
- El ciclo que se ve en pantalla: inspección aprobada → reserva → faltante + compra sugerida → llega la compra y surte
  → retiro escaneado → baja el stock.
- Prioridad: **Piso** > **Orden** (claridad por línea) > Almacén y Kardex > Tablero (extras).
- Los datos vienen sucios a propósito: piezas sin SKU, SKUs repetidos, `part_id: null` y `missing_quantity: null`.
  Siempre se muestran con texto explícito.

## 2. Requisitos y restricciones

### Rutas del contrato que se consumen (ya existen)

`GET /parts/{id}/availability` · `GET /parts/{id}/ledger` · `GET /work-orders/{code}/materials` · `GET /shortages` ·
`GET /reorder-suggestions` · `GET /unmatched-receipts` · `POST /unmatched-receipts/{id}/resolve` · `POST /issues` (409) ·
`POST /transfers` (409) · `POST /counts` (422)

### Rutas extra que necesita el frontend (**no existen**, así que las formas son una propuesta)

El contrato permite agregarlas. Van en `backend/app/main.py` y `backend/app/repo.py`, todas con
`{"items": [...]}` y `{"detail": "..."}`:

| Ruta | Respuesta propuesta | Base en el esquema |
|---|---|---|
| `GET /parts?q=` | `items: [{part_id, sku, name, unit_name, on_hand, reserved, available, open_shortages}]` | vista `part_availability` |
| `GET /scan/{código}` | `{kind: "location", location}` · `{kind: "part", parts: [...]}` (1 o varias) · 404 | `U-###` → `locations.code`; `P-n` → `part_id`; otro → `sku_norm = normalize_sku()` |
| `GET /locations` | `items: [{location_id, code, name, is_workbench}]` | `locations` |
| `GET /work-orders` | `items: [{work_order_id, code, stage, opened_at, lines, lines_missing}]` | `work_orders` + `work_order_materials` |
| `GET /parts/{id}/policy` | `{min_qty, max_qty}` (o null) | `part_policies` |
| `GET /dashboard` | `{kpis, rotation, forecast, consumer}` (ver Tablero) | movimientos, `processed_events`, `pending_events`, `outbox` |

Notas sobre estas rutas:
- `/scan/{código}` concentra la normalización del SKU en el backend: es la misma regla que relaciona las compras.
- El texto escaneado viaja con `encodeURIComponent`, porque los SKUs traen `/`.
- **Supuesto sobre el consumidor:** “lag y errores” se calculan con lo que hay en Postgres: pendientes, agotados o
  enviados a la DLQ, outbox sin publicar y hora del último evento procesado. El lag exacto contra Kafka exigiría que el
  consumidor guardara sus offsets; eso queda opcional.

### Cómo trata el frontend las respuestas reales (revisado contra `backend/app/repo.py` y `db/schema.sql`)

- **`reserved` por ubicación siempre llega en 0**, porque las reservas son a nivel pieza. La UI muestra “Reservado”
  solo en el total, nunca por ubicación.
- **El kardex trae `location_id` sin código.** Se traduce a `U-###` con `GET /locations`, que queda en caché.
- **Las sugerencias traen `work_order_ids`, no códigos.** Se traducen con la lista de `GET /work-orders`, en caché, para
  que los chips muestren y enlacen el código de la orden.
- **`available` puede ser negativo:** según el contrato, un conteo es la única forma de dejarlo negativo. La insignia
  “sin stock” usa `available ≤ 0`, y el número se muestra con su signo.
- **`opened_at` del faltante es opcional** en el contrato. Si no viene, se muestra “—”.
- **`unit_price` y `currency` de una recepción sin relacionar son opcionales.** El precio solo se formatea si vienen
  los dos. El backend agrega `reason` (`no_match` | `ambiguous`), que se muestra como “Sin coincidencia” o “Ambigua”.
- **Las etapas de la orden vienen en inglés** (`awaiting_quick_inspection` … `final_release`, según el CHECK del
  esquema). Se traducen con un diccionario en `api.ts`.
- **Las ubicaciones también pueden repetirse:** `locations.code` no es único en la base, porque las pruebas de contrato
  generan códigos repetidos. El selector de candidatos de Piso se hace genérico, para piezas y ubicaciones, por si la
  respuesta de `/scan` llega a traer varias. Es algo a confirmar con quien haga el backend.

### Restricciones

- snake_case del contrato de punta a punta.
- Cantidades enteras; el dinero es texto y solo se formatea; fechas en UTC que se pasan a `es-MX`,
  `America/Monterrey` solo al mostrarlas.
- `null` nunca se muestra como 0.
- La cámara solo funciona con HTTPS o en `localhost`, de ahí el `:8443` con certificado autofirmado.
- **Supuesto:** `issued_by` se captura una vez en Piso y se recuerda en `localStorage`.

## 3. Dirección visual (skill *frontend-design-direction*)

- **Propósito:** operar inventario sin errores.
- **Audiencia:** el técnico en piso (celular, una mano, a veces con guantes) y el almacenista o jefe de taller en
  computadora (revisa faltantes, compras y estado).
- **Tono:** **industrial**. Gris concreto, acero y **amarillo seguridad**. Denso y fácil de recorrer con la vista en
  computadora; grande y directo en Piso.
- **Detalle memorable:** todo código físico (`U-101`, `7014 CTA/P4`, `P-24`, `R061026012`) se pinta como **etiqueta**:
  un chip monoespaciado, igual al que se escanea. En Piso, cada paso confirmado queda como etiqueta y se puede tocar
  para corregirlo.
- **Tokens en `styles.css` (`:root`):**
  - Concreto (fondos), acero (bordes y texto secundario) y amarillo seguridad (acción primaria y foco).
  - Semánticos separados: rojo faltante o 409, naranja bajo mínimo, verde reservado o éxito.
  - Modo oscuro por `prefers-color-scheme`.
  - Siempre icono + texto, nunca solo color.
- **Tipografía:** `system-ui`, más `ui-monospace` con `tabular-nums` para códigos y cifras.
- **Tamaños:** filas de 40px en computadora; objetivos táctiles de ≥ 56px y texto de ≥ 18px en Piso.
- **Movimiento:** solo para el estado (paso confirmado, resultado, fila nueva). Respeta `prefers-reduced-motion`.
- **Se evita:** gradientes, tarjetas anidadas, hero, textos que explican la UI.

## 4. Rutas y pantallas (HashRouter)

`HashRouter` porque la app se sirve como estáticos desde FastAPI: recargar `/ui/#/ordenes/R061026012` nunca da 404 y
el servidor no necesita *fallback*.

| Ruta | Página | Contenido |
|---|---|---|
| `#/` | — | En celular (`pointer: coarse` y ancho < 768) va a `#/piso`; en computadora, a `#/tablero` |
| `#/piso?modo=retirar\|transferir\|contar` | `Piso.tsx` | Asistente por pasos con `Scanner` + `PartSearch` |
| `#/tablero?tab=inventario\|rotacion\|pronostico\|consumidor` | `Tablero.tsx` | KPIs y gráficas (`charts.tsx`) |
| `#/almacen?tab=faltantes\|compras\|existencias\|sin-relacionar&q=` | `Almacen.tsx` | Tablas operativas |
| `#/ordenes` y `#/ordenes/:code` | `Orden.tsx` | Lista de órdenes + avance por línea |
| `#/kardex/:partId` | `Kardex.tsx` | Saldo por ubicación, movimientos y política mín/máx |

**Barra superior (en `main.tsx`):**
- Navegación Piso · Tablero · Almacén · Órdenes.
- **Indicador del consumidor** (punto verde, ámbar o rojo, con texto), alimentado por `GET /dashboard` → `consumer`
  cada 15 s. Se pone ámbar con pendientes y rojo con eventos en la DLQ o sin eventos recientes con outbox atrasado.
- En celular, la barra se compacta (iconos con `aria-label`).

### Piso (celular), el corazón de la demo

| Modo | Pasos | Llamada |
|---|---|---|
| Retirar | ubicación → pieza → cantidad → orden | `POST /issues` |
| Transferir | origen → destino → pieza → cantidad | `POST /transfers` |
| Contar | ubicación → (pieza → contada)×N → **motivo** | `POST /counts` |

- Selector de modo arriba, con tres botones grandes.
- Riel de pasos con etiquetas que se pueden tocar para corregir.
- El paso de escaneo muestra el `Scanner` y, debajo, **siempre** la entrada manual y `PartSearch` (buscar por nombre
  cuando la pieza no tiene etiqueta).
- Cada lectura llama a `/scan/{código}`:
  - Si el tipo no es el esperado, avisa sin avanzar.
  - Si hay varias coincidencias, aparece una lista para elegir (nunca se toma la primera).
- Al elegir la pieza se muestra su disponible en esa ubicación como contexto (`availability`).
- Cantidad con un *stepper* grande e `inputmode="numeric"`. La orden se teclea, y se recuerda la última usada.
- Confirmar: el botón queda deshabilitado **y** una bandera en `useRef` corta el segundo toque antes de que React vuelva
  a pintar (sin dobles salidas).
- **201:** pantalla verde con el resumen del `Movement`, con “Otra pieza (misma ubicación)” y “Nuevo”.
  - En Contar, el 201 trae `adjustments`, que puede venir vacío. En ese caso se muestra “Sin diferencias: no se
    registró ajuste”.
- **409:** “No alcanza el saldo en esa ubicación”, con un botón para escanear otra ubicación, conservando lo demás.
- **422:** “Falta el motivo”.
- El formulario se limpia **solo después de un 201**.

### Orden (computadora)

- Panel izquierdo: lista de órdenes (`GET /work-orders`) con buscador por código, etapa traducida y una insignia
  “n líneas con faltante”.
- Panel derecho: `#/ordenes/:code` → tabla **Requerido · Reservado · Entregado · Falta**, con una barra de avance por
  línea.
  - `missing > 0` o `null` en rojo; `missing = 0` significa “no falta nada”.
  - `required: null` como “Por definir”; `part_id: null` como “Sin identificar”, sin enlace.
  - La pieza enlaza a `#/kardex/:id`.
- 404 muestra “Orden no encontrada”.
- *Polling* de 5 s: el jurado aprueba en el simulador y la reserva y el faltante aparecen solos.
- En celular, la lista y el detalle se apilan.

### Almacén (computadora)

- **Faltantes:**
  - Columnas: orden (enlace) · pieza (“Sin identificar” si es null) · falta (“Cantidad por definir” si es null) ·
    desde (“—” si no viene).
  - Filtros por orden y por pieza (`GET /shortages`).
- **Compras sugeridas:** pieza · SKU · cantidad sugerida · chips con las órdenes (los ids se traducen a códigos y
  enlazan a `#/ordenes/:code`) (`GET /reorder-suggestions`).
- **Existencias:**
  - `GET /parts?q=` con buscador e insignias: sin stock (`available ≤ 0`), bajo mínimo (si hay política) y con
    faltante.
  - La fila enlaza al Kardex.
- **Sin relacionar:**
  - Columnas: número de parte · descripción · motivo (sin coincidencia o ambigua) · cantidad · precio formateado ·
    fecha · orden.
  - **“Relacionar”** abre un diálogo con `PartSearch` y una ubicación opcional (por defecto U-100), y hace `POST …/resolve`.
  - Un 409 muestra “Ya estaba resuelta”.
  - Después se vuelve a pedir la lista.

### Kardex (`#/kardex/:partId`)

- Encabezado: nombre, SKU como etiqueta (o `P-<id>` si no tiene), on_hand · reserved · available y on_hand por
  ubicación (`availability`).
- **Política mín/máx** (`/parts/{id}/policy`), solo de lectura, con una insignia si `available < min`.
  - Si la pieza no tiene política, se muestra “Sin política”.
  - Hoy `part_policies` no se llena desde ningún tópico, así que este caso será el más común.
- Movimientos (`ledger`): fecha · tipo (diccionario es-MX) · cantidad con signo · ubicación (código vía `/locations`) ·
  referencia · **saldo**. Se muestran 50 con “ver más”.
- Un 404 muestra “Pieza no encontrada”.

### Tablero (computadora, Extras)

- **Inventario:** KPIs (piezas sin stock, faltantes abiertos, compras sugeridas, valor del inventario a **costo
  promedio**).
  - Las recepciones vienen en MXN y USD, así que el valor se muestra **por moneda**, sin convertir ni sumar en el
    navegador.
- **Rotación:** barras con las piezas más movidas y las que no tienen movimiento en N días.
- **Pronóstico:** líneas con el consumo semanal histórico y la proyección.
- **Consumidor:** eventos procesados, pendientes, enviados a la DLQ, outbox sin publicar y hora del último evento.
- **Supuesto:** el cálculo vive en `/dashboard` (backend) y el frontend solo dibuja.
- **Cada gráfica tiene su estado vacío** (“Sin datos todavía”). El dataset (`kit/data/events.jsonl`) **no trae
  salidas**, solo recepciones y aprobaciones, así que una serie basada en salidas puede llegar vacía hasta que se
  hagan retiros en la demo.

## 5. Arquitectura

```
FRONTEND (React 18 + TypeScript + Vite)          servido por FastAPI en /ui
│
├── main.tsx ─────────── HashRouter + barra superior (nav + estado del consumidor)
│     │                  "/" → Piso en celular · Tablero en computadora
│     ├── pages/         Piso · Tablero · Almacen · Orden · Kardex
│     ├── components/    Scanner · PartSearch · charts
│     ├── api.ts ─────── fetch + tipos + formatos + useApi
│     └── styles.css ─── tokens (concreto, acero, amarillo seguridad)
│
└── HTTP (JSON) ──▶ API FastAPI :8000 ──▶ PostgreSQL
```

- **Servir `/ui`:**
  - `main.py` monta `StaticFiles(directory="static", html=True)` en `/ui` (si el directorio existe) y `GET /` redirige
    a `/ui/`.
  - Vite usa `base: '/ui/'`.
- **Build:**
  - `backend/Dockerfile` pasa a ser *multi-stage*: la etapa `node:20-alpine` hace `npm ci && npm run build` de
    `frontend/` y la etapa Python copia `dist/` a `/app/static`.
  - En `docker-compose.yml`, `backend` y `consumer` cambian su `build` a `context: .` con
    `dockerfile: backend/Dockerfile`.
  - Se agrega un `.dockerignore` en la raíz (`node_modules`, `.git`, `kit/`, `frontend/dist`).
  - `npm ci` necesita `frontend/package-lock.json` en el repo.
- **Desarrollo:**
  - `npm run dev` en `frontend/`. En dev, `api.ts` usa como base `http://localhost:8000`; en producción, ruta
    relativa (`import.meta.env.DEV`, sin `.env`).
  - CORS ya está abierto en el backend.
- **Celular:**
  - `backend/Dockerfile` genera un certificado autofirmado al construir:
    `openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=inventario" -keyout /certs/key.pem -out /certs/cert.pem`.
    Se instala `openssl` con `apt-get` en la etapa Python.
  - En `docker-compose.yml`, el servicio `backend-https` usa la misma imagen `inventory-backend` con
    `command: uvicorn app.main:app --host 0.0.0.0 --port 8443 --ssl-keyfile /certs/key.pem --ssl-certfile /certs/cert.pem`,
    publica `8443:8443` y lleva el mismo `DATABASE_URL`.
  - En el celular, en la misma red Wi‑Fi, se abre `https://<ip-de-la-pc>:8443/ui/` y se acepta **una vez** el aviso del
    certificado. Es el mismo origen que la API: no hay CORS y no hace falta internet.
  - En la computadora, `http://localhost:8000/ui/` funciona sin certificado.
  - Si Windows bloquea el puerto, hay que permitir el `8443` en el firewall (lo hace el usuario).
- **Dependencias (mínimas):**
  - `react`, `react-dom`, `react-router-dom` y `zxing-wasm` (versión fijada).
  - El `.wasm` de ZXing se importa con `?url` de Vite y se pasa a `prepareZXingModule({ overrides: { locateFile } })`.
    Así viaja dentro de `dist/`, no depende de un CDN durante la demo y no hay que copiarlo a mano a `public/`. La ruta
    exacta del archivo se confirma al instalar.
  - Gráficas: SVG propio en `charts.tsx`, sin librería de gráficas.
  - Datos: sin React Query; un hook `useApi` pequeño en `api.ts`.
  - Desarrollo: `vitest`, `jsdom`, `@testing-library/react`, `eslint` (plantilla de Vite).

## 6. Estructura de archivos

```
frontend/
├── package.json · package-lock.json · vite.config.ts (base '/ui/') · index.html · tsconfig.json
└── src/
    ├── main.tsx             # HashRouter, rutas, TopBar (nav + ConsumerStatus), redirección de "/"
    ├── api.ts               # request<T>() + ApiError{status, detail}
    │                        # tipos del contrato y de las rutas extra (snake_case, `T | null`)
    │                        # funciones: getAvailability, getLedger, getMaterials, getWorkOrders, getShortages,
    │                        #   getSuggestions, getUnmatched, resolveReceipt, searchParts, scan, getLocations,
    │                        #   getPolicy, getDashboard, postIssue, postTransfer, postCount
    │                        # useApi(fn, deps, {pollMs}) → {data, error, loading, reload}
    │                        # formatos: fecha local, dinero (Intl, por moneda), etapas (enum en inglés → es-MX),
    │                        #   tipos de movimiento, motivo de sin relacionar, nulos → texto
    ├── styles.css           # tokens + base + utilidades (.tag, .badge, .table, .btn, .step-rail)
    ├── pages/
    │   ├── Piso.tsx         # useReducer del asistente; modos como configuración (pasos + llamada)
    │   ├── Tablero.tsx
    │   ├── Almacen.tsx      # incluye el diálogo Relacionar
    │   ├── Orden.tsx
    │   └── Kardex.tsx
    └── components/
        ├── Scanner.tsx
        ├── PartSearch.tsx
        └── charts.tsx       # LineChart, BarChart, StackedBar, Kpi
```

- Si una página pasa de ~300 líneas, sus piezas internas se extraen a `components/` (por ejemplo `StepRail`,
  `ResultPanel`, `CandidatePicker`), sin crear más capas.
- Las pruebas van al lado (`api.test.ts`, `Piso.test.tsx`).

## 7. Componentes reutilizables

| Componente | Responsabilidad |
|---|---|
| `Scanner` | Abre la cámara trasera. Usa `BarcodeDetector` si soporta `code_128` (Chrome en Android) y, si no, **ZXing WASM** (Safari en iOS no tiene `BarcodeDetector`). Detalles: **toma el código más cercano al centro** (en la hoja Avery hay varias etiquetas juntas); confirma cuando el mismo texto aparece en **2 de los últimos 5 cuadros**; ofrece zoom y linterna (`applyConstraints` si existen en `capabilities`); hace un **pitido** (WebAudio, que se inicia con el primer toque por la política de autoplay) y vibra al confirmar. Libera la cámara al desmontar o al ocultar la pestaña. Emite el texto **crudo**. |
| `PartSearch` | Buscador con *debounce* sobre `GET /parts?q=`; lista accesible (combobox) que devuelve la pieza elegida. Se usa en Piso (sin etiqueta), en Relacionar (Almacén) y en el filtro de faltantes. |
| `charts.tsx` | `Kpi`, `LineChart`, `BarChart` y `StackedBar` en SVG con tokens, ejes con `tabular-nums`, `<title>`, una tabla oculta para lector de pantalla y su **estado vacío**. |
| Clases en `styles.css` | `.tag` (etiqueta), `.badge` (estado), `.table` (con número a la derecha y apilada en < 640px), `.btn` / `.btn-primary` / `.btn-xl`, `.step-rail`, `.empty`, `.error`. |

## 8. Estado, formularios y API

- **`useApi`:**
  - Pide los datos al montar o cuando cambian sus dependencias.
  - Expone `reload()` y hace *polling* opcional (5 s en Orden y Faltantes, 15 s en el estado del consumidor).
  - El *polling* **se pausa con la pestaña oculta** (`visibilitychange`) y vuelve a pedir los datos al regresar.
  - Cancela con `AbortController` al desmontar o al cambiar de dependencias.
  - Después de cada POST exitoso, la página llama a `reload()` de lo que muestra. **Nunca resta a mano.**
- **Catálogos en caché de módulo:** `locations` y la lista de órdenes, que se usan para traducir ids a códigos (kardex
  y sugerencias). Se piden una vez por sesión, con `reload()` manual.
- **Piso:**
  - `useReducer` con `{modo, paso, ubicación, destino, pieza, cantidad, orden, líneas[], motivo, enviando, resultado}`.
  - `issued_by` y la última orden en `localStorage` (con try/catch).
- **Filtros y pestañas:** en la URL (`useSearchParams`, que funciona dentro del hash).
- **Errores:**

  | Código | Qué muestra |
  |---|---|
  | 404 | “No existe” en contexto |
  | 409 | “No alcanza el saldo en esa ubicación” (Relacionar: “Ya estaba resuelta”) |
  | 422 | El `detail` (en conteo, “Falta el motivo”) |
  | Red / 5xx | Banner con reintentar |

  Las mutaciones no se reintentan solas.
- **Validación en el cliente:**
  - Cantidad entera ≥ 1 (≥ 0 en conteo).
  - Motivo no vacío después de `trim`.
  - Código de orden con `^R\d{9}(-\d+)?$`: solo se avisa, porque gana el servidor.
- **Estados:** cada vista tiene carga (skeleton), vacío (con texto útil), error y éxito.

## 9. Convenciones

- Los datos que viajan van en snake_case. El código usa camelCase; componentes y tipos en PascalCase.
- Los opcionales se escriben `T | null`, nunca `?:`. La excepción son los campos que el contrato marca como no
  requeridos (`opened_at`, `unit_price`, `currency`, `code` de ubicación), que se tipan como opcionales.
- TypeScript en modo `strict`.
- **Accesibilidad:**
  - HTML semántico y `label` en cada campo.
  - Foco gestionado al avanzar de paso.
  - Resultado con `aria-live` y errores con `role="alert"`.
  - Contraste AA; las gráficas tienen texto alterno.
- **Responsive:** Piso es mobile‑first; las tablas se apilan por debajo de 640px; sin desbordamiento a 360px.
- **Rendimiento:**
  - `React.lazy` por página: el WASM de ZXing solo se carga en Piso.
  - El Kardex se pagina en el cliente.
  - *Debounce* de 250 ms en `PartSearch`.
- **Seguridad:**
  - Solo JSX (sin `dangerouslySetInnerHTML`).
  - El texto escaneado se trata como dato y viaja con `encodeURIComponent`, igual que el `id` de sin relacionar, que
    puede ser texto.
  - No hay secretos.
- **Calidad:** `npm run check` = `eslint` + `tsc --noEmit`.

## 10. Fases

| Fase | Prioridad | Tareas | Listo cuando |
|---|---|---|---|
| **0. Base** | P0 | Scaffold de Vite (`base '/ui/'`), `styles.css`, `api.ts`, `main.tsx`; montar `/ui` en FastAPI; Dockerfile multi-stage y `build.context` en el compose; servicio `backend-https` (:8443); **`Scanner` en un celular real por `https://<ip>:8443/ui/` con `kit/labels/etiquetas-demo.pdf`** | `docker compose up -d --build` sirve `/ui` y el celular lee `U-101` y `7014 CTA/P4` |
| **1. Backend extra I** | P0 | `/scan/{código}`, `/parts?q=`, `/locations` | El escaneo resuelve ubicación, pieza y SKU repetido |
| **2. Piso: Retirar** | P0 | Asistente, `PartSearch`, `POST /issues`, 201/409/404, bloqueo del doble toque | Retiro escaneado de punta a punta |
| **3. Orden** | P0 | `GET /work-orders` + `Orden.tsx` con *polling* | En la demo la reserva y el faltante aparecen solos |
| **4. Almacén + Kardex** | P1 | Las cuatro pestañas, Relacionar, Kardex con política (`/parts/{id}/policy`) | El kardex cuadra con el saldo; resolver una recepción mueve el stock |
| **5. Piso: Transferir y Contar** | P1 | Los otros dos modos; 409 y 422; “Sin diferencias” | Los tres modos funcionan |
| **6. Tablero (Extras)** | P2 | `/dashboard` (backend) + `charts.tsx` + estado del consumidor en la barra | KPIs, rotación, pronóstico y consumidor visibles (o su estado vacío) |
| **7. Pulido** | P1 | Accesibilidad, textos, 360px, README (URLs `/ui` en :8000 y :8443, aceptar el certificado), ensayo de la demo | Checklist completo |

**Riesgo a verificar en la fase 0:** que la cámara funcione en los celulares reales del equipo con el certificado
autofirmado. Chrome en Android y Safari en iOS dejan continuar tras el aviso. Si falla, la entrada manual y
`PartSearch` siguen funcionando, así que la demo no se cae.

## 11. Pruebas y criterios de aceptación

- **Vitest:**
  - Formatos de `api.ts`: nulos, dinero por moneda, fechas, etapas.
  - Reducer de Piso: avance, corrección de un paso y limpieza solo después de un 201.
  - Selección de `Scanner`: el código más centrado y la regla 2 de 5, como función pura.
- **Testing Library** (con `fetch` simulado):
  - Orden: rojo con `missing > 0` o `null`, sin rojo con `0`; 404 muestra “Orden no encontrada”.
  - Piso:
    - Un SKU repetido muestra la lista para elegir.
    - Un 409 conserva los datos.
    - El doble clic envía una sola petición.
    - El conteo sin motivo no se envía; un conteo sin diferencias muestra “Sin diferencias”.
  - Almacén: los chips de sugerencias muestran códigos, no ids.
- **Manual por `https://<ip>:8443/ui/`** (Android Chrome e iOS Safari): permiso de cámara, poca luz, linterna, varias
  etiquetas juntas, entrada manual.
- **Ensayo de la demo:** aprobar en el simulador (:8090) → ver la reserva y el faltante en Orden → registrar la compra
  → ver el faltante resuelto → retirar escaneando → ver el Kardex.
- **Aceptación:**
  - Un retiro toma ≤ 4 pasos y ≤ 6 toques escaneando.
  - Ningún `null` se pinta como 0.
  - Toda vista tiene sus estados de carga, vacío y error.
  - Lighthouse en Accesibilidad ≥ 90.
  - Las pruebas de contrato siguen pasando igual que antes.

## 12. Checklist final

- [ ] `docker compose up -d --build` sirve la app en `http://localhost:8000/ui/` y `https://<ip>:8443/ui/`, sin imágenes nuevas ni `.env`.
- [ ] `https://<ip>:8443/ui/` abre en el celular (aceptando el certificado) y la cámara lee Code 128 (centro, 2/5, zoom, linterna, pitido).
- [ ] Piso: Retirar, Transferir y Contar; entrada manual y `PartSearch` siempre disponibles.
- [ ] Los SKUs no se alteran; si hay varias coincidencias se pide elegir; `P-<id>` y `U-###` funcionan vía `/scan`.
- [ ] 409 y 422 son claros; no hay dobles salidas; el formulario se limpia solo después de un 201.
- [ ] Orden: lista + requerido · reservado · entregado · falta; faltantes en rojo; 404.
- [ ] Almacén: faltantes (con nulos explícitos), compras sugeridas con códigos de orden, existencias con alertas, sin relacionar con motivo y Relacionar.
- [ ] Kardex: saldo por ubicación, movimientos con código de ubicación y saldo corrido, política mín/máx o “Sin política”.
- [ ] Tablero: KPIs (costo por moneda), rotación, pronóstico y consumidor, con estados vacíos; indicador del consumidor en la barra.
- [ ] Los datos se vuelven a pedir después de cada POST; ningún saldo se calcula en el cliente.
- [ ] Las pruebas de contrato siguen pasando; el README explica `/ui` y el acceso HTTPS por `:8443`.

## Archivos que se tocan

- **Nuevo:** `frontend/` (estructura de §6) y `.dockerignore` en la raíz.
- **Backend:**
  - `backend/app/main.py`: montar `/ui`, redirigir `/` y las rutas extra.
  - `backend/app/repo.py`: las consultas de las rutas extra.
  - `backend/Dockerfile`: etapa Node, más `openssl` y el certificado autofirmado.
- **Configuración y documentación:**
  - `docker-compose.yml`: `build.context: .` para `backend` y `consumer`, y el servicio `backend-https` (misma imagen,
    :8443).
  - `README.md`.

## Verificación

1. Ejecutar `docker compose up -d --build` y abrir `http://localhost:8000/ui/` (comprobar que `#/` redirige según el
   dispositivo).
2. En `frontend/`: ejecutar `npm run check` y `npm test`.
3. Con el celular en la misma red Wi‑Fi, abrir `https://<ip-de-la-pc>:8443/ui/#/piso`, aceptar el certificado y
   escanear `kit/labels/etiquetas-demo.pdf`.
4. Ensayar la demo con el simulador en :8090.
5. Correr `docker compose run --rm contract-tests --api http://backend:8000`: el resultado debe ser igual que antes de
   los cambios.
