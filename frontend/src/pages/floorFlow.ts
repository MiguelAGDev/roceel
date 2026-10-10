// Estado del asistente de Piso (Retirar · Transferir · Contar), como reducer puro para poder probarlo.
// Reglas: cada paso confirmado avanza al siguiente que falte; un paso hecho se puede corregir;
// el formulario se limpia SOLO después de un 201; mientras se envía no se acepta otro envío.
import type { CountResult, Location, Movement, PartSummary } from "../api";

export type Mode = "retirar" | "transferir" | "contar";
export type StepKey = "location" | "to" | "part" | "quantity" | "order" | "lines" | "reason";
export type Step = StepKey | "confirm" | "result";

export const MODES: Mode[] = ["retirar", "transferir", "contar"];

// En Retirar la orden va antes de la cantidad: al elegirla se propone lo que tiene reservado.
export const STEPS: Record<Mode, StepKey[]> = {
  retirar: ["location", "part", "order", "quantity"],
  transferir: ["location", "to", "part", "quantity"],
  contar: ["location", "lines", "reason"],
};

export const STEP_LABEL: Record<Mode, Record<StepKey, string>> = {
  retirar: { location: "Ubicación", to: "", part: "Pieza", quantity: "Cantidad", order: "Orden", lines: "", reason: "" },
  transferir: { location: "Origen", to: "Destino", part: "Pieza", quantity: "Cantidad", order: "", lines: "", reason: "" },
  contar: { location: "Ubicación", to: "", part: "Pieza", quantity: "Contadas", order: "", lines: "Piezas contadas", reason: "Motivo" },
};

export interface CountLine {
  part: PartSummary;
  counted: number;
}

export type Candidates =
  | { kind: "part"; items: PartSummary[] }
  | { kind: "location"; items: Location[] };

export type Result =
  | { ok: true; movement?: Movement; count?: CountResult; snapshot: FloorState }
  | { ok: false; status: number; message: string };

/** De dónde salió la orden: de la URL (botón Retirar en Órdenes), autollenada (única orden que espera
 *  la pieza) o tecleada/elegida por el usuario. */
export type OrderSource = "url" | "auto" | "manual";

export interface FloorState {
  mode: Mode;
  step: Step;
  completed: StepKey[];
  location: Location | null;
  to: Location | null;
  part: PartSummary | null;
  quantity: number;
  order: string;
  orderSource: OrderSource | null;
  /** Pieza para la que ya se autollenó la orden: si el usuario vuelve a corregirla, no se repite. */
  autoOrderFor: number | null;
  lines: CountLine[];
  reason: string;
  candidates: Candidates | null;
  notice: string | null;
  sending: boolean;
  result: Result | null;
}

/** `prefill` viene de la URL (botón Retirar en Órdenes): la orden queda hecha y la cantidad propuesta. */
export function initialState(mode: Mode, order = "", prefill?: { order: string; quantity?: number }): FloorState {
  const fromUrl = mode === "retirar" && prefill?.order ? prefill : null;
  return {
    mode,
    step: STEPS[mode][0],
    completed: fromUrl ? ["order"] : [],
    location: null,
    to: null,
    part: null,
    quantity: fromUrl?.quantity && fromUrl.quantity > 0 ? fromUrl.quantity : 1,
    order: fromUrl ? fromUrl.order : order,
    orderSource: fromUrl ? "url" : null,
    autoOrderFor: null,
    lines: [],
    reason: "",
    candidates: null,
    notice: null,
    sending: false,
    result: null,
  };
}

export type Action =
  | { type: "mode"; mode: Mode; order?: string }
  | { type: "goto"; step: StepKey }
  | { type: "location"; location: Location }
  | { type: "part"; part: PartSummary }
  | { type: "quantity"; quantity: number }
  | { type: "confirmQuantity" }
  | { type: "order"; order: string }
  | { type: "confirmOrder" }
  | { type: "pickOrder"; order: string; quantity?: number; source: OrderSource }
  | { type: "addLine" }
  | { type: "removeLine"; index: number }
  | { type: "finishLines" }
  | { type: "reason"; reason: string }
  | { type: "confirmReason" }
  | { type: "candidates"; candidates: Candidates }
  | { type: "notice"; notice: string | null }
  | { type: "send" }
  | { type: "success"; movement?: Movement; count?: CountResult }
  | { type: "failure"; status: number; message: string }
  | { type: "otherLocation" }
  | { type: "again" }
  | { type: "reset"; order?: string };

/** Primer paso del modo que aún no está hecho; si todos lo están, a confirmar. */
export function nextStep(mode: Mode, completed: StepKey[]): Step {
  return STEPS[mode].find((s) => !completed.includes(s)) ?? "confirm";
}

function complete(state: FloorState, key: StepKey, patch: Partial<FloorState>): FloorState {
  const completed = state.completed.includes(key) ? state.completed : [...state.completed, key];
  return { ...state, ...patch, completed, step: nextStep(state.mode, completed), candidates: null, notice: null, result: null };
}

export function reducer(state: FloorState, action: Action): FloorState {
  if (state.sending && action.type !== "success" && action.type !== "failure") return state;
  switch (action.type) {
    case "mode":
      return initialState(action.mode, action.order ?? state.order);
    case "goto":
      return { ...state, step: action.step, candidates: null, notice: null, result: null };
    case "location":
      if (state.step === "to") return complete(state, "to", { to: action.location });
      return complete(state, "location", { location: action.location });
    case "part":
      // En conteo, la pieza es la de la línea que se está capturando (no es un paso del modo).
      if (state.mode === "contar") return { ...state, part: action.part, quantity: 0, candidates: null, notice: null };
      // Una orden autollenada era de la pieza anterior: se borra para buscar las de la nueva.
      // Una orden de la URL o tecleada por el usuario se respeta.
      if (state.orderSource === "auto" && state.part?.part_id !== action.part.part_id) {
        return complete(
          { ...state, order: "", orderSource: null, quantity: 1, completed: state.completed.filter((s) => s !== "order") },
          "part",
          { part: action.part },
        );
      }
      return complete(state, "part", { part: action.part });
    case "quantity":
      return { ...state, quantity: Math.max(0, Math.trunc(action.quantity) || 0) };
    case "confirmQuantity":
      if (state.quantity < 1) return { ...state, notice: "La cantidad debe ser al menos 1" };
      return complete(state, "quantity", {});
    case "order":
      return { ...state, order: action.order };
    case "confirmOrder":
      if (!state.order.trim()) return { ...state, notice: "Falta el código de la orden" };
      return complete(state, "order", { order: state.order.trim(), orderSource: "manual" });
    case "pickOrder":
      return complete(state, "order", {
        order: action.order,
        orderSource: action.source,
        autoOrderFor: action.source === "auto" ? state.part?.part_id ?? null : state.autoOrderFor,
        ...(action.quantity && action.quantity > 0 ? { quantity: action.quantity } : {}),
      });
    case "addLine": {
      if (!state.part) return state;
      // Si la pieza ya estaba en la lista, se reemplaza su conteo (gana el último, igual que la API).
      const lines = [...state.lines.filter((l) => l.part.part_id !== state.part!.part_id), { part: state.part, counted: state.quantity }];
      return { ...state, lines, part: null, quantity: 0, notice: null };
    }
    case "removeLine":
      return { ...state, lines: state.lines.filter((_, i) => i !== action.index) };
    case "finishLines":
      if (!state.lines.length) return { ...state, notice: "Agrega al menos una pieza contada" };
      return complete(state, "lines", { part: null });
    case "reason":
      return { ...state, reason: action.reason };
    case "confirmReason":
      if (!state.reason.trim()) return { ...state, notice: "Falta el motivo del conteo" };
      return complete(state, "reason", {});
    case "candidates":
      return { ...state, candidates: action.candidates, notice: null };
    case "notice":
      return { ...state, notice: action.notice };
    case "send":
      return { ...state, sending: true, result: null, notice: null };
    case "success":
      return {
        ...state,
        sending: false,
        step: "result",
        result: { ok: true, movement: action.movement, count: action.count, snapshot: state },
      };
    case "failure":
      return { ...state, sending: false, result: { ok: false, status: action.status, message: action.message } };
    case "otherLocation":
      // 409: no alcanza en esa ubicación. Se cambia solo la ubicación (origen) y se conserva lo demás.
      return { ...state, location: null, completed: state.completed.filter((s) => s !== "location"), step: "location", result: null };
    case "again": {
      // Otra pieza en la misma ubicación (y mismo destino / misma orden): se limpia solo la pieza.
      // Una orden autollenada no se conserva: la siguiente pieza puede esperarla otra orden.
      const keepOrder = state.orderSource !== "auto";
      const keep: StepKey[] = state.mode === "contar"
        ? ["location"]
        : state.completed.filter((s) => s === "location" || s === "to" || (s === "order" && keepOrder));
      const base = initialState(state.mode, keepOrder ? state.order : "");
      return {
        ...base, location: state.location, to: state.to, completed: keep, step: nextStep(state.mode, keep),
        orderSource: keepOrder && keep.includes("order") ? state.orderSource : null,
      };
    }
    case "reset":
      return initialState(state.mode, action.order ?? state.order);
  }
}
