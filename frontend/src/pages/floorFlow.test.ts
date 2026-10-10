import { describe, expect, it } from "vitest";
import type { Location, PartSummary } from "../api";
import { initialState, reducer, type Action, type FloorState } from "./floorFlow";

const U101: Location = { location_id: 101, code: "U-101", name: "Estante 1", is_workbench: false, active: true };
const U102: Location = { location_id: 102, code: "U-102", name: "Estante 2", is_workbench: false, active: true };
const PART: PartSummary = {
  part_id: 7, sku: "7014 CTA/P4", name: "Rodamiento", family: null, unit_name: null,
  on_hand: 5, reserved: 0, available: 5, open_shortages: 0, min_qty: null, max_qty: null,
};
const PART2: PartSummary = { ...PART, part_id: 8, sku: null, name: "Sello" };

const run = (s: FloorState, ...actions: Action[]) => actions.reduce(reducer, s);

describe("asistente de Piso", () => {
  it("retirar avanza ubicación → pieza → orden → cantidad → confirmar", () => {
    let s = initialState("retirar");
    expect(s.step).toBe("location");
    s = run(s, { type: "location", location: U101 });
    expect(s.step).toBe("part");
    s = run(s, { type: "part", part: PART });
    expect(s.step).toBe("order");
    s = run(s, { type: "order", order: " R061026012 " }, { type: "confirmOrder" });
    expect(s.step).toBe("quantity");
    expect(s.order).toBe("R061026012");
    expect(s.orderSource).toBe("manual");
    s = run(s, { type: "quantity", quantity: 3 }, { type: "confirmQuantity" });
    expect(s.step).toBe("confirm");
  });

  it("elegir una orden propone su cantidad reservada", () => {
    const s = run(initialState("retirar"), { type: "location", location: U101 }, { type: "part", part: PART },
      { type: "pickOrder", order: "R1", source: "manual", quantity: 4 });
    expect(s.step).toBe("quantity");
    expect(s.order).toBe("R1");
    expect(s.quantity).toBe(4);
  });

  it("una orden autollenada se borra al cambiar de pieza; una tecleada se respeta", () => {
    const auto = run(initialState("retirar"), { type: "location", location: U101 }, { type: "part", part: PART },
      { type: "pickOrder", order: "R1", source: "auto", quantity: 4 });
    expect(auto.autoOrderFor).toBe(PART.part_id);
    const changed = run(auto, { type: "goto", step: "part" }, { type: "part", part: PART2 });
    expect(changed.order).toBe("");
    expect(changed.orderSource).toBeNull();
    expect(changed.quantity).toBe(1);
    expect(changed.step).toBe("order");

    const manual = run(initialState("retirar"), { type: "location", location: U101 }, { type: "part", part: PART },
      { type: "order", order: "R2" }, { type: "confirmOrder" });
    const kept = run(manual, { type: "goto", step: "part" }, { type: "part", part: PART2 });
    expect(kept.order).toBe("R2");
    expect(kept.completed).toContain("order");
  });

  it("desde la URL la orden ya viene hecha y la cantidad propuesta", () => {
    const s = initialState("retirar", "R-vieja", { order: "R061026012", quantity: 3 });
    expect(s.order).toBe("R061026012");
    expect(s.orderSource).toBe("url");
    expect(s.quantity).toBe(3);
    const next = run(s, { type: "location", location: U101 }, { type: "part", part: PART });
    expect(next.step).toBe("quantity");
    // en otros modos la orden de la URL no aplica
    expect(initialState("contar", "", { order: "R1" }).completed).toEqual([]);
  });

  it("otra pieza conserva la orden tecleada pero no la autollenada", () => {
    const base = (source: "auto" | "manual") => run(initialState("retirar"),
      { type: "location", location: U101 }, { type: "part", part: PART },
      { type: "pickOrder", order: "R1", source }, { type: "confirmQuantity" }, { type: "send" }, { type: "success" });
    const fromManual = run(base("manual"), { type: "again" });
    expect(fromManual.order).toBe("R1");
    expect(fromManual.completed).toEqual(["location", "order"]);
    const fromAuto = run(base("auto"), { type: "again" });
    expect(fromAuto.order).toBe("");
    expect(fromAuto.completed).toEqual(["location"]);
    expect(fromAuto.autoOrderFor).toBeNull();
  });

  it("corregir un paso vuelve a confirmar sin repetir los demás", () => {
    let s = run(initialState("retirar"),
      { type: "location", location: U101 }, { type: "part", part: PART },
      { type: "confirmQuantity" }, { type: "order", order: "R1" }, { type: "confirmOrder" });
    s = run(s, { type: "goto", step: "location" }, { type: "location", location: U102 });
    expect(s.step).toBe("confirm");
    expect(s.location).toBe(U102);
    expect(s.part).toBe(PART);
  });

  it("transferir usa origen y destino", () => {
    const s = run(initialState("transferir"),
      { type: "location", location: U101 }, { type: "location", location: U102 }, { type: "part", part: PART });
    expect(s.location).toBe(U101);
    expect(s.to).toBe(U102);
    expect(s.step).toBe("quantity");
  });

  it("la cantidad debe ser al menos 1", () => {
    const s = run(initialState("retirar"), { type: "location", location: U101 }, { type: "part", part: PART },
      { type: "order", order: "R1" }, { type: "confirmOrder" },
      { type: "quantity", quantity: 0 }, { type: "confirmQuantity" });
    expect(s.step).toBe("quantity");
    expect(s.notice).toMatch(/al menos 1/);
  });

  it("mientras se envía no acepta otro envío ni cambios", () => {
    const s = run(initialState("retirar"), { type: "send" });
    expect(s.sending).toBe(true);
    expect(run(s, { type: "location", location: U101 })).toBe(s);
    expect(run(s, { type: "send" })).toBe(s);
  });

  it("el formulario se limpia solo después de un 201", () => {
    const ready = run(initialState("retirar"),
      { type: "location", location: U101 }, { type: "part", part: PART },
      { type: "confirmQuantity" }, { type: "order", order: "R1" }, { type: "confirmOrder" });
    // 409: conserva todo y permite cambiar solo la ubicación
    const failed = run(ready, { type: "send" }, { type: "failure", status: 409, message: "No alcanza" });
    expect(failed.part).toBe(PART);
    expect(failed.result).toMatchObject({ ok: false, status: 409 });
    const other = run(failed, { type: "otherLocation" });
    expect(other.step).toBe("location");
    expect(other.part).toBe(PART);
    expect(run(other, { type: "location", location: U102 }).step).toBe("confirm");
    // 201: resultado y "otra pieza" conserva ubicación y orden, limpia la pieza
    const ok = run(ready, { type: "send" }, { type: "success" });
    expect(ok.step).toBe("result");
    const again = run(ok, { type: "again" });
    expect(again.location).toBe(U101);
    expect(again.order).toBe("R1");
    expect(again.part).toBeNull();
    expect(again.step).toBe("part");
  });

  it("contar acumula líneas (la última gana) y exige motivo", () => {
    let s = run(initialState("contar"), { type: "location", location: U101 });
    expect(s.step).toBe("lines");
    s = run(s, { type: "finishLines" });
    expect(s.notice).toMatch(/al menos una/);
    s = run(s,
      { type: "part", part: PART }, { type: "quantity", quantity: 4 }, { type: "addLine" },
      { type: "part", part: PART2 }, { type: "quantity", quantity: 0 }, { type: "addLine" },
      { type: "part", part: PART }, { type: "quantity", quantity: 6 }, { type: "addLine" });
    expect(s.lines.map((l) => [l.part.part_id, l.counted])).toEqual([[8, 0], [7, 6]]);
    s = run(s, { type: "finishLines" });
    expect(s.step).toBe("reason");
    s = run(s, { type: "reason", reason: "   " }, { type: "confirmReason" });
    expect(s.step).toBe("reason");
    s = run(s, { type: "reason", reason: "Conteo cíclico" }, { type: "confirmReason" });
    expect(s.step).toBe("confirm");
  });
});
