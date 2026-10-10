"""Valida un archivo JSONL de eventos contra los JSON Schema de contract/schemas.

Cada línea puede ser un evento (el sobre completo) o {"topic": "...", "event": {...}},
el formato de data/events.jsonl.

    uv run --with jsonschema tools/validate_events.py data/events.jsonl
    uv run --with jsonschema tools/validate_events.py mis-salidas.jsonl

Sale con código 1 si alguna línea no cumple el contrato.
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

SCHEMAS = Path(__file__).resolve().parent.parent / "contract" / "schemas"


def load_validators() -> tuple[dict[str, Draft202012Validator], dict[str, str]]:
    resources = []
    for path in SCHEMAS.rglob("*.schema.json"):
        schema = json.loads(path.read_text(encoding="utf-8"))
        resources.append((schema["$id"], Resource.from_contents(schema)))
    registry = Registry().with_resources(resources)

    index = json.loads((SCHEMAS / "index.json").read_text(encoding="utf-8"))
    validators, topics = {}, {}
    for direction in ("input", "output"):
        for event_type, entry in index[direction].items():
            schema = json.loads((SCHEMAS / entry["schema"]).read_text(encoding="utf-8"))
            validators[event_type] = Draft202012Validator(
                schema, registry=registry, format_checker=FormatChecker()
            )
            topics[event_type] = entry["topic"]
    return validators, topics


def main(path: str) -> int:
    validators, topics = load_validators()
    errors = 0
    counts: Counter[str] = Counter()
    seen_ids: Counter[str] = Counter()

    with open(path, encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, 1):
            if not raw.strip():
                continue
            record = json.loads(raw)
            topic = record.get("topic") if "event" in record else None
            event = record["event"] if "event" in record else record

            event_type = event.get("event_type")
            validator = validators.get(event_type)
            if validator is None:
                print(f"línea {lineno}: event_type desconocido {event_type!r}")
                errors += 1
                continue
            if topic is not None and topic != topics[event_type]:
                print(f"línea {lineno}: {event_type} va en {topics[event_type]}, no en {topic}")
                errors += 1
            for err in validator.iter_errors(event):
                where = "/".join(str(p) for p in err.absolute_path) or "(raíz)"
                print(f"línea {lineno} [{event_type}] {where}: {err.message}")
                errors += 1
            counts[event_type] += 1
            seen_ids[event["event_id"]] += 1

    total = sum(counts.values())
    dups = sum(n - 1 for n in seen_ids.values() if n > 1)
    print(f"\n{total} eventos, {dups} entregas repetidas (mismo event_id), {errors} errores")
    for event_type, n in sorted(counts.items()):
        print(f"  {event_type:28} {n}")
    return 1 if errors else 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
