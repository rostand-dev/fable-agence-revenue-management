import { describe, expect, it } from "vitest";
import { BASELINE_DAYS, baselineWindow, clipStay, effectiveDateOf, observationWindow, shiftWindow, windowDays } from "./windows";

describe("fenêtres de mesure (US-110)", () => {
  it("la référence couvre les 14 jours précédant l'entrée en vigueur, celle-ci exclue", () => {
    expect(BASELINE_DAYS).toBe(14);
    expect(baselineWindow("2026-11-24")).toEqual({ from: "2026-11-10", to: "2026-11-24" });
    expect(windowDays(baselineWindow("2026-11-24"))).toBe(14);
  });
  it("la référence franchit sans erreur un changement de mois ou d'année", () => {
    expect(baselineWindow("2027-01-05")).toEqual({ from: "2026-12-22", to: "2027-01-05" });
    expect(baselineWindow("2028-03-05")).toEqual({ from: "2028-02-20", to: "2028-03-05" }); // année bissextile
  });
  it("les séjours visés sont ramenés aux nuits encore à venir", () => {
    expect(clipStay("2026-12-01", "2026-12-10", "2026-11-24")).toEqual({ from: "2026-12-01", to: "2026-12-10" });
    expect(clipStay("2026-11-20", "2026-12-10", "2026-11-24")).toEqual({ from: "2026-11-24", to: "2026-12-10" });
    expect(clipStay("2026-11-20", "2026-11-24", "2026-11-24")).toBeNull(); // fin exclue : aucune nuit à vendre
    expect(clipStay("2026-11-01", "2026-11-10", "2026-11-24")).toBeNull();
  });
  it("l'observation va de l'entrée en vigueur au jour de la mesure exclu ; absente tant que la mesure n'est pas planifiée", () => {
    expect(observationWindow("2026-11-24", "2026-12-01")).toEqual({ from: "2026-11-24", to: "2026-12-01" });
    expect(observationWindow("2026-11-24", null)).toBeNull();
    expect(observationWindow("2026-11-24", undefined)).toBeNull();
    expect(observationWindow("2026-11-24", "2026-11-24")).toBeNull();
    expect(observationWindow("2026-11-24", "2026-11-20")).toBeNull();
  });
  it("décaler une fenêtre garde sa longueur", () => {
    const w = shiftWindow({ from: "2026-12-01", to: "2026-12-10" }, -364);
    expect(w).toEqual({ from: "2025-12-02", to: "2025-12-11" });
    expect(windowDays(w)).toBe(9);
  });
  it("jour d'entrée en vigueur : la date déclarée si elle est valide et passée, sinon le jour de l'exécution", () => {
    const at = new Date("2026-11-24T10:00:00Z");
    expect(effectiveDateOf("2026-11-22", at)).toBe("2026-11-22");
    expect(effectiveDateOf("2026-11-24", at)).toBe("2026-11-24");
    expect(effectiveDateOf("2026-11-30", at)).toBe("2026-11-24"); // dans le futur : ignorée
    expect(effectiveDateOf("24/11/2026", at)).toBe("2026-11-24");
    expect(effectiveDateOf(undefined, at)).toBe("2026-11-24");
    expect(effectiveDateOf(null, at)).toBe("2026-11-24");
  });
  it("le jour civil est celui de Paris, pas celui d'UTC", () => {
    expect(effectiveDateOf(undefined, new Date("2026-11-24T23:30:00Z"))).toBe("2026-11-25");
  });
});
