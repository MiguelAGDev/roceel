import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch, ROUTER_FUTURE } from "../test/fetchMock";
import Asesor from "./Asesor";

const part = { part_id: 7, sku: "6204-2RS", name: "Rodamiento", family: null, unit_name: null, on_hand: 1,
  reserved: 0, available: 1, open_shortages: 0, min_qty: null, max_qty: null };

function renderAsesor(url = "/asesor") {
  return render(
    <MemoryRouter future={ROUTER_FUTURE} initialEntries={[url]}>
      <Routes><Route path="/asesor" element={<Asesor />} /></Routes>
    </MemoryRouter>,
  );
}

const sentBodies = (fetch: ReturnType<typeof mockFetch>) =>
  fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init!.body)));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Asesor", () => {
  it("con ?pieza= la pregunta sugerida viaja con part_id y la respuesta se muestra con sus negritas", async () => {
    const fetch = mockFetch({
      "GET /parts/7": () => ({ body: part }),
      "POST /advisor": () => ({ body: { answer: "Pide **4**.\nVeredicto: compra ya.", model: "gemini-3.1-flash-lite" } }),
    });
    renderAsesor("/asesor?pieza=7");
    expect(await screen.findByText("6204-2RS")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "¿Cuánto pido de esta pieza?" }));
    expect((await screen.findByText("4")).tagName).toBe("STRONG");
    expect(sentBodies(fetch)).toEqual([{ question: "¿Cuánto pido de esta pieza?", history: [], part_id: 7 }]);

    // La siguiente pregunta lleva el historial
    fireEvent.change(screen.getByLabelText("Tu pregunta"), { target: { value: "¿Y si no hay dinero?" } });
    fireEvent.click(screen.getByRole("button", { name: "Preguntar" }));
    await screen.findByText("¿Y si no hay dinero?");
    await vi.waitFor(() => expect(sentBodies(fetch)).toHaveLength(2));
    expect(sentBodies(fetch)[1].history).toEqual([
      { role: "user", text: "¿Cuánto pido de esta pieza?" },
      { role: "model", text: "Pide **4**.\nVeredicto: compra ya." },
    ]);
  });

  it("sin key (503) explica cómo configurarlo y la pregunta vuelve al campo", async () => {
    mockFetch({
      "POST /advisor": () => ({ status: 503, body: { detail: "el asesor no está configurado: falta GEMINI_API_KEY en el .env de la raíz" } }),
    });
    renderAsesor();
    fireEvent.click(screen.getByRole("button", { name: "¿Qué compro primero y por qué?" }));
    expect(await screen.findByText(/falta GEMINI_API_KEY/)).toBeTruthy();
    expect((screen.getByLabelText("Tu pregunta") as HTMLTextAreaElement).value).toBe("¿Qué compro primero y por qué?");
    expect(screen.queryByText("Tú")).toBeNull();
  });
});
