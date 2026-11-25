import { describe, expect, it } from "vitest";
import { capFromSettings, parseMonthlyCapEur, usdToEur } from "./cap";

describe("plafond mensuel en euros", () => {
  it("vide ou absent = aucun plafond (valeur par défaut)", () => {
    for (const v of [undefined, null, "", "  "]) expect(parseMonthlyCapEur(v)).toEqual({ ok: true, value: null });
    expect(capFromSettings({})).toBeNull();
    expect(capFromSettings(null)).toBeNull();
  });
  it("accepte un montant (virgule française comprise)", () => {
    expect(parseMonthlyCapEur("25")).toEqual({ ok: true, value: 25 });
    expect(parseMonthlyCapEur("12,5")).toEqual({ ok: true, value: 12.5 });
    expect(parseMonthlyCapEur(40)).toEqual({ ok: true, value: 40 });
    expect(capFromSettings({ llmMonthlyCapEur: 30 })).toBe(30);
  });
  it("refuse zéro, négatif, texte, trop grand ou plus de 2 décimales ; une valeur invalide en base = aucun plafond", () => {
    for (const v of ["0", "-5", "abc", "100001", "1,234", NaN]) expect(parseMonthlyCapEur(v).ok).toBe(false);
    expect(capFromSettings({ llmMonthlyCapEur: -3 })).toBeNull();
  });
  it("conversion dollar → euro au taux fixe", () => { expect(usdToEur(10, 0.92)).toBe(9.2); });
});

import { parseMonthlyCapEur as parseCap } from "./cap-state";
describe("saisie du plafond avec espaces", () => {
  it("espaces et espaces insécables ignorés, virgule décimale acceptée", () => {
    expect(parseCap("1 000")).toEqual({ ok: true, value: 1000 });
    expect(parseCap("1 000,50")).toEqual({ ok: true, value: 1000.5 });
    expect(parseCap("1 000")).toEqual({ ok: true, value: 1000 });
  });
});
