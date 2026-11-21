import { describe, expect, it } from "vitest";
import { calendarStateOf, evaluateQuality, pricesProblem, type QualityFacts } from "./quality";

const ok: QualityFacts = { identityOk: true, pricelabsLinked: true, calendar: { status: "OK", days: 90, at: new Date().toISOString() }, economicsMissing: 0, mappingStatus: "CONFIRMED", prices: { basePriceCents: 12000, minPriceCents: 8000, maxPriceCents: 20000 }, superhoteLinked: true, provisionalCount: 0 };

describe("checklist de qualité (US-024)", () => {
  it("dossier complet : activable, aucun avertissement", () => {
    const r = evaluateQuality(ok);
    expect(r).toMatchObject({ canActivate: true, blockers: [], warnings: [] });
  });
  it("chaque point bloquant empêche l'activation", () => {
    const cases: [Partial<QualityFacts>, string][] = [
      [{ identityOk: false }, "identity"], [{ pricelabsLinked: false }, "pricelabs"], [{ calendar: { status: "NEVER", days: null, at: null } }, "calendar"], [{ calendar: { status: "FAILED", days: null, at: null } }, "calendar"], [{ calendar: { status: "STALE", days: 90, at: "2020-01-01T00:00:00Z" } }, "calendar"],
      [{ economicsMissing: 2 }, "economics"], [{ mappingStatus: "TO_CONFIRM" }, "mapping"], [{ mappingStatus: "STALE" }, "mapping"], [{ mappingStatus: "INCOMPLETE" }, "mapping"],
      [{ prices: { basePriceCents: null, minPriceCents: 8000, maxPriceCents: null } }, "prices"],
    ];
    for (const [patch, key] of cases) { const r = evaluateQuality({ ...ok, ...patch }); expect(r.canActivate, key).toBe(false); expect(r.blockers, key).toContain(key as never); }
  });
  it("SuperHote absent et valeurs provisoires : avertissements, pas de blocage", () => {
    const r = evaluateQuality({ ...ok, superhoteLinked: false, provisionalCount: 3 });
    expect(r.canActivate).toBe(true);
    expect(r.warnings).toEqual(["superhote", "provisional"]);
    expect(r.items.find((i) => i.key === "provisional")?.detail).toContain("3 valeurs provisoires");
  });
  it("cohérence des prix : inconnu ≠ valide, minimum > base et maximum < base refusés", () => {
    expect(pricesProblem({ basePriceCents: 12000, minPriceCents: 8000, maxPriceCents: null })).toBeNull();
    expect(pricesProblem({ basePriceCents: null, minPriceCents: 8000, maxPriceCents: null })).toMatch(/base inconnu/);
    expect(pricesProblem({ basePriceCents: 12000, minPriceCents: null, maxPriceCents: null })).toMatch(/minimum inconnu/);
    expect(pricesProblem({ basePriceCents: 12000, minPriceCents: 13000, maxPriceCents: null })).toMatch(/dépasse/);
    expect(pricesProblem({ basePriceCents: 12000, minPriceCents: 8000, maxPriceCents: 11000 })).toMatch(/maximum/);
  });
  it("état de la grille : réussie et récente seulement", () => {
    const now = Date.parse("2026-11-21T12:00:00Z");
    expect(calendarStateOf(null, now).status).toBe("NEVER");
    expect(calendarStateOf({ ok: false, at: "2026-11-21T11:00:00Z" }, now).status).toBe("FAILED");
    expect(calendarStateOf({ ok: true, at: "2026-11-21T11:00:00Z", days: 0 }, now).status).toBe("NEVER");
    expect(calendarStateOf({ ok: true, at: "2026-11-18T11:00:00Z", days: 90 }, now).status).toBe("STALE");
    expect(calendarStateOf({ ok: true, days: 90 }, now).status).toBe("STALE");
    expect(calendarStateOf({ ok: true, at: "2026-11-21T11:00:00Z", days: 90 }, now)).toMatchObject({ status: "OK", days: 90 });
  });
  it("prix maximum nul ou négatif refusé ; détails au pluriel", () => {
    expect(pricesProblem({ basePriceCents: 12000, minPriceCents: 8000, maxPriceCents: 0 })).toMatch(/invalide/);
    expect(evaluateQuality({ ...ok, economicsMissing: 2 }).items.find((i) => i.key === "economics")?.detail).toBe("2 valeurs manquantes (coûts et seuils).");
    expect(evaluateQuality({ ...ok, economicsMissing: 1 }).items.find((i) => i.key === "economics")?.fix).toBe("couts");
  });
});
