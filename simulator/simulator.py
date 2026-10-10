"""Simulador del taller.

1. Crea los tópicos.
2. Reproduce data/events.jsonl en el broker al ritmo de `replay_at`, acelerado.
3. Sirve un panel (http://localhost:8090) para la demo: abrir una orden, capturar y
   aprobar/rechazar/anular su inspección, cambiar de etapa, dar de baja y registrar la
   llegada de una compra. Esos eventos salen con la hora real.

Variables de entorno (o argumentos, ver --help):
  BROKER   localhost:19092      EVENTS  data/events.jsonl
  SPEED    3600 (1 h simulada por segundo; 0 = sin pausas)      PORT  8090
"""

from __future__ import annotations

import argparse
import json
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from confluent_kafka import Producer
from confluent_kafka.admin import AdminClient, NewTopic

HERE = Path(__file__).resolve().parent
INPUT_TOPICS = ["shop.catalog", "shop.work_orders", "shop.inspections", "shop.purchasing"]
OUTPUT_TOPICS = ["inventory.events", "inventory.dlq"]
STAGES = ["awaiting_quick_inspection", "quick_inspection", "awaiting_full_inspection", "full_inspection",
          "cleaning", "assembly", "run_in", "final_assembly", "final_release"]


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


# --- broker --------------------------------------------------------------------
def ensure_topics(broker: str, reset: bool) -> None:
    admin = AdminClient({"bootstrap.servers": broker})
    topics = INPUT_TOPICS + OUTPUT_TOPICS
    for attempt in range(60):
        try:
            existing = set(admin.list_topics(timeout=5).topics)
            break
        except Exception as exc:  # broker todavía arrancando
            print(f"esperando al broker ({exc})", flush=True)
            time.sleep(2)
    else:
        raise SystemExit("el broker no respondió")

    if reset:
        to_delete = [t for t in topics if t in existing]
        if to_delete:
            for fut in admin.delete_topics(to_delete, operation_timeout=30).values():
                fut.result()
            time.sleep(2)
            existing -= set(to_delete)
        print(f"tópicos borrados: {to_delete}", flush=True)

    missing = [NewTopic(t, num_partitions=3, replication_factor=1) for t in topics if t not in existing]
    if missing:
        for topic, fut in admin.create_topics(missing).items():
            fut.result()
            print(f"tópico creado: {topic}", flush=True)


class Publisher:
    def __init__(self, broker: str) -> None:
        self.producer = Producer({"bootstrap.servers": broker, "enable.idempotence": True, "acks": "all"})
        self.lock = threading.Lock()

    def send(self, topic: str, event: dict) -> None:
        with self.lock:
            self.producer.produce(topic, key=event["key"].encode(), value=json.dumps(event, ensure_ascii=False).encode())
            self.producer.poll(0)

    def flush(self) -> None:
        with self.lock:
            self.producer.flush(10)


# --- estado del taller (para el panel) ------------------------------------------
class Shop:
    def __init__(self, events_path: Path, publisher: Publisher) -> None:
        self.pub = publisher
        self.lock = threading.Lock()
        self.records = [json.loads(line) for line in events_path.open(encoding="utf-8") if line.strip()]
        self.parts: dict[int, dict] = {}
        self.models: dict[int, dict] = {}
        for rec in self.records:  # catálogo vigente al final del archivo
            ev = rec["event"]
            if ev["event_type"] == "part.upserted":
                self.parts[ev["data"]["part_id"]] = ev["data"]
            elif ev["event_type"] == "bom.upserted":
                self.models[ev["data"]["model_id"]] = ev["data"]
        self.replay = {"sent": 0, "total": len(self.records), "sim_time": None, "done": False, "speed": None}
        self.orders: dict[int, dict] = {}
        self.inspections: dict[int, dict] = {}
        self.seq = {"work_order": 90001, "inspection": 90001, "item": 900001,
                    "request": 9001, "purchase_request": 9001, "line": 90001}
        self.codes_today = 900

    def next(self, kind: str) -> int:
        value = self.seq[kind]
        self.seq[kind] += 1
        return value

    def emit(self, topic: str, event_type: str, key: str, data: dict) -> dict:
        event = {"event_id": str(uuid.uuid4()), "event_type": event_type, "event_version": 1,
                 "occurred_at": now_iso(), "source": "shop-floor", "key": key, "data": data}
        self.pub.send(topic, event)
        self.pub.flush()
        return event

    # --- replay ---
    def run_replay(self, speed: float) -> None:
        self.replay["speed"] = speed
        previous = None
        for rec in self.records:
            at = parse_iso(rec["replay_at"])
            if previous is not None and speed > 0:
                wait = (at - previous).total_seconds() / speed
                if wait > 0:
                    time.sleep(min(wait, 30))
            previous = at
            self.pub.send(rec["topic"], rec["event"])
            self.replay["sent"] += 1
            self.replay["sim_time"] = rec["replay_at"]
        self.pub.flush()
        self.replay["done"] = True
        print(f"replay terminado: {self.replay['sent']} eventos", flush=True)

    # --- acciones del panel ---
    def open_order(self, model_id: int) -> dict:
        with self.lock:
            model = self.models[model_id]
            wo_id = self.next("work_order")
            day = datetime.now(timezone.utc).strftime("%d%m%y")
            code = f"R{day}{self.codes_today:03d}"
            self.codes_today += 1
            order = {"work_order_id": wo_id, "code": code, "model_id": model_id, "model_name": model["model_name"],
                     "stage": "awaiting_quick_inspection", "deleted": False}
            self.orders[wo_id] = order
        self.emit("shop.work_orders", "work_order.opened", code, {
            "work_order_id": wo_id, "code": code, "model_id": model_id,
            "department": "spindles", "received_at": now_iso()})
        self.change_stage(wo_id, "quick_inspection")
        return order

    def change_stage(self, wo_id: int, to_stage: str) -> None:
        order = self.orders[wo_id]
        if to_stage not in STAGES:
            raise ValueError(f"etapa desconocida: {to_stage}")
        self.emit("shop.work_orders", "work_order.stage_changed", order["code"],
                  {"work_order_id": wo_id, "from_stage": order["stage"], "to_stage": to_stage})
        order["stage"] = to_stage

    def submit_inspection(self, wo_id: int, kind: str, rows: list[dict]) -> dict:
        order = self.orders[wo_id]
        lines = {ln["bom_line_id"]: ln for ln in self.models[order["model_id"]]["lines"]}
        items = []
        for row in rows:
            line = lines[int(row["bom_line_id"])]
            condition = row["condition"]
            action = None if condition == "ok" else ("buy" if condition == "missing" else row.get("action") or "buy")
            qty = row.get("quantity")
            items.append({
                "inspection_item_id": self.next("item"), "bom_line_id": line["bom_line_id"],
                "part_id": line["part_id"], "name": line["name"], "group_name": line["group_name"],
                "condition": condition, "action": action,
                "quantity": None if condition == "ok" or qty in (None, "") else int(qty),
                "note": row.get("note") or None,
            })
        inspection = {"inspection_id": self.next("inspection"), "work_order_id": wo_id, "kind": kind,
                      "items": items, "status": "submitted"}
        self.inspections[inspection["inspection_id"]] = inspection
        self.emit("shop.inspections", "inspection.submitted", order["code"], self._inspection_data(inspection))
        return inspection

    def _inspection_data(self, inspection: dict) -> dict:
        return {k: inspection[k] for k in ("inspection_id", "work_order_id", "kind", "items")}

    def close_inspection(self, inspection_id: int, outcome: str, reason: str | None) -> dict:
        inspection = self.inspections[inspection_id]
        order = self.orders[inspection["work_order_id"]]
        base = {"inspection_id": inspection_id, "work_order_id": order["work_order_id"]}
        if outcome == "approve":
            self.emit("shop.inspections", "inspection.approved", order["code"],
                      {**self._inspection_data(inspection), "approved_by": 12, "approved_at": now_iso()})
            inspection["status"] = "approved"
            if inspection["kind"] == "quick":
                self.change_stage(order["work_order_id"], "awaiting_full_inspection")
        elif outcome == "reject":
            self.emit("shop.inspections", "inspection.rejected", order["code"],
                      {**base, "reason": reason or "Revisar la evaluación"})
            inspection["status"] = "rejected"
        elif outcome == "discard":
            self.emit("shop.inspections", "inspection.discarded", order["code"], base)
            inspection["status"] = "discarded"
        elif outcome == "void":
            self.change_stage(order["work_order_id"], "quick_inspection")
            self.emit("shop.inspections", "inspection.voided", order["code"],
                      {**base, "reason": reason or "Se regresó la etapa"})
            inspection["status"] = "voided"
        else:
            raise ValueError(outcome)
        return inspection

    def delete_order(self, wo_id: int) -> None:
        order = self.orders[wo_id]
        self.emit("shop.work_orders", "work_order.deleted", order["code"],
                  {"work_order_id": wo_id, "code": order["code"]})
        order["deleted"] = True

    def receive_purchase(self, body: dict) -> dict:
        number = str(self.next("request"))
        data = {
            "purchase_request_id": self.next("purchase_request"), "request_number": number,
            "line_id": self.next("line"), "part_number": body["part_number"],
            "description": body.get("description") or body["part_number"],
            "quantity": int(body["quantity"]), "unit_price": f"{float(body.get('unit_price') or 0):.2f}",
            "currency": body.get("currency") or "MXN", "purpose": body.get("purpose") or "restock",
            "received_at": now_iso(), "work_order_code": body.get("work_order_code") or None,
        }
        return self.emit("shop.purchasing", "purchase.item_received", f"PR-{number}", data)

    def state(self) -> dict:
        return {
            "replay": self.replay,
            "models": [{"model_id": m["model_id"], "brand": m["brand"], "model_name": m["model_name"],
                        "lines": m["lines"]} for m in self.models.values()],
            "parts": [{"part_id": p["part_id"], "sku": p["sku"], "name": p["name"]}
                      for p in sorted(self.parts.values(), key=lambda p: p["part_id"])],
            "orders": [{**o, "inspections": [i for i in self.inspections.values()
                                             if i["work_order_id"] == o["work_order_id"]]}
                       for o in sorted(self.orders.values(), key=lambda o: -o["work_order_id"])],
        }


# --- HTTP ----------------------------------------------------------------------
def make_handler(shop: Shop):
    page = (HERE / "panel.html").read_bytes()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # silencio
            pass

        def _json(self, status: int, payload) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path in ("/", "/index.html"):
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(page)
            elif self.path == "/api/state":
                self._json(200, shop.state())
            else:
                self._json(404, {"detail": "no existe"})

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            parts = self.path.strip("/").split("/")
            try:
                if parts == ["api", "orders"]:
                    self._json(201, shop.open_order(int(body["model_id"])))
                elif parts[:2] == ["api", "orders"] and parts[3:] == ["inspections"]:
                    self._json(201, shop.submit_inspection(int(parts[2]), body.get("kind", "quick"), body["items"]))
                elif parts[:2] == ["api", "orders"] and parts[3:] == ["stage"]:
                    shop.change_stage(int(parts[2]), body["to_stage"])
                    self._json(200, {"ok": True})
                elif parts[:2] == ["api", "orders"] and parts[3:] == ["delete"]:
                    shop.delete_order(int(parts[2]))
                    self._json(200, {"ok": True})
                elif parts[:2] == ["api", "inspections"] and len(parts) == 4:
                    self._json(200, shop.close_inspection(int(parts[2]), parts[3], body.get("reason")))
                elif parts == ["api", "purchases"]:
                    self._json(201, shop.receive_purchase(body))
                else:
                    self._json(404, {"detail": "no existe"})
            except (KeyError, ValueError) as exc:
                self._json(400, {"detail": str(exc)})

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--broker", default=os.environ.get("BROKER", "localhost:19092"))
    parser.add_argument("--events", default=os.environ.get("EVENTS", str(HERE.parent / "data" / "events.jsonl")))
    parser.add_argument("--speed", type=float, default=float(os.environ.get("SPEED", "3600")))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8090")))
    parser.add_argument("--reset", action="store_true", default=os.environ.get("RESET") == "1",
                        help="borra y recrea los tópicos antes de empezar")
    parser.add_argument("--no-replay", action="store_true", default=os.environ.get("NO_REPLAY") == "1",
                        help="solo el panel (sin reproducir el dataset)")
    args = parser.parse_args()

    ensure_topics(args.broker, args.reset)
    publisher = Publisher(args.broker)
    shop = Shop(Path(args.events), publisher)
    if not args.no_replay:
        threading.Thread(target=shop.run_replay, args=(args.speed,), daemon=True).start()
    else:
        shop.replay["done"] = True

    server = ThreadingHTTPServer(("0.0.0.0", args.port), make_handler(shop))
    print(f"panel del simulador en http://localhost:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
