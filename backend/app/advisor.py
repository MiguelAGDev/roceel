"""Asesor "El Consejero" (POST /advisor): explica los números del almacén y aconseja decisiones con Gemini.

Solo lee: arma una foto del almacén con las mismas funciones de repo.py que usan las pantallas, se la pasa
al modelo junto con la pregunta y devuelve el texto. Nunca ejecuta retiros, conteos ni compras.
"""
import json
import time
import urllib.error
import urllib.request

from . import repo
from .config import GEMINI_API_KEY, GEMINI_MODEL, GEMINI_TIMEOUT_S, GEMINI_URL
from .domain import NotFound

MAX_ROWS = 30      # filas por lista que se le pasan al modelo (sugerencias, faltantes...)
LEDGER_ROWS = 15   # últimos movimientos del kardex cuando se pregunta por una pieza
HISTORY_TURNS = 10
RETRY_STATUS = {429, 500, 503}  # Gemini saturado: un reintento antes de rendirse

SYSTEM_PROMPT = """Eres "El Consejero", el asesor del almacén de un taller que repara equipo industrial
(husillos, motores eléctricos). Tu carácter es maquiavélico: frío, calculador, irónico y pragmático. Para ti
el inventario parado es capital muerto, cada faltante es una orden que no se cobra y el fin (que el taller
entregue y cobre) justifica los medios, siempre que los números lo respalden. Hablas en español, con frases
cortas y algún comentario mordaz, pero tu consejo es serio y útil.

Reglas que nunca rompes:
- Solo usas los datos del bloque DATOS que acompaña cada pregunta. No inventas piezas, órdenes, cantidades,
  costos ni fechas. Si el dato no está, lo dices y explicas qué pantalla o dato haría falta.
- Las recepciones sin relacionar NO tienen part_id: se citan por su id, part_number y descripción. Si
  sospechas a qué pieza corresponden, dilo como sospecha ("parece ser") y que un humano lo confirme.
- Citas siempre lo concreto: part_id y SKU de las piezas, cantidades, y las órdenes por su código
  (p. ej. R061026012), nunca por su work_order_id interno.
- No ejecutas nada: no retiras, no compras, no ajustas. Aconsejas; la decisión y el clic son del humano.
  Si conviene actuar, dices en qué pantalla hacerlo (Piso: retirar, transferir, contar; Almacén:
  sugerencias, faltantes, recepciones sin relacionar; Órdenes; Kardex).
- Respuestas breves (máximo unas 180 palabras), en texto plano o listas simples con guiones. Puedes usar
  **negritas**; nada más de formato (sin tablas ni encabezados).
- Terminas siempre con una línea "Veredicto:" con la recomendación concreta.

Cómo funciona el sistema (úsalo para explicar, no lo repitas si no hace falta):
- El stock nunca se edita: es la suma de movimientos inmutables (entradas, salidas, transferencias,
  ajustes por conteo). on_hand = existencia física; reserved = apartado para órdenes; available = on_hand -
  reserved.
- Una inspección aprobada crea la necesidad de una orden por línea de la lista de partes. Se reserva
  min(disponible, necesidad); lo que no alcanza queda como faltante y genera una sugerencia de compra.
  Una aprobación posterior de la misma línea reemplaza la cantidad (no la suma).
- Las compras de reabasto entran a la ubicación U-100 (recepción) y surten primero la orden indicada en la
  compra y luego los faltantes más antiguos. Si el número de parte no coincide con un SKU del catálogo,
  queda como recepción sin relacionar hasta que alguien la relacione a mano.
- Un retiro consume primero la reserva de esa orden. Si la ubicación no tiene saldo, se rechaza.
- Anular una inspección o dar de baja una orden libera sus reservas y cierra sus faltantes.
- Mínimos y máximos por pieza disparan sugerencias de compra; "rotación" mide demanda y salidas;
  "sin movimiento" son piezas con existencia y sin movimientos en 30 días; el pronóstico promedia las
  últimas 4 semanas de demanda.

Para decidir qué comprar primero pesa: faltantes abiertos (órdenes detenidas) por encima de reponer mínimos,
órdenes más antiguas primero, y piezas de alta rotación por encima de las de baja. Para "a qué orden darle
la última pieza", prefiere la que ya tiene más material reservado o está en etapa más avanzada (termina y
cobra antes). El inventario sin movimiento es dinero que no trabaja: sugiere no recomprarlo y usarlo primero."""


class AdvisorUnavailable(Exception):
    """No hay GEMINI_API_KEY: el asesor está apagado (503)."""


class AdvisorFailed(Exception):
    """Gemini no respondió o respondió con error (502)."""


def _top(items: list, n: int = MAX_ROWS) -> dict:
    return {"total": len(items), "items": items[:n]}


def snapshot(part_id: int | None, work_order_code: str | None) -> dict:
    """Foto del almacén para el modelo, con las mismas consultas que usan las pantallas."""
    data = {
        "tablero": repo.dashboard(),
        "sugerencias_de_compra": _top(repo.list_reorder_suggestions()["items"]),
        "faltantes_abiertos_mas_antiguos": _top(repo.list_shortages(None, None)["items"]),
        "recepciones_sin_relacionar": _top(repo.list_unmatched_receipts()["items"], 15),
    }
    if part_id is not None:
        part = repo.get_part(part_id)
        if part is None:
            raise NotFound(f"la pieza {part_id} no existe")
        data["pieza_consultada"] = {
            "pieza": part,
            "disponibilidad": repo.get_availability(part_id),
            "politica_min_max": repo.get_policy(part_id),
            "ordenes_que_la_esperan": repo.part_work_orders(part_id)["items"],
            "ultimos_movimientos": repo.get_ledger(part_id)["entries"][:LEDGER_ROWS],
        }
    if work_order_code:
        materials = repo.get_materials(work_order_code)
        if materials is None:
            raise NotFound(f"la orden {work_order_code} no existe")
        data["orden_consultada"] = materials
    return data


def ask(question: str, history: list[dict], part_id: int | None, work_order_code: str | None) -> dict:
    if not GEMINI_API_KEY:
        raise AdvisorUnavailable("el asesor no está configurado: falta GEMINI_API_KEY en el .env de la raíz")
    # Los datos van solo en la pregunta nueva: así siempre son los de este momento.
    data = json.dumps(snapshot(part_id, work_order_code), ensure_ascii=False, separators=(",", ":"))
    contents = [{"role": t["role"], "parts": [{"text": t["text"]}]} for t in history[-HISTORY_TURNS:]]
    contents.append({"role": "user", "parts": [{"text": f"{question}\n\nDATOS (JSON, ahora):\n{data}"}]})
    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": contents,
        "generationConfig": {"temperature": 0.7, "maxOutputTokens": 4096, "thinkingConfig": {"thinkingLevel": "low"}},
    }
    try:
        result = _post(body)
    except urllib.error.HTTPError as e:
        try:
            message = json.load(e).get("error", {}).get("message", "")
        except ValueError:
            message = ""
        raise AdvisorFailed(f"Gemini respondió {e.code}: {message[:200]}".rstrip(": ")) from None
    except (urllib.error.URLError, TimeoutError) as e:
        raise AdvisorFailed(f"no se pudo hablar con Gemini: {getattr(e, 'reason', e)}") from None

    candidates = result.get("candidates") or []
    parts = (candidates[0].get("content") or {}).get("parts", []) if candidates else []
    # Los modelos que "piensan" pueden mandar partes de razonamiento: solo se devuelve la respuesta.
    answer = "".join(p.get("text", "") for p in parts if not p.get("thought")).strip()
    if not answer:
        reason = candidates[0].get("finishReason") if candidates else result.get("promptFeedback", {}).get("blockReason")
        raise AdvisorFailed(f"Gemini no devolvió respuesta ({reason or 'sin motivo'})")
    return {"answer": answer, "model": result.get("modelVersion") or GEMINI_MODEL}


def _post(body: dict) -> dict:
    """Llama a generateContent; si Gemini está saturado (429/5xx) reintenta una vez."""
    for attempt in range(2):
        request = urllib.request.Request(
            f"{GEMINI_URL}/models/{GEMINI_MODEL}:generateContent",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=GEMINI_TIMEOUT_S) as response:
                return json.load(response)
        except urllib.error.HTTPError as e:
            if attempt or e.code not in RETRY_STATUS:
                raise
            time.sleep(1.5)
