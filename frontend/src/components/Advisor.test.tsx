import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch, ROUTER_FUTURE } from "../test/fetchMock";
import Advisor, { openAdvisor } from "./Advisor";

const part = { part_id: 7, sku: "6204-2RS", name: "Rodamiento", family: null, unit_name: null, on_hand: 1,
  reserved: 0, available: 1, open_shortages: 0, min_qty: null, max_qty: null };

const answer = {
  answer: "Retira **2** ya.\nVeredicto: no lo dejes en el estante.",
  actions: [{ label: "Retirar 2 de 6204-2RS para R061026012", to: "/piso?modo=retirar&orden=R061026012&pieza=7&cant=2" }],
  follow_ups: ["¿Y si no alcanza?", "¿Cuándo pido más?"],
  model: "gemini-3.1-flash-lite",
};

function renderAt(url: string) {
  return render(<MemoryRouter future={ROUTER_FUTURE} initialEntries={[url]}><Advisor /></MemoryRouter>);
}

const sentBodies = (fetch: ReturnType<typeof mockFetch>) =>
  fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init!.body)));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("El Consejero (ventana flotante)", () => {
  it("en el kardex pregunta sobre esa pieza, pinta las acciones como enlaces y cambia a las preguntas siguientes", async () => {
    const fetch = mockFetch({ "GET /parts/7": () => ({ body: part }), "POST /advisor": () => ({ body: answer }) });
    renderAt("/kardex/7");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Abrir El Consejero" }));
    expect(await screen.findByText("6204-2RS")).toBeTruthy(); // "Sobre: <SKU>"

    fireEvent.click(screen.getByRole("button", { name: "¿Cuánto pido de esta pieza?" }));
    expect((await screen.findByText("2")).tagName).toBe("STRONG");
    expect(sentBodies(fetch)).toEqual([{ question: "¿Cuánto pido de esta pieza?", history: [], part_id: 7 }]);

    const action = screen.getByRole("link", { name: /Retirar 2 de 6204-2RS/ });
    expect(action.getAttribute("href")).toBe("/piso?modo=retirar&orden=R061026012&pieza=7&cant=2");
    // Las sugerencias ahora salen de la conversación
    expect(screen.getByRole("button", { name: "¿Y si no alcanza?" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "¿Cuánto pido de esta pieza?" })).toBeNull();

    // La siguiente pregunta lleva el historial (solo texto, sin acciones)
    fireEvent.click(screen.getByRole("button", { name: "¿Y si no alcanza?" }));
    await vi.waitFor(() => expect(sentBodies(fetch)).toHaveLength(2));
    expect(sentBodies(fetch)[1].history).toEqual([
      { role: "user", text: "¿Cuánto pido de esta pieza?" },
      { role: "model", text: answer.answer },
    ]);
  });

  it("en una orden manda work_order_code; Esc cierra y la conversación sigue al reabrir", async () => {
    const fetch = mockFetch({ "POST /advisor": () => ({ body: answer }) });
    renderAt("/ordenes/R061026012");
    act(() => openAdvisor());
    fireEvent.click(await screen.findByRole("button", { name: "¿Por qué le falta material a esta orden?" }));
    await screen.findByText(/Veredicto/);
    expect(sentBodies(fetch)[0].work_order_code).toBe("R061026012");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Abrir El Consejero" }));
    expect(screen.getByText(/Veredicto/)).toBeTruthy();
  });

  it("sin key (503) explica cómo configurarlo y la pregunta vuelve al campo", async () => {
    mockFetch({
      "POST /advisor": () => ({ status: 503, body: { detail: "el asesor no está configurado: falta GEMINI_API_KEY en el .env de la raíz" } }),
    });
    renderAt("/tablero");
    fireEvent.click(screen.getByRole("button", { name: "Abrir El Consejero" }));
    fireEvent.click(screen.getByRole("button", { name: "¿Qué compro primero y por qué?" }));
    expect(await screen.findByText(/falta GEMINI_API_KEY/)).toBeTruthy();
    expect((screen.getByLabelText("Tu pregunta") as HTMLTextAreaElement).value).toBe("¿Qué compro primero y por qué?");
    expect(screen.queryByText("Tú")).toBeNull();
  });
});
