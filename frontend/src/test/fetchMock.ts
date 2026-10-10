// fetch simulado por ruta, para las pruebas de componentes.
import { vi } from "vitest";

export type Handler = (url: URL, init?: RequestInit) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;

export function mockFetch(routes: Record<string, Handler>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://test");
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    const handler = routes[key] ?? Object.entries(routes).find(([k]) => k.endsWith("*") && key.startsWith(k.slice(0, -1)))?.[1];
    if (!handler) return new Response(JSON.stringify({ detail: `sin mock para ${key}` }), { status: 404 });
    const { status = 200, body } = await handler(url, init);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

export const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true };
