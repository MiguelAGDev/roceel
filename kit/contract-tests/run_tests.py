"""Pruebas de contrato del servicio de inventario.

Publica escenarios conocidos en los tópicos del taller y revisa los eventos que su
servicio publica en `inventory.events` y las respuestas de su API. Cada corrida usa IDs,
SKUs y códigos de orden propios, así que se puede correr cuantas veces quieran sobre el
mismo broker, con o sin el dataset cargado.

    uv run --with confluent-kafka --with jsonschema contract-tests/run_tests.py \\
        --broker localhost:19092 --api http://localhost:8000

    # solo algunos escenarios
    ... run_tests.py --only reserva_y_faltante,concurrencia

    # reconstrucción (la corre el jurado): foto del saldo, borran su base y releen
    # los tópicos desde el inicio, y comparan
    ... run_tests.py snapshot --out saldo.json
    ... run_tests.py compare  --out saldo.json
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from confluent_kafka import Consumer, Producer, TopicPartition
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

KIT = Path(__file__).resolve().parent.parent
SCHEMAS = KIT / "contract" / "schemas"
RECEIVING_LOCATION = 100


class CheckFailed(Exception):
    pass


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --- infraestructura -------------------------------------------------------------
class Outputs:
    """Escucha inventory.events desde el final y guarda lo que llega."""

    def __init__(self, broker: str) -> None:
        self.events: list[dict] = []
        self.invalid: list[str] = []
        self.lock = threading.Lock()
        self.validators = self._validators()
        self.consumer = Consumer({
            "bootstrap.servers": broker,
            "group.id": f"contract-tests-{uuid.uuid4()}",
            "enable.auto.commit": False,
        })
        meta = self.consumer.list_topics("inventory.events", timeout=10)
        partitions = [TopicPartition("inventory.events", p) for p in meta.topics["inventory.events"].partitions]
        assigned = []
        for tp in partitions:
            _, high = self.consumer.get_watermark_offsets(tp, timeout=10)
            assigned.append(TopicPartition("inventory.events", tp.partition, high))
        self.consumer.assign(assigned)
        self.running = True
        threading.Thread(target=self._loop, daemon=True).start()

    @staticmethod
    def _validators() -> dict[str, Draft202012Validator]:
        resources = []
        for path in SCHEMAS.rglob("*.schema.json"):
            schema = json.loads(path.read_text(encoding="utf-8"))
            resources.append((schema["$id"], Resource.from_contents(schema)))
        registry = Registry().with_resources(resources)
        index = json.loads((SCHEMAS / "index.json").read_text(encoding="utf-8"))
        return {name: Draft202012Validator(json.loads((SCHEMAS / e["schema"]).read_text(encoding="utf-8")), registry=registry)
                for name, e in index["output"].items()}

    def _loop(self) -> None:
        while self.running:
            msg = self.consumer.poll(0.2)
            if msg is None or msg.error():
                continue
            try:
                event = json.loads(msg.value())
            except ValueError:
                with self.lock:
                    self.invalid.append(f"mensaje que no es JSON: {msg.value()[:120]!r}")
                continue
            validator = self.validators.get(event.get("event_type"))
            problems = [f"{e.json_path}: {e.message}" for e in validator.iter_errors(event)] if validator else [
                f"event_type desconocido {event.get('event_type')!r}"]
            msg_key = msg.key().decode() if msg.key() else None
            if msg_key is not None and msg_key != event.get("key"):
                problems.append(f"la key del mensaje ({msg_key}) no coincide con event.key ({event.get('key')})")
            with self.lock:
                self.events.append(event)
                self.invalid.extend(f"{event.get('event_type')}: {p}" for p in problems)

    def find(self, event_type: str, **match) -> list[dict]:
        with self.lock:
            return [e for e in self.events if e.get("event_type") == event_type
                    and all(e.get("data", {}).get(k) == v for k, v in match.items())]


class Shop:
    """Publica eventos del taller con el sobre del contrato."""

    def __init__(self, broker: str) -> None:
        self.producer = Producer({"bootstrap.servers": broker, "enable.idempotence": True, "acks": "all"})

    def publish(self, topic: str, event_type: str, key: str, data: dict) -> dict:
        event = {"event_id": str(uuid.uuid4()), "event_type": event_type, "event_version": 1,
                 "occurred_at": now_iso(), "source": "shop-floor", "key": key, "data": data}
        self.send(topic, event)
        return event

    def send(self, topic: str, event: dict) -> None:
        self.producer.produce(topic, key=event["key"].encode(), value=json.dumps(event).encode())
        self.producer.flush(10)


class Api:
    def __init__(self, base: str) -> None:
        self.base = base.rstrip("/")

    def call(self, method: str, path: str, body: dict | None = None) -> tuple[int, object]:
        req = urllib.request.Request(self.base + path, method=method,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                raw = resp.read()
                return resp.status, json.loads(raw) if raw else None
        except urllib.error.HTTPError as err:
            raw = err.read()
            try:
                return err.code, json.loads(raw) if raw else None
            except ValueError:
                return err.code, raw.decode(errors="replace")
        except (urllib.error.URLError, ConnectionError, TimeoutError) as err:
            raise CheckFailed(f"la API no responde en {self.base}{path}: {err}") from err

    def get(self, path: str):
        return self.call("GET", path)

    def post(self, path: str, body: dict):
        return self.call("POST", path, body)


# --- contexto de una corrida -------------------------------------------------------
@dataclass
class Ctx:
    shop: Shop
    api: Api
    out: Outputs
    timeout: float
    settle: float
    run: int = field(default_factory=lambda: random.randint(100000, 999999))
    seq: int = 0
    codes: dict[int, str] = field(default_factory=dict)
    lock: threading.Lock = field(default_factory=threading.Lock)

    # IDs únicos por corrida: 6 dígitos de corrida + 3 de consecutivo.
    def id(self) -> int:
        with self.lock:
            self.seq += 1
            return self.run * 1000 + self.seq

    def sku(self, label: str) -> str:
        return f"T{self.run}-{label}"

    # --- espera ---
    def wait(self, what: str, fn, timeout: float | None = None):
        deadline = time.monotonic() + (timeout or self.timeout)
        last_error = None
        while time.monotonic() < deadline:
            try:
                result = fn()
                if result:
                    return result
            except CheckFailed as exc:
                last_error = exc
            time.sleep(0.3)
        raise CheckFailed(f"{what} (esperé {timeout or self.timeout:.0f} s)" + (f": {last_error}" if last_error else ""))

    def quiet(self) -> None:
        time.sleep(self.settle)

    # --- catálogo ---
    def location(self, name: str, location_id: int | None = None) -> int:
        lid = location_id or self.id()
        code = "U-100" if lid == RECEIVING_LOCATION else f"U-{lid % 1000:03d}"
        self.shop.publish("shop.catalog", "location.upserted", f"location:{lid}", {
            "location_id": lid, "code": code, "name": name, "is_workbench": False, "active": True})
        return lid

    def part(self, label: str, sku: str | None = "auto") -> dict:
        part = {"part_id": self.id(), "sku": self.sku(label) if sku == "auto" else sku,
                "name": f"PIEZA DE PRUEBA {label}", "family": "REFACCIÓN", "group": "PRUEBAS", "subgroup": None,
                "unit": {"id": 1, "name": "PIEZA"}, "image_url": None, "active": True}
        self.shop.publish("shop.catalog", "part.upserted", f"part:{part['part_id']}", part)
        return part

    def bom(self, lines: list[tuple[dict | None, str, int | None]]) -> tuple[int, list[dict]]:
        model_id = self.id()
        bom_lines = [{"bom_line_id": self.id(), "part_id": p["part_id"] if p else None, "name": name,
                      "group_name": None, "unit": {"id": 1, "name": "PIEZA"}, "qty_per_unit": qty, "sort_order": i}
                     for i, (p, name, qty) in enumerate(lines)]
        self.shop.publish("shop.catalog", "bom.upserted", f"model:{model_id}",
                          {"model_id": model_id, "model_name": f"MODELO {self.run}", "brand": "PRUEBA", "lines": bom_lines})
        return model_id, bom_lines

    # --- taller ---
    def work_order(self, model_id: int, publish: bool = True) -> tuple[int, str]:
        wo_id = self.id()
        code = f"R{self.run:06d}{self.seq % 1000:03d}"
        self.codes[wo_id] = code
        if publish:
            self.open_work_order(wo_id, model_id)
        return wo_id, code

    def open_work_order(self, wo_id: int, model_id: int) -> None:
        self.shop.publish("shop.work_orders", "work_order.opened", self.codes[wo_id], {
            "work_order_id": wo_id, "code": self.codes[wo_id], "model_id": model_id,
            "department": "spindles", "received_at": now_iso()})

    def item(self, line: dict, condition: str = "damaged", action: str | None = "buy", quantity: int | None = 1) -> dict:
        return {"inspection_item_id": self.id(), "bom_line_id": line["bom_line_id"], "part_id": line["part_id"],
                "name": line["name"], "group_name": line["group_name"], "condition": condition,
                "action": None if condition == "ok" else action, "quantity": None if condition == "ok" else quantity,
                "note": None}

    def inspect(self, wo_id: int, items: list[dict], kind: str = "quick", outcome: str | None = "approved") -> int:
        inspection_id = self.id()
        code = self.codes[wo_id]
        base = {"inspection_id": inspection_id, "work_order_id": wo_id, "kind": kind, "items": items}
        self.shop.publish("shop.inspections", "inspection.submitted", code, base)
        if outcome == "approved":
            self.shop.publish("shop.inspections", "inspection.approved", code,
                              {**base, "approved_by": 12, "approved_at": now_iso()})
        return inspection_id

    def receive(self, part_number: str, quantity: int, work_order_code: str | None = None,
                purpose: str = "restock", price: str = "100.00") -> dict:
        number = str(self.id())
        return self.shop.publish("shop.purchasing", "purchase.item_received", f"PR-{number}", {
            "purchase_request_id": self.id(), "request_number": number, "line_id": self.id(),
            "part_number": part_number, "description": f"compra {part_number}", "quantity": quantity,
            "unit_price": price, "currency": "MXN", "purpose": purpose, "received_at": now_iso(),
            "work_order_code": work_order_code})

    def stock(self, part: dict, quantity: int) -> None:
        """Deja existencia y espera a verla en la API."""
        ev = self.receive(part["sku"], quantity)
        self.wait(f"stock.received de la compra {ev['data']['line_id']}",
                  lambda: self.out.find("stock.received", purchase_line_id=ev["data"]["line_id"]))

    # --- API ---
    def availability(self, part_id: int) -> dict:
        status, body = self.api.get(f"/parts/{part_id}/availability")
        if status != 200:
            raise CheckFailed(f"GET /parts/{part_id}/availability respondió {status}: {body}")
        return body

    def materials(self, code: str) -> dict:
        status, body = self.api.get(f"/work-orders/{code}/materials")
        if status != 200:
            raise CheckFailed(f"GET /work-orders/{code}/materials respondió {status}: {body}")
        return body


def expect(condition: bool, message: str) -> None:
    if not condition:
        raise CheckFailed(message)


def expect_totals(ctx: Ctx, part: dict, on_hand: int, reserved: int, what: str) -> dict:
    def ok():
        av = ctx.availability(part["part_id"])
        if (av["on_hand"], av["reserved"], av["available"]) == (on_hand, reserved, on_hand - reserved):
            return av
        raise CheckFailed(f"saldo {av['on_hand']}/{av['reserved']}/{av['available']}, esperaba "
                          f"{on_hand}/{reserved}/{on_hand - reserved} (on_hand/reserved/available)")
    return ctx.wait(what, ok)


def line_of(materials: dict, bom_line_id: int) -> dict:
    for line in materials["lines"]:
        if line["bom_line_id"] == bom_line_id:
            return line
    raise CheckFailed(f"la línea {bom_line_id} no aparece en materials: {materials['lines']}")


# --- escenarios: libro mayor -------------------------------------------------------
def recepcion_basica(ctx: Ctx):
    """Una compra de reabasto entra a U-100 y se relaciona aunque el número de parte
    venga con otras mayúsculas y espacios."""
    ctx.location("Recepción de material", RECEIVING_LOCATION)
    part = ctx.part("A")
    ev = ctx.receive(f"  {part['sku'].lower()} ", 5, price="1850.00")
    line_id = ev["data"]["line_id"]
    received = ctx.wait("stock.received de la compra", lambda: ctx.out.find("stock.received", purchase_line_id=line_id))[0]
    expect(received["data"]["part_id"] == part["part_id"], f"part_id {received['data']['part_id']} ≠ {part['part_id']}")
    expect(received["data"]["location_id"] == RECEIVING_LOCATION, "la entrada debe registrarse en U-100 (location_id 100)")
    expect(received["data"]["quantity"] == 5, f"quantity {received['data']['quantity']} ≠ 5")
    expect(received["data"]["currency"] == "MXN", "currency debe venir de la compra")
    expect(received["key"] == f"part:{part['part_id']}", f"key {received['key']} ≠ part:{part['part_id']}")
    av = expect_totals(ctx, part, 5, 0, "saldo después de la recepción")
    at_receiving = [loc for loc in av["locations"] if loc["location_id"] == RECEIVING_LOCATION]
    expect(at_receiving and at_receiving[0]["on_hand"] == 5, f"U-100 debe tener 5: {av['locations']}")
    return {"part": part, "event": ev}


def idempotencia(ctx: Ctx):
    """El mismo event_id dos veces no cambia el saldo ni emite salidas nuevas."""
    part = ctx.part("IDEM")
    ev = ctx.receive(part["sku"], 4)
    line_id = ev["data"]["line_id"]
    ctx.wait("stock.received", lambda: ctx.out.find("stock.received", purchase_line_id=line_id))
    ctx.shop.send("shop.purchasing", ev)
    ctx.shop.send("shop.purchasing", ev)
    ctx.quiet()
    expect(len(ctx.out.find("stock.received", purchase_line_id=line_id)) == 1, "se emitió stock.received más de una vez")
    expect_totals(ctx, part, 4, 0, "el saldo no debe cambiar con el reenvío")


def salida_sin_negativos(ctx: Ctx):
    """Una salida mayor a la existencia responde 409 y no mueve nada."""
    part = ctx.part("NEG")
    ctx.stock(part, 2)
    model_id, _ = ctx.bom([(part, part["name"], 2)])
    _, code = ctx.work_order(model_id)
    body = {"work_order_code": code, "part_id": part["part_id"], "location_id": RECEIVING_LOCATION, "quantity": 3, "issued_by": 7}
    status, resp = ctx.wait("POST /issues con más de lo que hay → 409",
                            lambda: (lambda r: r if r[0] != 404 else None)(ctx.api.post("/issues", body)))
    expect(status == 409, f"POST /issues de 3 con 2 en existencia respondió {status}: {resp}")
    expect_totals(ctx, part, 2, 0, "saldo intacto tras el 409")
    status, resp = ctx.api.post("/issues", {**body, "quantity": 2})
    expect(status == 201, f"POST /issues de 2 respondió {status}: {resp}")
    issued = ctx.wait("stock.issued", lambda: ctx.out.find("stock.issued", part_id=part["part_id"]))[0]
    expect(issued["data"]["quantity"] == 2 and issued["data"]["location_id"] == RECEIVING_LOCATION, f"stock.issued: {issued['data']}")
    expect(issued["key"] == code, f"key de stock.issued {issued['key']} ≠ {code}")
    expect_totals(ctx, part, 0, 0, "saldo en cero tras la salida")


def transferencia_y_conteo(ctx: Ctx, label: str = "TRF"):
    """Transferir mueve saldo entre ubicaciones sin cambiar el total; el conteo ajusta
    con motivo obligatorio."""
    part = ctx.part(label)
    ctx.stock(part, 4)
    shelf = ctx.location("Estante de prueba")
    ctx.quiet()
    body = {"part_id": part["part_id"], "from_location_id": RECEIVING_LOCATION, "to_location_id": shelf, "quantity": 3}
    status, resp = ctx.api.post("/transfers", {**body, "quantity": 5})
    expect(status == 409, f"transferir 5 con 4 en existencia respondió {status}: {resp}")
    status, resp = ctx.api.post("/transfers", body)
    expect(status == 201, f"POST /transfers respondió {status}: {resp}")
    ctx.wait("stock.transferred", lambda: ctx.out.find("stock.transferred", part_id=part["part_id"], quantity=3))
    av = expect_totals(ctx, part, 4, 0, "el total no cambia al transferir")
    by_loc = {loc["location_id"]: loc["on_hand"] for loc in av["locations"]}
    expect(by_loc.get(RECEIVING_LOCATION) == 1 and by_loc.get(shelf) == 3, f"por ubicación esperaba U-100=1, estante=3: {by_loc}")

    status, resp = ctx.api.post("/counts", {"location_id": shelf, "reason": "", "lines": [{"part_id": part["part_id"], "counted_quantity": 2}]})
    expect(status == 422, f"conteo sin motivo respondió {status}, esperaba 422")
    status, resp = ctx.api.post("/counts", {"location_id": shelf, "reason": "conteo cíclico", "lines": [{"part_id": part["part_id"], "counted_quantity": 2}]})
    expect(status == 201, f"POST /counts respondió {status}: {resp}")
    expect(resp["adjustments"] == [{"part_id": part["part_id"], "delta": -1}], f"adjustments: {resp['adjustments']}")
    adjusted = ctx.wait("stock.adjusted", lambda: ctx.out.find("stock.adjusted", part_id=part["part_id"]))[0]
    expect(adjusted["data"]["delta"] == -1 and adjusted["data"]["reason"] == "conteo cíclico", f"stock.adjusted: {adjusted['data']}")
    expect_totals(ctx, part, 3, 0, "saldo después del ajuste")
    return {"part": part}


def kardex(ctx: Ctx):
    """El kardex va del más reciente al más antiguo y su saldo corrido cuadra."""
    data = transferencia_y_conteo(ctx, "KDX")
    status, ledger = ctx.api.get(f"/parts/{data['part']['part_id']}/ledger")
    expect(status == 200, f"GET ledger respondió {status}")
    entries = ledger["entries"]
    expect(len(entries) >= 4, f"esperaba al menos 4 movimientos (entrada, transferencia salida/entrada, ajuste): {entries}")
    expect(entries[0]["balance"] == 3, f"el movimiento más reciente debe dejar saldo 3: {entries[0]}")
    expect(entries[-1]["balance"] == 4 and entries[-1]["type"] == "receipt", f"el más antiguo es la entrada con saldo 4: {entries[-1]}")
    expect(sum(e["quantity"] for e in entries) == 3, "la suma de los movimientos debe dar el saldo (3)")
    stamps = [e["occurred_at"] for e in entries]
    expect(stamps == sorted(stamps, reverse=True), "los movimientos deben venir del más reciente al más antiguo")


# --- escenarios: integración con el taller ------------------------------------------
def reserva_faltante_compra_y_salida(ctx: Ctx):
    """El ciclo completo: aprobar reserva lo disponible y deja faltante; la compra con
    código de orden lo surte; la salida contra la orden consume la reserva."""
    part = ctx.part("CICLO")
    ctx.stock(part, 5)
    model_id, (line,) = ctx.bom([(part, part["name"], 8)])
    wo_id, code = ctx.work_order(model_id)
    item = ctx.item(line, quantity=8)
    ctx.inspect(wo_id, [item])

    reserved = ctx.wait("stock.reserved", lambda: ctx.out.find("stock.reserved", work_order_id=wo_id, part_id=part["part_id"]))
    expect(sum(e["data"]["quantity"] for e in reserved) == 5, f"debe reservar 5: {[e['data'] for e in reserved]}")
    expect(all(e["data"]["inspection_item_id"] == item["inspection_item_id"] and e["key"] == code for e in reserved),
           "stock.reserved debe traer el inspection_item_id y la key de la orden")
    shortage = ctx.wait("stock.shortage_detected", lambda: ctx.out.find("stock.shortage_detected", work_order_id=wo_id))[0]
    expect(shortage["data"]["missing_quantity"] == 3 and shortage["data"]["part_id"] == part["part_id"], f"faltante: {shortage['data']}")
    expect_totals(ctx, part, 5, 5, "reservado 5 de 5")

    mat = line_of(ctx.wait("materials con la línea", lambda: ctx.materials(code)), line["bom_line_id"])
    expect((mat["required"], mat["reserved"], mat["issued"], mat["missing"]) == (8, 5, 0, 3), f"materials: {mat}")
    status, shortages = ctx.api.get(f"/shortages?work_order_code={code}")
    expect(status == 200 and [s["missing_quantity"] for s in shortages["items"]] == [3], f"/shortages: {shortages}")
    ctx.wait("stock.reorder_suggested con la orden", lambda: [e for e in ctx.out.find("stock.reorder_suggested", part_id=part["part_id"])
                                                            if e["data"]["suggested_quantity"] >= 3 and wo_id in e["data"]["work_order_ids"]])
    status, suggestions = ctx.api.get("/reorder-suggestions")
    mine = [s for s in suggestions["items"] if s["part_id"] == part["part_id"]]
    expect(mine and mine[0]["suggested_quantity"] >= 3 and wo_id in mine[0]["work_order_ids"], f"/reorder-suggestions: {mine}")

    ctx.receive(part["sku"], 3, work_order_code=code)
    ctx.wait("stock.shortage_resolved", lambda: ctx.out.find("stock.shortage_resolved", work_order_id=wo_id, part_id=part["part_id"], quantity=3))
    expect_totals(ctx, part, 8, 8, "todo reservado tras la compra")
    status, shortages = ctx.api.get(f"/shortages?work_order_code={code}")
    expect(shortages["items"] == [], f"no deben quedar faltantes: {shortages}")

    status, resp = ctx.api.post("/issues", {"work_order_code": code, "part_id": part["part_id"],
                                             "location_id": RECEIVING_LOCATION, "quantity": 8, "issued_by": "tecnico-1"})
    expect(status == 201, f"POST /issues respondió {status}: {resp}")
    expect_totals(ctx, part, 0, 0, "la salida consume la reserva")
    mat = line_of(ctx.materials(code), line["bom_line_id"])
    expect((mat["reserved"], mat["issued"], mat["missing"]) == (0, 8, 0), f"materials tras la salida: {mat}")


def lineas_que_no_reservan(ctx: Ctx):
    """repair y ok no reservan; part_id null es faltante sin identificar; quantity null
    toma el qty_per_unit de la lista de partes."""
    p_repair, p_ok, p_qty = ctx.part("REP"), ctx.part("OK"), ctx.part("QTY")
    for p in (p_repair, p_ok, p_qty):
        ctx.stock(p, 10)
    model_id, (l_rep, l_ok, l_none, l_qty) = ctx.bom([(p_repair, "REPARAR", 1), (p_ok, "BIEN", 1),
                                                      (None, "KIT SIN IDENTIFICAR", 2), (p_qty, "SIN CANTIDAD", 3)])
    wo_id, _ = ctx.work_order(model_id)
    ctx.inspect(wo_id, [ctx.item(l_rep, action="repair", quantity=1), ctx.item(l_ok, condition="ok"),
                        ctx.item(l_none, condition="missing", quantity=2), ctx.item(l_qty, quantity=None)])
    unknown = ctx.wait("faltante sin identificar", lambda: [e for e in ctx.out.find("stock.shortage_detected", work_order_id=wo_id)
                                                           if e["data"]["part_id"] is None])
    expect(unknown[0]["data"]["missing_quantity"] == 2 and unknown[0]["data"]["name"] == "KIT SIN IDENTIFICAR", f"{unknown[0]['data']}")
    reserved = ctx.wait("reserva de la línea sin cantidad", lambda: ctx.out.find("stock.reserved", work_order_id=wo_id, part_id=p_qty["part_id"]))
    expect(reserved[0]["data"]["quantity"] == 3, f"quantity null debe reservar qty_per_unit (3): {reserved[0]['data']}")
    ctx.quiet()
    expect(not ctx.out.find("stock.reserved", work_order_id=wo_id, part_id=p_repair["part_id"]), "una línea repair no se reserva")
    expect(not ctx.out.find("stock.reserved", work_order_id=wo_id, part_id=p_ok["part_id"]), "una línea ok no se reserva")
    expect_totals(ctx, p_repair, 10, 0, "repair no toca el saldo")


def compra_para_cliente(ctx: Ctx):
    """purpose = customer_order no entra al inventario."""
    part = ctx.part("CLI")
    ctx.stock(part, 1)
    ev = ctx.receive(part["sku"], 6, purpose="customer_order")
    ctx.quiet()
    expect(not ctx.out.find("stock.received", purchase_line_id=ev["data"]["line_id"]), "una compra para cliente no emite stock.received")
    expect_totals(ctx, part, 1, 0, "una compra para cliente no suma existencia")


def recepcion_sin_relacionar(ctx: Ctx):
    """Un número de parte desconocido y un sku compartido por dos piezas van a revisión
    manual; resolverla da la entrada."""
    part = ctx.part("MANUAL")
    ev = ctx.receive(f"PROV-{ctx.run}", 2)
    line_id = ev["data"]["line_id"]
    ctx.wait("stock.unmatched_receipt", lambda: ctx.out.find("stock.unmatched_receipt", purchase_line_id=line_id))
    status, pending = ctx.api.get("/unmatched-receipts")
    mine = [r for r in pending["items"] if r["purchase_line_id"] == line_id]
    expect(status == 200 and mine, f"la recepción debe aparecer en /unmatched-receipts: {pending}")
    status, resp = ctx.api.post(f"/unmatched-receipts/{mine[0]['id']}/resolve", {"part_id": part["part_id"]})
    expect(status == 200, f"resolve respondió {status}: {resp}")
    ctx.wait("stock.received tras resolver", lambda: ctx.out.find("stock.received", purchase_line_id=line_id, part_id=part["part_id"]))
    expect_totals(ctx, part, 2, 0, "la entrada resuelta suma existencia")
    status, resp = ctx.api.post(f"/unmatched-receipts/{mine[0]['id']}/resolve", {"part_id": part["part_id"]})
    expect(status == 409, f"resolver dos veces debe responder 409, respondió {status}")

    shared = ctx.sku("DUP")
    twin_a, twin_b = ctx.part("DUP-A", sku=shared), ctx.part("DUP-B", sku=shared)
    ev = ctx.receive(shared, 1)
    ctx.wait("stock.unmatched_receipt del sku ambiguo", lambda: ctx.out.find("stock.unmatched_receipt", purchase_line_id=ev["data"]["line_id"]))
    expect(not ctx.out.find("stock.received", purchase_line_id=ev["data"]["line_id"]), "un sku ambiguo no debe entrar solo")
    expect_totals(ctx, twin_a, 0, 0, "el sku ambiguo no suma a ninguna pieza")


def necesidad_se_reemplaza(ctx: Ctx):
    """Una aprobación posterior que repite la línea reemplaza la cantidad; una completa
    con items: [] no cambia nada."""
    part = ctx.part("REEMP")
    ctx.stock(part, 10)
    model_id, (line,) = ctx.bom([(part, part["name"], 6)])
    wo_id, code = ctx.work_order(model_id)
    ctx.inspect(wo_id, [ctx.item(line, quantity=2)])
    expect_totals(ctx, part, 10, 2, "reserva inicial de 2")
    ctx.inspect(wo_id, [ctx.item(line, quantity=3)], kind="full")
    expect_totals(ctx, part, 10, 3, "la segunda aprobación reemplaza (3), no suma (5)")
    ctx.inspect(wo_id, [], kind="full")
    ctx.quiet()
    expect_totals(ctx, part, 10, 3, "una completa sin items no cambia la reserva")
    mat = line_of(ctx.materials(code), line["bom_line_id"])
    expect(mat["required"] == 3 and mat["reserved"] == 3, f"materials: {mat}")


def rechazo_y_anulacion(ctx: Ctx):
    """Un rechazo no reserva; anular una aprobada libera su reserva y cierra su faltante."""
    part = ctx.part("ANUL")
    ctx.stock(part, 2)
    model_id, (line,) = ctx.bom([(part, part["name"], 4)])
    wo_id, code = ctx.work_order(model_id)
    rejected = ctx.inspect(wo_id, [ctx.item(line, quantity=1)], outcome=None)
    ctx.shop.publish("shop.inspections", "inspection.rejected", code,
                     {"inspection_id": rejected, "work_order_id": wo_id, "reason": "Revisar"})
    ctx.quiet()
    expect(not ctx.out.find("stock.reserved", work_order_id=wo_id), "una inspección rechazada no reserva")

    approved = ctx.inspect(wo_id, [ctx.item(line, quantity=4)])
    expect_totals(ctx, part, 2, 2, "la aprobada reserva 2 y deja 2 de faltante")
    ctx.wait("faltante", lambda: ctx.out.find("stock.shortage_detected", work_order_id=wo_id))
    ctx.shop.publish("shop.work_orders", "work_order.stage_changed", code,
                     {"work_order_id": wo_id, "from_stage": "awaiting_full_inspection", "to_stage": "quick_inspection"})
    ctx.shop.publish("shop.inspections", "inspection.voided", code,
                     {"inspection_id": approved, "work_order_id": wo_id, "reason": "Se regresó la etapa"})
    expect_totals(ctx, part, 2, 0, "anular libera la reserva")
    ctx.wait("sin faltantes tras anular", lambda: ctx.api.get(f"/shortages?work_order_code={code}")[1]["items"] == [])


def baja_de_orden(ctx: Ctx):
    """work_order.deleted libera reservas y cierra faltantes."""
    part = ctx.part("BAJA")
    ctx.stock(part, 1)
    model_id, (line,) = ctx.bom([(part, part["name"], 3)])
    wo_id, code = ctx.work_order(model_id)
    ctx.inspect(wo_id, [ctx.item(line, quantity=3)])
    expect_totals(ctx, part, 1, 1, "reserva 1 y falta 2")
    ctx.shop.publish("shop.work_orders", "work_order.deleted", code, {"work_order_id": wo_id, "code": code})
    expect_totals(ctx, part, 1, 0, "la baja libera la reserva")
    ctx.wait("sin faltantes de la orden dada de baja", lambda: ctx.api.get(f"/shortages?work_order_code={code}")[1]["items"] == [])


def desorden(ctx: Ctx):
    """La aprobación llega antes que la orden y que la pieza: no se pierde."""
    model_id_holder = ctx.id()
    wo_id, code = ctx.work_order(model_id_holder, publish=False)
    late_part = {"part_id": ctx.id(), "sku": ctx.sku("TARDE"), "name": "PIEZA QUE LLEGA TARDE", "family": "REFACCIÓN",
                 "group": "PRUEBAS", "subgroup": None, "unit": {"id": 1, "name": "PIEZA"}, "image_url": None, "active": True}
    line = {"bom_line_id": ctx.id(), "part_id": late_part["part_id"], "name": late_part["name"], "group_name": None,
            "unit": {"id": 1, "name": "PIEZA"}, "qty_per_unit": 2, "sort_order": 0}
    ctx.inspect(wo_id, [ctx.item(line, quantity=2)])
    ctx.quiet()  # la aprobación ya les llegó y no la pudieron procesar todavía
    ctx.open_work_order(wo_id, model_id_holder)
    ctx.shop.publish("shop.catalog", "bom.upserted", f"model:{model_id_holder}",
                     {"model_id": model_id_holder, "model_name": "TARDE", "brand": "PRUEBA", "lines": [line]})
    ctx.shop.publish("shop.catalog", "part.upserted", f"part:{late_part['part_id']}", late_part)
    ctx.wait("el faltante de la inspección que llegó antes", lambda: ctx.out.find("stock.shortage_detected", work_order_id=wo_id, part_id=late_part["part_id"]))
    ctx.receive(late_part["sku"], 2, work_order_code=code)
    ctx.wait("la compra surte la orden", lambda: ctx.out.find("stock.shortage_resolved", work_order_id=wo_id))


def concurrencia(ctx: Ctx):
    """Dos aprobaciones al mismo tiempo no se llevan la misma última pieza."""
    part = ctx.part("ULTIMA")
    ctx.stock(part, 1)
    model_id, (line,) = ctx.bom([(part, part["name"], 1)])
    orders = [ctx.work_order(model_id) for _ in range(4)]
    time.sleep(1)
    threads = [threading.Thread(target=ctx.inspect, args=(wo_id, [ctx.item(line, quantity=1)])) for wo_id, _ in orders]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    wo_ids = {wo_id for wo_id, _ in orders}
    ctx.wait("3 faltantes", lambda: len([e for e in ctx.out.find("stock.shortage_detected", part_id=part["part_id"])
                                        if e["data"]["work_order_id"] in wo_ids]) >= 3)
    ctx.quiet()
    reserved = [e for e in ctx.out.find("stock.reserved", part_id=part["part_id"]) if e["data"]["work_order_id"] in wo_ids]
    expect(sum(e["data"]["quantity"] for e in reserved) == 1, f"solo 1 pieza puede reservarse: {[e['data'] for e in reserved]}")
    expect_totals(ctx, part, 1, 1, "reservado 1, disponible 0")


LEDGER = [recepcion_basica, idempotencia, salida_sin_negativos, transferencia_y_conteo, kardex]
INTEGRATION = [reserva_faltante_compra_y_salida, lineas_que_no_reservan, compra_para_cliente, recepcion_sin_relacionar,
               necesidad_se_reemplaza, rechazo_y_anulacion, baja_de_orden, desorden, concurrencia]
CATEGORIES = [("Correctitud del libro mayor", 25, LEDGER), ("Integración con el taller", 25, INTEGRATION)]


# --- reconstrucción ------------------------------------------------------------------
def dataset_part_ids() -> list[int]:
    ids = set()
    with (KIT / "data" / "events.jsonl").open(encoding="utf-8") as fh:
        for raw in fh:
            ev = json.loads(raw)["event"]
            if ev["event_type"] == "part.upserted":
                ids.add(ev["data"]["part_id"])
    return sorted(ids)


def snapshot(api: Api) -> dict:
    out = {}
    for pid in dataset_part_ids():
        status, body = api.get(f"/parts/{pid}/availability")
        if status == 200:  # existencia por ubicación; las reservas dependen del intercalado entre tópicos
            out[str(pid)] = {str(l["location_id"]): l["on_hand"] for l in body["locations"] if l["on_hand"]}
    return out


# --- main ---------------------------------------------------------------------------
def run_suite(args) -> int:
    api = Api(args.api)
    out = Outputs(args.broker)
    ctx = Ctx(shop=Shop(args.broker), api=api, out=out, timeout=args.timeout, settle=args.settle)
    only = set(args.only.split(",")) if args.only else None
    print(f"corrida {ctx.run} · broker {args.broker} · API {args.api}\n")

    score = 0.0
    failures = 0
    for title, points, scenarios in CATEGORIES:
        chosen = [s for s in scenarios if not only or s.__name__ in only]
        if not chosen:
            continue
        passed = 0
        print(title)
        for scenario in chosen:
            started = time.monotonic()
            try:
                scenario(ctx)
                passed += 1
                print(f"  ✔ {scenario.__name__} ({time.monotonic() - started:.1f} s)")
            except CheckFailed as exc:
                failures += 1
                print(f"  ✘ {scenario.__name__}: {exc}")
            except Exception:
                failures += 1
                print(f"  ✘ {scenario.__name__}: error inesperado\n" + "".join("      " + l for l in traceback.format_exc().splitlines(True)))
        part = points * passed / len(scenarios)
        score += part
        print(f"  → {passed}/{len(chosen)} escenarios · {part:.1f} de {points} puntos\n")

    time.sleep(0.5)
    invalid = sorted(set(out.invalid))
    if invalid:
        failures += 1
        print("Eventos de salida que no cumplen el contrato (no suman puntos hasta corregirse):")
        for problem in invalid[:20]:
            print(f"  ✘ {problem}")
        print()
    print(f"Total: {score:.1f} de 50 puntos{' (parcial, --only)' if only else ''}")
    out.running = False
    return 1 if failures else 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", nargs="?", default="run", choices=["run", "snapshot", "compare"])
    parser.add_argument("--broker", default="localhost:19092")
    parser.add_argument("--api", default="http://localhost:8000")
    parser.add_argument("--timeout", type=float, default=20, help="segundos máximos de espera por resultado")
    parser.add_argument("--settle", type=float, default=3, help="segundos para confirmar que algo NO pasó")
    parser.add_argument("--only", help="escenarios separados por coma")
    parser.add_argument("--out", default="saldo.json", help="archivo de snapshot/compare")
    parser.add_argument("--rebuild-timeout", type=float, default=300,
                        help="compare: segundos máximos esperando a que el servicio termine de releer")
    args = parser.parse_args()

    if args.command == "run":
        sys.exit(run_suite(args))
    api = Api(args.api)
    if args.command == "snapshot":
        snap = snapshot(api)
        Path(args.out).write_text(json.dumps(snap, indent=2, sort_keys=True))
        print(f"{len(snap)} piezas guardadas en {args.out}")
        return
    # El servicio puede seguir releyendo los tópicos: comparar hasta que coincida o hasta
    # que el saldo deje de moverse (dos fotos iguales seguidas) sin coincidir.
    before = json.loads(Path(args.out).read_text())
    deadline = time.monotonic() + args.rebuild_timeout
    after, previous = snapshot(api), None
    while after != before and after != previous and time.monotonic() < deadline:
        time.sleep(5)
        previous, after = after, snapshot(api)
    diffs = [pid for pid in sorted(set(before) | set(after), key=int) if before.get(pid) != after.get(pid)]
    for pid in diffs[:20]:
        print(f"  pieza {pid}: antes {before.get(pid)} · ahora {after.get(pid)}")
    print(f"{'✔ mismo saldo' if not diffs else f'✘ {len(diffs)} piezas con saldo distinto'} en {len(set(before) | set(after))} piezas")
    sys.exit(1 if diffs else 0)


if __name__ == "__main__":
    main()
