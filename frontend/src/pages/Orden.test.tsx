import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch, ROUTER_FUTURE } from "../test/fetchMock";
import Orden, { MaterialsTable } from "./Orden";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MaterialsTable", () => {
  it("resalta en rojo las líneas con faltante o sin cantidad, no las que están en 0", () => {
    render(
      <MemoryRouter future={ROUTER_FUTURE}>
        <MaterialsTable code="R061026012" lines={[
          { inspection_item_id: 1, bom_line_id: 1, part_id: 5, name: "Rodamiento", required: 2, reserved: 1, issued: 0, missing: 1 },
          { inspection_item_id: 2, bom_line_id: 2, part_id: null, name: "Tornillo raro", required: null, reserved: 0, issued: 0, missing: null },
          { inspection_item_id: 3, bom_line_id: 3, part_id: 6, name: "Sello", required: 1, reserved: 1, issued: 0, missing: 0 },
        ]} />
      </MemoryRouter>,
    );
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0].className).toContain("row-danger");
    expect(rows[1].className).toContain("row-danger");
    expect(rows[2].className).not.toContain("row-danger");
    expect(within(rows[1]).getByText("Sin identificar")).toBeTruthy();
    expect(within(rows[1]).getByText("Cantidad por definir")).toBeTruthy();
    expect(within(rows[1]).getByText("Por definir")).toBeTruthy(); // required: null
    // "Retirar" solo en líneas con pieza identificada y algo reservado; lleva orden, pieza y cantidad a Piso
    const links = screen.getAllByRole("link", { name: /^Retirar/ });
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute("href")).toBe("/piso?modo=retirar&orden=R061026012&pieza=5&cant=1");
    expect(within(rows[1]).queryByRole("link", { name: /^Retirar/ })).toBeNull();
  });
});

describe("Orden", () => {
  it("una orden que no existe muestra 'Orden no encontrada'", async () => {
    mockFetch({
      "GET /work-orders": () => ({ body: { items: [] } }),
      "GET /work-orders/R000000000/materials": () => ({ status: 404, body: { detail: "la orden R000000000 no existe" } }),
    });
    render(
      <MemoryRouter future={ROUTER_FUTURE} initialEntries={["/ordenes/R000000000"]}>
        <Routes><Route path="/ordenes/:code" element={<Orden />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Orden no encontrada")).toBeTruthy();
  });
});
