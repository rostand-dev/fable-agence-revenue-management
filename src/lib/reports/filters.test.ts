import { describe, expect, it } from "vitest";
import { activeFilters, filtersQuery, parseHistoryFilters } from "./filters";

describe("filtres de l'historique (US-113)", () => {
  it("lit des valeurs valides depuis un objet ou une adresse", () => {
    const f = parseHistoryFilters({ etat: "CERTIFIED", annee: "2026", resultat: "NEGATIVE" });
    expect(f).toEqual({ etat: "CERTIFIED", annee: "2026", resultat: "NEGATIVE" });
    expect(parseHistoryFilters(new URLSearchParams("etat=DRAFT&annee=2025"))).toEqual({ etat: "DRAFT", annee: "2025", resultat: null });
    expect(parseHistoryFilters({ etat: ["DRAFT", "CERTIFIED"] }).etat).toBe("DRAFT");
  });
  it("ignore sans erreur toute valeur invalide", () => {
    const f = parseHistoryFilters({ etat: "x", annee: "26", resultat: "GAGNANT" });
    expect(f).toEqual({ etat: null, annee: null, resultat: null });
    expect(parseHistoryFilters({ annee: "2026'; drop table" }).annee).toBeNull();
    expect(activeFilters(f)).toBe(0);
  });
  it("reconstruit l'adresse des exports avec les mêmes filtres", () => {
    expect(filtersQuery({ etat: "CERTIFIED", annee: "2026", resultat: null })).toBe("etat=CERTIFIED&annee=2026");
    expect(filtersQuery({ etat: null, annee: null, resultat: null })).toBe("");
    expect(activeFilters({ etat: "DRAFT", annee: null, resultat: "POSITIVE" })).toBe(2);
  });
});
