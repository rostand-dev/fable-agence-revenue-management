import { describe, expect, it } from "vitest";
import { evaluateMapping, mappingFingerprint, normPlace, type MappingFacts } from "./mapping";

const base = (): MappingFacts => ({
  property: { name: "Évry T5", city: "Évry-Courcouronnes", bedrooms: 4, capacity: 8 },
  superhote: { rentalId: "sh1", rentalName: "T5 Évry", city: "Evry Courcouronnes", capacity: 8 },
  pricelabs: { listingId: "pl1", pms: "superhote", listingName: "T5 Évry", city: "Évry-Courcouronnes", bedrooms: 4 },
  listings: [{ channel: "AIRBNB", externalId: "12345678" }],
  confirmation: null,
});

describe("mapping des identifiants externes (US-021)", () => {
  it("la ville se compare sans accents, majuscules ni ponctuation ; inconnu ne contredit pas", () => {
    expect(normPlace("Évry-Courcouronnes")).toBe("evry courcouronnes");
    expect(evaluateMapping(base()).checks).toEqual([]);
    const f = base(); f.pricelabs!.city = null; f.superhote!.city = null;
    expect(evaluateMapping(f).checks).toEqual([]);
  });
  it("la ville se compare par mots entiers, et un candidat sans données est signalé non vérifiable", () => {
    const f = base(); f.property.city = "Nice"; f.pricelabs!.city = "Venice";
    expect(evaluateMapping(f).checks.map((c) => c.id)).toContain("pl-city");
    const g = base(); g.pricelabs!.city = null; g.pricelabs!.bedrooms = null;
    expect(evaluateMapping(g).items[0].detail).toContain("non vérifiables");
  });
  it("l'empreinte tient compte de la ville, des chambres et de la capacité du logement", () => {
    const a = base(), b = base(); b.property.bedrooms = 5;
    expect(mappingFingerprint(a)).not.toBe(mappingFingerprint(b));
  });
  it("sans annonce PriceLabs : incomplet et non confirmable ; SuperHote et annonces sont facultatifs", () => {
    const f = base(); f.pricelabs = null; f.superhote = null; f.listings = [];
    const e = evaluateMapping(f);
    expect(e).toMatchObject({ status: "INCOMPLETE", confirmable: false, missingRequired: ["pricelabs"] });
    expect(e.items.filter((i) => i.state === "missing").map((i) => i.key)).toEqual(["pricelabs", "superhote", "airbnb", "booking"]);
  });
  it("complet puis confirmé ; l'empreinte change quand un identifiant change, la confirmation devient périmée", () => {
    const f = base();
    expect(evaluateMapping(f).status).toBe("TO_CONFIRM");
    f.confirmation = { fingerprint: mappingFingerprint(f), at: "2026-11-21T10:00:00Z", by: "u1" };
    expect(evaluateMapping(f).status).toBe("CONFIRMED");
    f.listings = [...f.listings, { channel: "BOOKING", externalId: "1234567" }];
    expect(evaluateMapping(f).status).toBe("STALE");
  });
  it("l'empreinte ne dépend pas de l'ordre des annonces ni des annonces sans identifiant", () => {
    const a = base(); a.listings = [{ channel: "BOOKING", externalId: "11111" }, { channel: "AIRBNB", externalId: "22222" }];
    const b = base(); b.listings = [{ channel: "AIRBNB", externalId: "22222" }, { channel: "BOOKING", externalId: "11111" }, { channel: "DIRECT", externalId: null }];
    expect(mappingFingerprint(a)).toBe(mappingFingerprint(b));
  });
  it("signale un rattachement douteux : ville, chambres, capacité, incohérence entre outils", () => {
    const f = base();
    f.pricelabs!.city = "Lyon"; f.pricelabs!.bedrooms = 2; f.superhote!.city = "Paris"; f.superhote!.capacity = 4;
    const ids = evaluateMapping(f).checks.map((c) => c.id).sort();
    expect(ids).toEqual(["pl-bedrooms", "pl-city", "pl-sh-city", "sh-capacity", "sh-city"]);
    const e = evaluateMapping(f);
    expect(e.items.find((i) => i.key === "pricelabs")!.state).toBe("warning");
    expect(e.items.find((i) => i.key === "superhote")!.state).toBe("warning");
    expect(e.confirmable).toBe(true); // un doute n'interdit pas la confirmation, mais elle devra être assumée
  });
});
