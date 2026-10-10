# Frontend: contexto y vistas

React + Vite, en `frontend/`. **Una sola app web**, no hay app nativa: la vista del piso es
una página que se abre en el navegador del celular. Vale 20 puntos del jurado (escaneo con
celular, pocos pasos, claridad de la vista por orden).

## Cómo se trabaja sin esperar al backend

Todo lo que necesita el frontend ya está en `kit/contract/openapi.yaml` (rutas, cuerpos y
respuestas). Se construyen las pantallas contra **respuestas falsas** con esas formas y se
cambia a la API real cuando esté lista. Las listas responden `{"items": [...]}` y los errores
`{"detail": "..."}`. En desarrollo, Vite hace proxy de `/api` al puerto 8000.

## Vistas

Son cuatro pantallas. El kardex no es una página aparte: vive dentro del inventario.

### 1. Inventario (dashboard, escritorio)
Pestañas: **Existencias · Faltantes · Sugerencias · Sin relacionar**.

- **Existencias:** tabla de piezas con buscador por nombre o SKU. Cada fila muestra
  `on_hand`, `reserved`, `available` y una insignia de alerta. Al abrir una fila
  (**fila expandible**) se carga, solo en ese momento:
  - saldo por ubicación (`GET /parts/{id}/availability`)
  - historial o **kardex** (`GET /parts/{id}/ledger`): fecha, tipo, cantidad, referencia y
    saldo corrido. Mostrar los últimos 10-20 con "ver más".
- **Alertas** (reglas, no IA): 🔴 `available = 0` · 🟠 `available` bajo el mínimo (si hay
  políticas) · 🔴 hay faltantes abiertos. Un contador arriba: "12 piezas sin stock".
- **Faltantes:** orden, pieza, cantidad que falta (`GET /shortages`, filtrable por orden o
  pieza). Una pieza sin identificar (`part_id: null`) se muestra como "sin identificar" y
  `missing_quantity: null` como "cantidad sin capturar".
- **Sugerencias:** pieza, cantidad sugerida y órdenes que la piden
  (`GET /reorder-suggestions`).
- **Sin relacionar:** compras que no coincidieron con el catálogo, con un botón para
  elegir la pieza (`GET /unmatched-receipts`, `POST /unmatched-receipts/{id}/resolve`).

### 2. Orden de trabajo (escritorio)
Buscador por código (ej. `R061026012`) y una tabla por línea con **Requerido · Reservado ·
Entregado · Falta** (`GET /work-orders/{code}/materials`). Resaltar en rojo las líneas con
faltante. Cada nombre de pieza enlaza a su fila en el inventario. Si el código no existe
(404), mostrar "orden no encontrada".

### 3. Piso (celular)
Un solo flujo con tres modos: **Retirar · Transferir · Contar**.

| Modo | Pasos | Llama a |
|---|---|---|
| Retirar | escanear ubicación → escanear pieza → cantidad → código de orden | `POST /issues` |
| Transferir | escanear origen → escanear destino → escanear pieza → cantidad | `POST /transfers` |
| Contar | escanear ubicación → escanear pieza → cantidad contada → **motivo (obligatorio)** | `POST /counts` |

Cada escaneo llena el siguiente paso solo. Botones grandes, pocos toques, y al terminar un
mensaje claro con el resultado. Errores a mostrar: **409** "no alcanza el saldo en esa
ubicación" y **422** "falta el motivo".

## Escaneo (importante)

- **Todas las etiquetas son Code 128.** Ubicación: su `code` (`U-101`). Pieza con SKU: el SKU
  tal cual (`7014 CTA/P4`, con espacios, puntos, comas y diagonales; no alterarlo). Pieza sin
  SKU: `P-` + `part_id` (`P-24`).
- **La cámara solo funciona en HTTPS o `localhost`.** Un celular que abre
  `http://192.168.x.x:5173` no tendrá cámara. Usar `@vitejs/plugin-basic-ssl` o un túnel, y
  **probarlo en un celular real desde la primera hora**.
- Usar una librería de lectura que soporte Code 128 en todos los navegadores (por ejemplo
  `@zxing/browser` o `html5-qrcode`); `BarcodeDetector` no está en todos. Verificar al
  construir.
- Un mismo SKU puede ser de dos piezas: si pasa, **mostrar una lista y pedir elegir**.
- Dejar siempre un campo para teclear el código a mano, por si falla la cámara en la demo.
- Las etiquetas de prueba están en `kit/labels/etiquetas-demo.pdf` (se pueden escanear
  desde la pantalla).

## Lo que el frontend necesita del backend (fuera del contrato)

El contrato solo trae rutas por `part_id`, así que la app necesita además, con la forma que
acuerden con el backend:

- **Una lista de piezas con buscador**, con sus totales (`on_hand`, `reserved`, `available`),
  para la tabla de existencias.
- **Traducir lo que se escanea** (SKU, `P-24` o `U-101`) a su `part_id` o `location_id`, y que
  pueda devolver varias piezas si un SKU se repite.
- **Nombres de ubicaciones**, para mostrar algo más que el id.

Hasta que existan, usar respuestas falsas en `api.ts`.

## Estructura sugerida

```
frontend/src/
├── pages/        Inventory, WorkOrder, Floor
├── components/   ExpandableRow, Scanner, AlertBadge, Ledger
└── api.ts        llamadas al backend (y los mocks mientras no exista)
```

## Extras de pantalla (solo si ya funciona todo lo demás)

Tablero de rotación (piezas críticas y sin movimiento), valoración a costo promedio,
indicador de lag y errores del consumidor. Ver `reto.md`.
