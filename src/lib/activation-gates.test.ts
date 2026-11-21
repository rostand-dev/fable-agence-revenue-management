import { describe, expect, it } from "vitest";
import { emptyEconomics } from "./engine/economics";
import { floorFingerprint, floorsState, parseReconciliation, reconciliationState, shadowMinDays, shadowState } from "./activation-gates";
import type { EconomicModel } from "./engine/types";

const econ = (over: Partial<EconomicModel> = {}): EconomicModel => ({ ...emptyEconomics(), cleaningFeeChargedCents: 5000, cleaningCostCents: 4000, linenCostCents: 1000, nightlyVariableCostCents: 500, hardContributionPerNightCents: 3000, strategyContributionPerNightCents: 4000, channels: { AIRBNB: { commissionPct: 15.5, paymentFeePct: 0 } } as never, ...over });
const NOW = Date.parse("2026-11-21T12:00:00Z");

describe("observation d'au moins 14 jours", () => {
  it("inconnue sans date de lancement, en attente puis satisfaite", () => {
    expect(shadowState(null, NOW).status).toBe("UNKNOWN");
    expect(shadowState("pas une date", NOW).status).toBe("UNKNOWN");
    expect(shadowState("2026-11-10T12:00:00Z", NOW)).toMatchObject({ status: "WAITING", days: 11, readyAt: "2026-11-24T12:00:00.000Z" });
    expect(shadowState("2026-11-07T12:00:00Z", NOW)).toMatchObject({ status: "OK", days: 14 });
    expect(shadowState("2026-11-07T12:00:01Z", NOW).status).toBe("WAITING");
  });
});

describe("durée minimale d'observation configurable (ACTIVATION_SHADOW_MIN_DAYS)", () => {
  it("14 par défaut ; valeur invalide ou hors plage : retour à 14, jamais un délai raccourci", () => {
    expect(shadowMinDays(undefined)).toBe(14);
    for (const bad of ["", " ", "abc", "-1", "1.5", "7 jours", "91", "9999", "1e1", "0x7"]) expect(shadowMinDays(bad), bad).toBe(14);
    expect(shadowMinDays("7")).toBe(7); expect(shadowMinDays(" 30 ")).toBe(30); expect(shadowMinDays("90")).toBe(90); expect(shadowMinDays("0")).toBe(0);
  });
  it("durée paramétrable ; 0 : satisfaite dès le lancement, mais une date inconnue ne valide jamais", () => {
    const launch = "2026-11-21T11:59:00Z";
    expect(shadowState(launch, NOW, 14).status).toBe("WAITING");
    expect(shadowState(launch, NOW, 7)).toMatchObject({ status: "WAITING", minDays: 7, readyAt: "2026-11-28T11:59:00.000Z" });
    expect(shadowState(launch, NOW, 0)).toMatchObject({ status: "OK", minDays: 0 });
    expect(shadowState("2026-11-21T12:00:01Z", NOW, 0).status).toBe("WAITING"); // lancement dans le futur
    expect(shadowState(null, NOW, 0).status).toBe("UNKNOWN");
  });
});

describe("planchers validés", () => {
  it("empreinte stable, sensible aux coûts, nulle si le modèle est incomplet", () => {
    const a = floorFingerprint(econ());
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(floorFingerprint(econ())).toBe(a);
    expect(floorFingerprint(econ({ cleaningCostCents: 4500 }))).not.toBe(a);
    expect(floorFingerprint(econ({ hardContributionPerNightCents: null }))).toBeNull();
    expect(floorFingerprint(emptyEconomics())).toBeNull();
  });
  it("empreinte canonique : l'ordre des canaux dans le modèle ne la change pas", () => {
    const ch = { AIRBNB: { commissionPct: 15.5, paymentFeePct: 0 }, BOOKING: { commissionPct: 17, paymentFeePct: 1.5 } };
    const rev = { BOOKING: ch.BOOKING, AIRBNB: ch.AIRBNB };
    expect(floorFingerprint(econ({ channels: ch as never }))).toBe(floorFingerprint(econ({ channels: rev as never })));
  });
  it("états : incomplet, non validé, validé, périmé après changement de coûts", () => {
    const fp = floorFingerprint(econ())!, row = { fingerprint: fp, validatedByName: "Rosy", createdAt: "2026-11-20T10:00:00Z" };
    expect(floorsState(null, null).status).toBe("INCOMPLETE");
    expect(floorsState(row, null).status).toBe("INCOMPLETE");
    expect(floorsState(null, fp).status).toBe("NONE");
    expect(floorsState(row, fp)).toMatchObject({ status: "OK", by: "Rosy" });
    expect(floorsState(row, floorFingerprint(econ({ cleaningCostCents: 4500 }))).status).toBe("STALE");
  });
});

describe("rapprochement d'un échantillon", () => {
  it("saisie contrôlée", () => {
    expect(parseReconciliation({ sampleSize: "12", maxGapPct: "0,4", source: "SuperHote vs Airbnb" })).toEqual({ ok: true, value: { sampleSize: 12, maxGapPct: 0.4, source: "SuperHote vs Airbnb", note: null } });
    for (const bad of [{ sampleSize: "0" }, { sampleSize: "10.5" }, { sampleSize: "5000" }, { maxGapPct: "abc" }, { maxGapPct: "-1" }, { maxGapPct: "101" }, { source: "x" }, { note: "n".repeat(301) }])
      expect(parseReconciliation({ sampleSize: "12", maxGapPct: "0", source: "SuperHote", ...bad }).ok, JSON.stringify(bad)).toBe(false);
    expect(parseReconciliation({ sampleSize: "12", maxGapPct: "", source: "SuperHote" }).ok).toBe(false); // un écart non renseigné n'est pas zéro
    for (const bad of ["1e1", "0x10", "1 000", " ", "1 0", "-2", "+3"]) expect(parseReconciliation({ sampleSize: bad, maxGapPct: "0", source: "SuperHote" }).ok, bad).toBe(false);
    expect(parseReconciliation({ sampleSize: 12, maxGapPct: "0", source: { a: 1 } }).ok).toBe(false); // l'API ne doit pas faire passer un objet pour du texte
    expect(parseReconciliation({ sampleSize: 12, maxGapPct: "0", source: "SuperHote", note: ["x"] }).ok).toBe(false);
  });
  it("l'écart n'est jamais arrondi avant d'être comparé à 1 %", () => {
    const state = (gap: string) => { const r = parseReconciliation({ sampleSize: "12", maxGapPct: gap, source: "SuperHote" }); if (!r.ok) throw new Error(r.error); return reconciliationState({ payload: r.value, validatedByName: "Rosy", createdAt: "2026-11-20T10:00:00Z" }).status; };
    expect(state("1")).toBe("OK"); expect(state("1,0")).toBe("OK");
    for (const g of ["1,01", "1,04", "1,05", "1,049"]) expect(state(g), g).toBe("GAP");
  });
  it("états : aucun, trop petit, écart trop grand, satisfait", () => {
    const row = (payload: object) => ({ payload, validatedByName: "Rosy", createdAt: "2026-11-20T10:00:00Z" });
    expect(reconciliationState(null).status).toBe("NONE");
    expect(reconciliationState(row({ sampleSize: 9, maxGapPct: 0 })).status).toBe("TOO_SMALL");
    expect(reconciliationState(row({ sampleSize: 10, maxGapPct: 1.1 })).status).toBe("GAP");
    expect(reconciliationState(row({ sampleSize: 10, maxGapPct: 1 })).status).toBe("OK");
    expect(reconciliationState(row({})).status).toBe("NONE");
  });
});
