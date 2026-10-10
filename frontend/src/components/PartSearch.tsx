// Buscador de piezas por nombre, SKU o id (GET /parts?q=). Combobox accesible: flechas, Enter y Esc.
// Se usa en Piso (pieza sin etiqueta), en Relacionar (Almacén) y como filtro.
import { useEffect, useId, useState } from "react";
import { api, fmtQty, partLabel, useApi, type PartSummary } from "../api";
import { IconSearch } from "./icons";

export default function PartSearch({ onPick, label = "Buscar pieza", placeholder = "Nombre, SKU o número", autoFocus, large }: {
  onPick: (part: PartSummary) => void;
  label?: string;
  placeholder?: string;
  autoFocus?: boolean;
  large?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setQuery(text.trim()), 250);
    return () => window.clearTimeout(t);
  }, [text]);

  const results = useApi((s) => api.parts(query, s), [query], { enabled: query.length >= 2 });
  const list = query.length >= 2 ? (results.data ?? []).slice(0, 30) : [];

  function pick(part: PartSummary) {
    onPick(part);
    setText("");
    setQuery("");
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, list.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && open && list[active]) {
      e.preventDefault();
      pick(list[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const showList = open && query.length >= 2;

  return (
    <div className="combo">
      <label className="field" htmlFor={`${id}-input`}>
        <span>{label}</span>
      </label>
      <div style={{ position: "relative" }}>
        <input
          id={`${id}-input`}
          className={`input${large ? " input-xl" : ""}`}
          role="combobox"
          aria-expanded={showList}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={showList && list[active] ? `${id}-opt-${active}` : undefined}
          autoComplete="off"
          placeholder={placeholder}
          value={text}
          autoFocus={autoFocus}
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          style={{ paddingLeft: 36 }}
        />
        <IconSearch style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", width: 18, height: 18, color: "var(--muted)" }} />
      </div>
      {showList && (
        <ul className="combo-list" id={`${id}-list`} role="listbox" aria-label="Piezas encontradas">
          {results.loading && list.length === 0 && <li aria-disabled="true" className="muted">Buscando…</li>}
          {!results.loading && list.length === 0 && <li aria-disabled="true" className="muted">Sin resultados para “{query}”</li>}
          {list.map((p, i) => (
            <li
              key={p.part_id}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(p)}
            >
              <span style={{ minWidth: 0 }}>
                <strong>{p.name}</strong>{" "}
                <span className="tag">{partLabel(p)}</span>
              </span>
              <span className="num muted">disp. {fmtQty(p.available)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
