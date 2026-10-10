// Todo lo que habla con la API: tipos (nombres del contrato, snake_case, sin traducir), llamadas,
// el hook useApi y los formatos de pantalla. Contrato: kit/contract/openapi.yaml.
// Reglas: el frontend nunca calcula saldos (los pide y los vuelve a pedir tras cada POST), el dinero es
// texto y solo se formatea, y un null nunca se pinta como 0.
import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------- tipos del contrato

export type MovementType = "receipt" | "issue" | "transfer_out" | "transfer_in" | "adjustment";
export type Currency = "MXN" | "USD";

export interface LocationBalance {
  location_id: number;
  code?: string;
  on_hand: number;
  reserved: number; // siempre 0: las reservas son por pieza, no por ubicación
  available: number;
}

export interface Availability {
  part_id: number;
  on_hand: number;
  reserved: number;
  available: number;
  locations: LocationBalance[];
}

export interface Movement {
  movement_id: number | string;
  type: MovementType;
  part_id: number;
  location_id: number;
  quantity: number;
  occurred_at: string;
  reference?: string | null;
}

export interface LedgerEntry extends Movement {
  balance: number;
}

export interface Ledger {
  part_id: number;
  entries: LedgerEntry[];
}

export interface MaterialLine {
  inspection_item_id: number;
  bom_line_id: number;
  part_id: number | null;
  name: string;
  required: number | null;
  reserved: number;
  issued: number;
  missing: number | null; // 0 = no falta nada; null = falta pero sin cantidad
}

export interface WorkOrderMaterials {
  work_order_id: number;
  code: string;
  lines: MaterialLine[];
}

export interface Shortage {
  work_order_id: number;
  work_order_code: string;
  part_id: number | null;
  name: string;
  missing_quantity: number | null;
  inspection_item_id: number;
  opened_at?: string;
}

export interface ReorderSuggestion {
  part_id: number;
  sku?: string | null;
  name?: string;
  suggested_quantity: number;
  work_order_ids: number[];
}

export interface UnmatchedReceipt {
  id: number | string;
  purchase_line_id: number;
  part_number: string;
  description: string;
  quantity: number;
  unit_price?: string;
  currency?: Currency;
  received_at: string;
  work_order_code?: string | null;
  reason?: "no_match" | "ambiguous" | null; // campo extra del backend
}

export interface CountResult {
  adjustments: { part_id: number; delta: number }[];
}

// ---------------------------------------------------------------- tipos de las rutas extra

export interface PartSummary {
  part_id: number;
  sku: string | null;
  name: string;
  family: string | null;
  unit_name: string | null;
  on_hand: number;
  reserved: number;
  available: number;
  open_shortages: number;
  min_qty: number | null;
  max_qty: number | null;
}

export interface Location {
  location_id: number;
  code: string;
  name: string;
  is_workbench: boolean;
  active: boolean;
}

export type ScanResult =
  | { kind: "location"; location: Location; locations: Location[] }
  | { kind: "part"; parts: PartSummary[] };

export interface WorkOrderSummary {
  work_order_id: number;
  code: string;
  stage: string | null;
  department: string | null;
  received_at: string | null;
  lines: number;
  lines_missing: number;
}

/** Una orden viva que espera una pieza (GET /parts/{id}/work-orders): para llenar la orden al retirar. */
export interface PartOrder {
  work_order_id: number;
  code: string;
  stage: string | null;
  required: number | null;
  reserved: number; // apartado para esa orden, por entregar
  issued: number;
  missing: number; // suma de los faltantes con cantidad
  missing_unknown: boolean; // hay un faltante sin cantidad
}

export interface Policy {
  part_id: number;
  min_qty: number | null;
  max_qty: number | null;
  reorder_qty: number | null;
  lead_time_days: number | null;
}

export interface Dashboard {
  kpis: {
    parts_out_of_stock: number;
    open_shortages: number;
    open_suggestions: number;
    unmatched_receipts: number;
    active_parts: number;
    inventory_value: { currency: Currency; amount: string }[];
  };
  rotation: {
    top: { part_id: number; sku: string | null; name: string; demand: number; issued: number; received: number; on_hand: number }[];
    idle: { part_id: number; sku: string | null; name: string; on_hand: number; last_movement_at: string }[];
    idle_days: number;
  };
  forecast: {
    weeks: { week: string; demand: number; issued: number; received: number }[];
    projection: { week: string; demand: number }[];
    method: string;
  };
  consumer: ConsumerStatus;
}

export interface ConsumerStatus {
  processed: number;
  last_processed_at: string | null;
  pending: number;
  exhausted: number;
  outbox_unpublished: number;
  oldest_unpublished_at: string | null;
}

/** Asesor (POST /advisor, ruta extra): una vuelta de la conversación con El Consejero. */
export interface AdvisorTurn {
  role: "user" | "model";
  text: string;
}

export interface AdvisorAnswer {
  answer: string;
  model: string;
}

// ---------------------------------------------------------------- cliente HTTP

// Compilada, la app vive en el mismo origen que la API (/ui); con `npm run dev`, la API está en :8000.
const BASE = import.meta.env.DEV ? `${location.protocol}//${location.hostname}:8000` : "";

export class ApiError extends Error {
  constructor(
    public status: number,
    public detail: string,
  ) {
    super(detail);
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      ...init,
      headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}) },
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "Sin conexión con el servicio de inventario");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = typeof body?.detail === "string" ? body.detail : `Error ${res.status}`;
    throw new ApiError(res.status, detail);
  }
  return body as T;
}

const enc = encodeURIComponent;
const post = <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) });
const items = <T>(p: Promise<{ items: T[] }>) => p.then((r) => r.items);

export const api = {
  availability: (partId: number, signal?: AbortSignal) => request<Availability>(`/parts/${partId}/availability`, { signal }),
  ledger: (partId: number, signal?: AbortSignal) => request<Ledger>(`/parts/${partId}/ledger`, { signal }),
  part: (partId: number, signal?: AbortSignal) => request<PartSummary>(`/parts/${partId}`, { signal }),
  policy: (partId: number, signal?: AbortSignal) => request<Policy>(`/parts/${partId}/policy`, { signal }),
  partOrders: (partId: number, signal?: AbortSignal) =>
    items(request<{ items: PartOrder[] }>(`/parts/${partId}/work-orders`, { signal })),
  materials: (code: string, signal?: AbortSignal) => request<WorkOrderMaterials>(`/work-orders/${enc(code)}/materials`, { signal }),
  workOrders: (signal?: AbortSignal) => items(request<{ items: WorkOrderSummary[] }>("/work-orders", { signal })),
  shortages: (filters: { work_order_code?: string; part_id?: number }, signal?: AbortSignal) => {
    const qs = new URLSearchParams();
    if (filters.work_order_code) qs.set("work_order_code", filters.work_order_code);
    if (filters.part_id != null) qs.set("part_id", String(filters.part_id));
    return items(request<{ items: Shortage[] }>(`/shortages${qs.size ? `?${qs}` : ""}`, { signal }));
  },
  suggestions: (signal?: AbortSignal) => items(request<{ items: ReorderSuggestion[] }>("/reorder-suggestions", { signal })),
  unmatched: (signal?: AbortSignal) => items(request<{ items: UnmatchedReceipt[] }>("/unmatched-receipts", { signal })),
  parts: (q: string, signal?: AbortSignal) =>
    items(request<{ items: PartSummary[] }>(`/parts${q.trim() ? `?q=${enc(q.trim())}` : ""}`, { signal })),
  locations: (signal?: AbortSignal) => items(request<{ items: Location[] }>("/locations", { signal })),
  // El texto escaneado viaja sin alterar (los SKU traen espacios, puntos, comas y diagonales).
  scan: (code: string, signal?: AbortSignal) => request<ScanResult>(`/scan/${enc(code)}`, { signal }),
  dashboard: (signal?: AbortSignal) => request<Dashboard>("/dashboard", { signal }),

  resolveReceipt: (id: number | string, part_id: number, location_id?: number) =>
    post<Movement>(`/unmatched-receipts/${enc(String(id))}/resolve`, location_id == null ? { part_id } : { part_id, location_id }),
  issue: (body: { work_order_code: string; part_id: number; location_id: number; quantity: number; issued_by: string }) =>
    post<Movement>("/issues", body),
  transfer: (body: { part_id: number; from_location_id: number; to_location_id: number; quantity: number }) =>
    post<Movement>("/transfers", body),
  count: (body: { location_id: number; reason: string; lines: { part_id: number; counted_quantity: number }[] }) =>
    post<CountResult>("/counts", body),
  advisor: (body: { question: string; history: AdvisorTurn[]; part_id?: number; work_order_code?: string }) =>
    post<AdvisorAnswer>("/advisor", body),
};

// ---------------------------------------------------------------- useApi

export interface ApiState<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  reload: () => void;
}

/** Pide datos al montar y cuando cambian `deps`. Con `pollMs` vuelve a pedirlos cada tanto, solo con la
 *  pestaña visible (al volver a ella, pide de inmediato). Cancela lo pendiente al desmontar. */
export function useApi<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  deps: unknown[],
  opts: { pollMs?: number; enabled?: boolean } = {},
): ApiState<T> {
  const { pollMs, enabled = true } = opts;
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(enabled);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(() => setTick((t) => t + 1), []);

  // Al cambiar de recurso (no en cada recarga) se borra lo anterior para no mostrar datos de otro.
  useEffect(() => {
    setData(undefined);
    setError(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    fnRef
      .current(ctrl.signal)
      .then((d) => {
        setData(d);
        setError(undefined);
      })
      .catch((e: unknown) => {
        if ((e as Error).name === "AbortError") return;
        setError(e instanceof ApiError ? e : new ApiError(0, String(e)));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, enabled]);

  useEffect(() => {
    if (!pollMs || !enabled) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, pollMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pollMs, enabled, reload]);

  return { data, error, loading, reload };
}

// Catálogos que cambian poco: se piden una vez por sesión y se comparten entre pantallas
// (traducir location_id → U-101 en el kardex y work_order_id → código en las sugerencias).
const cache = new Map<string, Promise<unknown>>();
function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (!cache.has(key)) cache.set(key, fn().catch((e) => { cache.delete(key); throw e; }));
  return cache.get(key) as Promise<T>;
}
export const catalog = {
  locations: () => cached("locations", () => api.locations()),
  workOrders: () => cached("workOrders", () => api.workOrders()),
  refresh: (key: "locations" | "workOrders") => cache.delete(key),
};

// ---------------------------------------------------------------- formatos

const TZ = "America/Monterrey";

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-MX", { timeZone: TZ, dateStyle: "short", timeStyle: "short" });
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("es-MX", { timeZone: TZ, day: "2-digit", month: "short" });
}

/** Dinero: llega como texto decimal y solo se formatea (nunca se suma en el navegador). */
export function fmtMoney(amount: string | null | undefined, currency: Currency | null | undefined): string {
  if (amount == null || !currency) return "—";
  return new Intl.NumberFormat("es-MX", { style: "currency", currency }).format(Number(amount));
}

export function fmtQty(n: number | null | undefined, nullText = "Por definir"): string {
  if (n == null) return nullText;
  return new Intl.NumberFormat("es-MX").format(n);
}

export function fmtSigned(n: number): string {
  return n > 0 ? `+${fmtQty(n)}` : fmtQty(n);
}

/** Etiqueta física de una pieza (contrato §5): su SKU tal cual o `P-` + part_id si no tiene. */
export function partLabel(p: { part_id: number; sku?: string | null }): string {
  return p.sku ? p.sku : `P-${p.part_id}`;
}

export const MOVEMENT_LABEL: Record<MovementType, string> = {
  receipt: "Entrada",
  issue: "Salida",
  transfer_out: "Transferencia (sale)",
  transfer_in: "Transferencia (entra)",
  adjustment: "Ajuste por conteo",
};

export const STAGE_LABEL: Record<string, string> = {
  awaiting_quick_inspection: "Espera inspección rápida",
  quick_inspection: "Inspección rápida",
  awaiting_full_inspection: "Espera inspección completa",
  full_inspection: "Inspección completa",
  cleaning: "Limpieza",
  assembly: "Ensamble",
  run_in: "Asentamiento",
  final_assembly: "Ensamble final",
  final_release: "Liberación final",
};

export const DEPARTMENT_LABEL: Record<string, string> = {
  spindles: "Husillos",
  motors: "Motores",
  electronics: "Electrónica",
  torque_center: "Centro de torque",
};

export function stageLabel(stage: string | null | undefined): string {
  if (!stage) return "Sin etapa";
  return STAGE_LABEL[stage] ?? stage;
}

export const UNMATCHED_REASON_LABEL = { no_match: "Sin coincidencia", ambiguous: "Ambigua (varias piezas)" } as const;

export const ORDER_CODE = /^R\d{9}(-\d+)?$/;

/** Mensaje para el usuario según el error de la API. */
export function errorMessage(err: ApiError, context?: "issue" | "transfer" | "count" | "resolve" | "advisor"): string {
  if (err.status === 409 && (context === "issue" || context === "transfer")) return "No alcanza el saldo en esa ubicación";
  if (err.status === 409 && context === "resolve") return "Esta recepción ya estaba resuelta";
  if (err.status === 422 && context === "count") return "Falta el motivo del conteo";
  if (err.status === 502 && context === "advisor") return `El Consejero no respondió; intenta de nuevo en un momento (${err.detail})`;
  return err.detail;
}

/** Celular o tablet (el puntero principal es el dedo). En una laptop la cámara no sirve para escanear:
 *  es la frontal y de foco fijo, así que ahí no se ofrece y se usa el teclado o una pistola lectora USB. */
export function hasTouchCamera(): boolean {
  return window.matchMedia?.("(pointer: coarse)").matches ?? false;
}

/** Semáforo del consumidor para la barra superior. */
export function consumerHealth(c: ConsumerStatus | undefined, failed: boolean): { tone: "ok" | "warn" | "bad" | "unknown"; text: string } {
  if (failed) return { tone: "bad", text: "Sin conexión con el servicio" };
  if (!c) return { tone: "unknown", text: "Consumidor…" };
  if (c.exhausted > 0) return { tone: "bad", text: `${c.exhausted} evento${c.exhausted === 1 ? "" : "s"} para la DLQ` };
  // Avisos con más de un minuto sin publicarse: el publicador (vive en el consumidor) no está corriendo.
  const stuck = c.oldest_unpublished_at != null && Date.now() - new Date(c.oldest_unpublished_at).getTime() > 60_000;
  if (stuck) return { tone: "bad", text: `${c.outbox_unpublished} avisos sin publicar` };
  if (c.pending > 0) return { tone: "warn", text: `${c.pending} evento${c.pending === 1 ? "" : "s"} en espera` };
  return { tone: "ok", text: "Consumidor al día" };
}

/** localStorage puede no estar disponible (modo privado): nunca debe romper la pantalla. */
export const store = {
  get(key: string): string {
    try {
      return localStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* sin almacenamiento: se pedirá de nuevo */
    }
  },
};
