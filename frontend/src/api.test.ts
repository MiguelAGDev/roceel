import { describe, expect, it } from "vitest";
import { consumerHealth, errorMessage, ApiError, fmtMoney, fmtQty, partLabel, stageLabel, type ConsumerStatus } from "./api";
import { aimCrop, createConfirmer, pickCentered } from "./components/scanLogic";

describe("formatos", () => {
  it("un null nunca se pinta como 0", () => {
    expect(fmtQty(null)).toBe("Por definir");
    expect(fmtQty(null, "Cantidad por definir")).toBe("Cantidad por definir");
    expect(fmtQty(0)).toBe("0");
  });

  it("el dinero llega como texto y solo se formatea, por moneda", () => {
    expect(fmtMoney("1850.00", "MXN")).toMatch(/1,850\.00/);
    expect(fmtMoney("10.5", "USD")).toMatch(/10\.50/);
    expect(fmtMoney(undefined, "MXN")).toBe("—");
    expect(fmtMoney("10", undefined)).toBe("—");
  });

  it("la etiqueta de una pieza es su SKU tal cual o P- + id", () => {
    expect(partLabel({ part_id: 24, sku: null })).toBe("P-24");
    expect(partLabel({ part_id: 7, sku: "7014 CTA/P4" })).toBe("7014 CTA/P4");
  });

  it("traduce las etapas del esquema", () => {
    expect(stageLabel("full_inspection")).toBe("Inspección completa");
    expect(stageLabel(null)).toBe("Sin etapa");
  });

  it("mensajes de error según el contexto", () => {
    expect(errorMessage(new ApiError(409, "x"), "issue")).toBe("No alcanza el saldo en esa ubicación");
    expect(errorMessage(new ApiError(422, "x"), "count")).toBe("Falta el motivo del conteo");
    expect(errorMessage(new ApiError(404, "la orden R1 no existe"), "issue")).toBe("la orden R1 no existe");
  });
});

describe("semáforo del consumidor", () => {
  const base: ConsumerStatus = {
    processed: 10, last_processed_at: null, pending: 0, exhausted: 0, outbox_unpublished: 0, oldest_unpublished_at: null,
  };
  it("al día, en espera y con eventos para la DLQ", () => {
    expect(consumerHealth(base, false).tone).toBe("ok");
    expect(consumerHealth({ ...base, pending: 2 }, false).tone).toBe("warn");
    expect(consumerHealth({ ...base, exhausted: 1 }, false).tone).toBe("bad");
    expect(consumerHealth(undefined, true).tone).toBe("bad");
  });
  it("avisos atorados en el outbox = publicador caído", () => {
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(consumerHealth({ ...base, outbox_unpublished: 3, oldest_unpublished_at: old }, false).tone).toBe("bad");
  });
});

describe("lector", () => {
  it("toma el código más cercano al centro de la mira", () => {
    const d = [
      { text: "U-101", cx: 10, cy: 10 },
      { text: "7014 CTA/P4", cx: 52, cy: 48 },
      { text: "U-102", cx: 95, cy: 90 },
    ];
    expect(pickCentered(d, 100, 100)?.text).toBe("7014 CTA/P4");
    expect(pickCentered([], 100, 100)).toBeNull();
  });

  it("confirma cuando el mismo texto sale en 2 de los últimos 5 cuadros", () => {
    const c = createConfirmer(2, 5);
    expect(c.push("A")).toBeNull();
    expect(c.push(null)).toBeNull();
    expect(c.push("B")).toBeNull();
    expect(c.push("A")).toBe("A");
    // tras confirmar se olvida el historial
    expect(c.push("A")).toBeNull();
  });

  it("analiza solo la zona visible alrededor de la mira (object-fit: cover)", () => {
    // Celular vertical: video 1080×1920 en un recuadro 4:3 de 360×270 → se ve una franja central.
    const r = aimCrop(1080, 1920, 360, 270, 0.9, 0.5);
    expect(r.sw).toBe(972); // 90 % del ancho visible (todo el ancho)
    expect(r.sh).toBe(405); // 50 % del alto visible (1080 × 270/360 = 810)
    expect(r.sx).toBe(54);
    expect(r.sy).toBe(758); // centrado en el cuadro
    // Computadora: video 1280×720 en un recuadro 4:3 → se recortan los lados.
    const d = aimCrop(1280, 720, 400, 300, 0.9, 0.5);
    expect(d.sw).toBe(864); // 90 % de 960 visibles
    expect(d.sh).toBe(360);
  });

  it("una lectura fuera de la ventana no cuenta", () => {
    const c = createConfirmer(2, 5);
    c.push("A");
    for (let i = 0; i < 5; i++) c.push(null);
    expect(c.push("A")).toBeNull();
  });
});
