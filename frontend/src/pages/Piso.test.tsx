import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockFetch, ROUTER_FUTURE, type Handler } from "../test/fetchMock";
import Piso from "./Piso";

const U101 = { location_id: 101, code: "U-101", name: "Estante 1", is_workbench: false, active: true };
const part = (id: number, name: string) => ({
  part_id: id, sku: "7014 CTA/P4", name, family: "REFACCIÓN", unit_name: "PIEZA",
  on_hand: 3, reserved: 0, available: 3, open_shortages: 0, min_qty: null, max_qty: null,
});
const waitingOrder = (id: number, code: string, reserved: number, missing = 0) => ({
  work_order_id: id, code, stage: "assembly", required: reserved + missing, reserved, issued: 0, missing, missing_unknown: false,
});

/** Rutas comunes: U-101, una sola pieza para cualquier otro código, sin órdenes que la esperen. */
function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    "GET /scan/U-101": () => ({ body: { kind: "location", location: U101, locations: [U101] } }),
    "GET /scan/*": () => ({ body: { kind: "part", parts: [part(1, "Rodamiento")] } }),
    "GET /parts/1/availability": () => ({ body: { part_id: 1, on_hand: 3, reserved: 0, available: 3, locations: [] } }),
    "GET /parts/2/availability": () => ({ body: { part_id: 2, on_hand: 3, reserved: 0, available: 3, locations: [] } }),
    "GET /parts/1/work-orders": () => ({ body: { items: [] } }),
    "GET /parts/2/work-orders": () => ({ body: { items: [] } }),
    "GET /work-orders": () => ({ body: { items: [] } }),
    ...extra,
  };
}

function renderPiso(url = "/piso?modo=retirar") {
  return render(
    <MemoryRouter future={ROUTER_FUTURE} initialEntries={[url]}>
      <Routes><Route path="/piso" element={<Piso />} /></Routes>
    </MemoryRouter>,
  );
}

async function typeCode(code: string) {
  const input = screen.getByLabelText("Teclear el código");
  fireEvent.change(input, { target: { value: code } });
  fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
}

beforeEach(() => {
  localStorage.setItem("piso.camera", "off"); // jsdom no tiene cámara
  localStorage.setItem("piso.issued_by", "ana");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Piso · Retirar", () => {
  it("un SKU de varias piezas pide elegir (nunca toma la primera) y el SKU viaja sin alterar", async () => {
    const fetch = mockFetch(routes({
      "GET /scan/*": () => ({ body: { kind: "part", parts: [part(1, "Rodamiento A"), part(2, "Rodamiento B")] } }),
    }));
    renderPiso();
    await typeCode("U-101");
    expect(await screen.findByText("Escanea la pieza")).toBeTruthy();
    await typeCode("7014 CTA/P4");
    expect(await screen.findByText(/varias piezas: elige/)).toBeTruthy();
    expect(fetch.mock.calls.some(([u]) => String(u).endsWith("/scan/7014%20CTA%2FP4"))).toBe(true);
    fireEvent.click(screen.getByText("Rodamiento B"));
    expect(await screen.findByText("¿Para qué orden?")).toBeTruthy();
  });

  it("si una sola orden espera la pieza, la orden se llena sola y la cantidad sale con lo reservado", async () => {
    mockFetch(routes({ "GET /parts/1/work-orders": () => ({ body: { items: [waitingOrder(9, "R061026012", 2)] } }) }));
    renderPiso();
    await typeCode("U-101");
    await screen.findByText("Escanea la pieza");
    await typeCode("ROD");
    expect(await screen.findByText("¿Cuántas?")).toBeTruthy();
    expect((screen.getByLabelText("Cantidad") as HTMLInputElement).value).toBe("2");
    const orderStep = screen.getByRole("button", { name: "Corregir Orden" });
    expect(orderStep.textContent).toContain("R061026012");
    expect(orderStep.textContent).toContain("auto");
    // Volver a corregir la orden no la vuelve a llenar sola: muestra la lista
    fireEvent.click(orderStep);
    expect(await screen.findByText("¿Para qué orden?")).toBeTruthy();
    expect(screen.getByText("Órdenes que esperan esta pieza:")).toBeTruthy();
  });

  it("si varias órdenes esperan la pieza, se elige con un toque", async () => {
    mockFetch(routes({
      "GET /parts/1/work-orders": () => ({ body: { items: [waitingOrder(9, "R061026012", 2), waitingOrder(10, "R061026013", 0, 4)] } }),
    }));
    renderPiso();
    await typeCode("U-101");
    await screen.findByText("Escanea la pieza");
    await typeCode("ROD");
    expect(await screen.findByText("Órdenes que esperan esta pieza:")).toBeTruthy();
    expect(screen.getByText("falta 4")).toBeTruthy();
    fireEvent.click(screen.getByText("R061026012"));
    expect(await screen.findByText("¿Cuántas?")).toBeTruthy();
    expect((screen.getByLabelText("Cantidad") as HTMLInputElement).value).toBe("2");
  });

  it("desde Órdenes llegan la orden, la pieza y la cantidad: solo falta la ubicación", async () => {
    mockFetch(routes({ "GET /parts/1": () => ({ body: part(1, "Rodamiento") }) }));
    renderPiso("/piso?modo=retirar&orden=R061026012&pieza=1&cant=3");
    expect(await screen.findByText("Escanea la ubicación")).toBeTruthy();
    expect((await screen.findByRole("button", { name: "Corregir Pieza" })).textContent).toBe("7014 CTA/P4");
    expect(screen.getByRole("button", { name: "Corregir Orden" }).textContent).toContain("R061026012");
    await typeCode("U-101");
    expect(await screen.findByText("¿Cuántas?")).toBeTruthy();
    expect((screen.getByLabelText("Cantidad") as HTMLInputElement).value).toBe("3");
  });

  it("sin nombre de quien retira se pide arriba y no deja confirmar", async () => {
    localStorage.removeItem("piso.issued_by");
    mockFetch(routes());
    renderPiso();
    expect(screen.getByLabelText("¿Quién retira?")).toBeTruthy();
    await typeCode("U-101");
    await screen.findByText("Escanea la pieza");
    await typeCode("ROD");
    fireEvent.change(await screen.findByLabelText("Código de la orden"), { target: { value: "R061026012" } });
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await screen.findByText("¿Cuántas?");
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    expect((await screen.findByRole("button", { name: "Confirmar retiro" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("¿Quién retira?"), { target: { value: "Ana" } });
    fireEvent.click(screen.getByRole("button", { name: "Listo" }));
    expect(await screen.findByText("Ana")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Confirmar retiro" }) as HTMLButtonElement).disabled).toBe(false);
    expect(localStorage.getItem("piso.issued_by")).toBe("Ana");
  });

  it("un 409 conserva los datos y ofrece otra ubicación; el doble toque envía una sola salida", async () => {
    let release!: () => void;
    const fetch = mockFetch(routes({
      "POST /issues": () => new Promise((resolve) => {
        release = () => resolve({ status: 409, body: { detail: "en la ubicación 101 hay 3 y se piden 5" } });
      }),
    }));
    renderPiso();
    await typeCode("U-101");
    await screen.findByText("Escanea la pieza");
    await typeCode("ROD");
    fireEvent.change(await screen.findByLabelText("Código de la orden"), { target: { value: "R061026012" } });
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await screen.findByText("¿Cuántas?");
    fireEvent.change(screen.getByLabelText("Cantidad"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));

    const confirm = await screen.findByRole("button", { name: "Confirmar retiro" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    release();
    expect(await screen.findByText(/No alcanza el saldo en esa ubicación/)).toBeTruthy();
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Escanear otra ubicación" }));
    expect(await screen.findByText("Escanea la ubicación")).toBeTruthy();
    // la pieza y la orden siguen capturadas en el riel de pasos
    expect(screen.getByRole("button", { name: "Corregir Pieza" }).textContent).toBe("7014 CTA/P4");
    expect(screen.getByRole("button", { name: "Corregir Orden" }).textContent).toContain("R061026012");
  });
});
