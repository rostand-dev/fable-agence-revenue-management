import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FLOOR_LOS, floorFingerprint } from "../activation-gates";
import { diffEconomics } from "../economics-versions";
import { floorGrid, hardFloorCents, strategyFloorCents, UnknownEconomics } from "./economics";
import { isMonthDay, parseSeasons, seasonalFloorGrid, seasonOn, strategyContributionOn, strategyFloorOn } from "./seasons";
import { emptyEconomics } from "./economics";
import type { EconomicModel, Season } from "./types";

const base = (over: Partial<EconomicModel> = {}): EconomicModel => ({ ...emptyEconomics(), cleaningFeeChargedCents: 5000, cleaningCostCents: 4000, linenCostCents: 1000, nightlyVariableCostCents: 500, hardContributionPerNightCents: 3000, strategyContributionPerNightCents: 4000, channels: { AIRBNB: { commissionPct: 15, paymentFeePct: 0 }, BOOKING: { commissionPct: 17, paymentFeePct: 1 } }, ...over });
const summer: Season = { id: "ete", label: "Été", from: "07-01", to: "08-31", strategyContributionPerNightCents: 6000 };
const winter: Season = { id: "noel", label: "Fêtes", from: "12-20", to: "01-05", strategyContributionPerNightCents: 5000 };

describe("dates MM-JJ", () => {
  it("accepte les dates réelles, y compris le 29 février, refuse le reste", () => {
    for (const d of ["01-01", "02-29", "12-31"]) expect(isMonthDay(d)).toBe(true);
    for (const d of ["02-30", "13-01", "00-10", "1-1", "2024-07-01", "07-32", "", null, 5]) expect(isMonthDay(d)).toBe(false);
  });
});

describe("parseSeasons", () => {
  const ok = (raw: unknown, m = base()) => parseSeasons(raw, m);
  it("aucune saison : liste vide", () => { expect(ok(undefined)).toEqual({ ok: true, seasons: [] }); expect(ok([])).toEqual({ ok: true, seasons: [] }); });
  it("accepte une saison valide et une saison à cheval sur le nouvel an", () => { const r = ok([summer, winter]); expect(r.ok && r.seasons).toHaveLength(2); });
  it("refuse un chevauchement, y compris à cheval sur le nouvel an", () => {
    expect(ok([summer, { ...summer, id: "b", label: "Août", from: "08-31", to: "09-15" }])).toMatchObject({ ok: false });
    expect(ok([winter, { ...summer, id: "b", label: "Janvier", from: "01-05", to: "01-10" }])).toMatchObject({ ok: false });
    expect(ok([winter, { ...summer, id: "b", label: "Janvier", from: "01-06", to: "01-10" }]).ok).toBe(true);
  });
  it("refuse dates invalides, nom trop court, montant non entier ou négatif, trop de saisons, doublon d'identifiant", () => {
    expect(ok([{ ...summer, from: "07-1" }]).ok).toBe(false);
    expect(ok([{ ...summer, label: "E" }]).ok).toBe(false);
    expect(ok([{ ...summer, strategyContributionPerNightCents: 60.5 }]).ok).toBe(false);
    expect(ok([{ ...summer, strategyContributionPerNightCents: -1 }]).ok).toBe(false);
    expect(ok([{ ...summer, strategyContributionPerNightCents: NaN }]).ok).toBe(false);
    expect(ok(Array.from({ length: 9 }, (_, i) => ({ ...summer, id: `x${i}`, label: `S${i}`, from: `0${(i % 9) + 1}-01`, to: `0${(i % 9) + 1}-02` }))).ok).toBe(false);
    expect(ok([summer, { ...winter, id: "ete" }]).ok).toBe(false);
    expect(ok("nope").ok).toBe(false);
  });
  it("refuse une couverture sous le seuil de dérangement ; l'accepte si le seuil est inconnu", () => {
    expect(ok([{ ...summer, strategyContributionPerNightCents: 2999 }]).ok).toBe(false);
    expect(ok([{ ...summer, strategyContributionPerNightCents: 3000 }]).ok).toBe(true);
    expect(ok([{ ...summer, strategyContributionPerNightCents: 100 }], base({ hardContributionPerNightCents: null })).ok).toBe(true);
  });
});

describe("identifiants des saisons", () => {
  it("une saison sans identifiant reçoit le premier libre, quelle que soit sa position", () => {
    const r = parseSeasons([{ ...winter, id: undefined }, { ...summer, id: "s1" }], base());
    expect(r.ok && r.seasons.map((s) => s.id)).toEqual(["s2", "s1"]);
  });
});

describe("saison en vigueur à une date", () => {
  const m = base({ seasons: [summer, winter] });
  it("bornes incluses, cheval sur le nouvel an, hors saison = base", () => {
    expect(seasonOn(m, "2026-07-01")?.id).toBe("ete");
    expect(seasonOn(m, "2026-08-31")?.id).toBe("ete");
    expect(seasonOn(m, "2026-09-01")).toBeNull();
    expect(seasonOn(m, "2026-12-31")?.id).toBe("noel");
    expect(seasonOn(m, "2027-01-05")?.id).toBe("noel");
    expect(seasonOn(m, "2027-01-06")).toBeNull();
    expect(strategyContributionOn(m, "2026-03-10")).toBe(4000);
    expect(strategyContributionOn(m, "2026-07-14")).toBe(6000);
  });
  it("la même saison s'applique en année bissextile et non bissextile (29 février)", () => {
    const leap = base({ seasons: [{ ...summer, id: "fev", label: "Février", from: "02-20", to: "03-05" }] });
    expect(seasonOn(leap, "2027-03-01")?.id).toBe("fev");
    expect(seasonOn(leap, "2028-02-29")?.id).toBe("fev");
    expect(seasonOn(leap, "2028-03-06")).toBeNull();
  });
  it("sans saison : toujours la base", () => { expect(seasonOn(base(), "2026-07-14")).toBeNull(); expect(strategyContributionOn(base(), "2026-07-14")).toBe(4000); });
});

describe("planchers par saison", () => {
  const m = base({ seasons: [summer] });
  it("le plancher absolu est identique toute l'année ; le plancher stratégique varie par saison", () => {
    const g = seasonalFloorGrid(m).find((x) => x.channel === "AIRBNB" && x.nights === 2)!;
    expect(g.hardCents).toBe(hardFloorCents(m, "AIRBNB", 2));
    expect(g.strategyCents).toBe(strategyFloorCents(m, "AIRBNB", 2));
    expect(g.seasons).toHaveLength(1);
    expect(g.seasons[0].strategyCents).toBeGreaterThan(g.strategyCents);
    // calcul à la main : (6000×2 + (4000+1000−5000×0,85) + 500×2) / (2×0,85) = (12000+750+1000)/1,7 = 8088,2… → 8089
    expect(g.seasons[0].strategyCents).toBe(8089);
    expect(strategyFloorOn(m, "AIRBNB", 2, "2026-07-10")).toBe(8089);
    expect(strategyFloorOn(m, "AIRBNB", 2, "2026-10-10")).toBe(g.strategyCents);
  });
  it("le plancher absolu ne dépend d'aucune saison", () => {
    const a = seasonalFloorGrid(base()).map((g) => g.hardCents), b = seasonalFloorGrid(m).map((g) => g.hardCents);
    expect(b).toEqual(a);
  });
  it("modèle incomplet : une erreur explicite, jamais un plancher inventé", () => {
    expect(() => strategyFloorOn(base({ cleaningCostCents: null, seasons: [summer] }), "AIRBNB", 2, "2026-07-10")).toThrow(UnknownEconomics);
  });
});

describe("empreinte des planchers", () => {
  const legacy = (m: EconomicModel) => createHash("sha256").update(JSON.stringify(floorGrid(m, [...FLOOR_LOS]).map((g) => [g.channel, g.nights, g.hardCents, g.strategyCents]).sort((a, b) => (a[0] as string).localeCompare(b[0] as string) || (a[1] as number) - (b[1] as number)))).digest("hex").slice(0, 32);
  it("sans saison, l'empreinte est celle d'avant l'US-052 (les validations existantes restent valables)", () => {
    expect(floorFingerprint(base())).toBe(legacy(base()));
    expect(floorFingerprint(base({ seasons: [] }))).toBe(legacy(base()));
  });
  it("ajouter, modifier ou retirer une saison change l'empreinte ; l'ordre des saisons ne la change pas", () => {
    const f0 = floorFingerprint(base()), f1 = floorFingerprint(base({ seasons: [summer] })), f2 = floorFingerprint(base({ seasons: [{ ...summer, strategyContributionPerNightCents: 6100 }] }));
    expect(new Set([f0, f1, f2]).size).toBe(3);
    expect(floorFingerprint(base({ seasons: [summer, winter] }))).toBe(floorFingerprint(base({ seasons: [winter, summer] })));
  });
  it("décaler les dates ou renommer une saison, à montant égal, change l'empreinte", () => {
    const f = floorFingerprint(base({ seasons: [summer] }));
    expect(floorFingerprint(base({ seasons: [{ ...summer, to: "09-15" }] }))).not.toBe(f);
    expect(floorFingerprint(base({ seasons: [{ ...summer, label: "Haute" }] }))).not.toBe(f);
  });
  it("modèle incomplet : pas d'empreinte", () => { expect(floorFingerprint(base({ cleaningCostCents: null, seasons: [summer] }))).toBeNull(); });
});

describe("historique des versions", () => {
  it("décrit les saisons ajoutées, modifiées et retirées", () => {
    const d = diffEconomics(base(), base({ seasons: [summer] }));
    expect(d).toEqual([{ key: "seasons.ete", label: "Saison « Été »", from: null, to: "« Été » 07-01 → 08-31 : 60,00 € par nuit" }]);
    expect(diffEconomics(base({ seasons: [summer] }), base({ seasons: [{ ...summer, strategyContributionPerNightCents: 6500 }] }))[0]).toMatchObject({ from: "« Été » 07-01 → 08-31 : 60,00 € par nuit", to: "« Été » 07-01 → 08-31 : 65,00 € par nuit" });
    expect(diffEconomics(base({ seasons: [summer] }), base())[0]).toMatchObject({ to: null });
    expect(diffEconomics(base({ seasons: [summer] }), base({ seasons: [{ ...summer, label: "Haute saison" }] }))).toHaveLength(1); // renommer se voit
    expect(diffEconomics(base({ seasons: [summer] }), base({ seasons: [summer] }))).toEqual([]);
  });
});
