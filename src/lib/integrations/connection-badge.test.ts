import { describe, expect, it } from "vitest";
import { badgeHref, pricelabsBadge, superhoteBadge } from "./connection-badge";

describe("badge SuperHote de la fiche logement", () => {
  it("n'affiche rien sur le logement de démonstration", () => {
    expect(superhoteBadge({ rentalId: "1" }, true)).toBeNull();
  });
  it("neutre sans jeton", () => {
    expect(superhoteBadge(null, false)).toEqual({ role: "neutre", label: "SuperHote non connecté" });
    expect(superhoteBadge({}, false)?.role).toBe("neutre");
  });
  it("rattachement à confirmer quand le jeton est saisi sans logement rattaché", () => {
    expect(superhoteBadge({ apiKeyEnc: "x" }, false)).toEqual({ role: "attention", label: "Rattachement SuperHote à confirmer" });
  });
  it("connecté quand le logement est rattaché, même sans lecture encore faite", () => {
    expect(superhoteBadge({ apiKeyEnc: "x", rentalId: "42" }, false)?.role).toBe("sain");
    expect(superhoteBadge({ rentalId: "42", lastSync: { ok: true } }, false)?.label).toBe("SuperHote connecté");
  });
  it("attention quand la dernière lecture a échoué", () => {
    expect(superhoteBadge({ rentalId: "42", lastSync: { ok: false } }, false)).toEqual({ role: "attention", label: "SuperHote : lecture en échec" });
  });
});

describe("badge PriceLabs de la fiche logement (même fonctionnement que SuperHote)", () => {
  it("n'affiche rien sur le logement de démonstration", () => {
    expect(pricelabsBadge({ listingId: "1" }, true)).toBeNull();
  });
  it("neutre sans clé", () => {
    expect(pricelabsBadge(null, false)).toEqual({ role: "neutre", label: "PriceLabs non connecté" });
  });
  it("rattachement à confirmer, en nommant l'intégration", () => {
    expect(pricelabsBadge({ apiKeyEnc: "x" }, false)).toEqual({ role: "attention", label: "Rattachement PriceLabs à confirmer" });
  });
  it("connecté quand l'annonce est rattachée", () => {
    expect(pricelabsBadge({ apiKeyEnc: "x", listingId: "pl-1", lastSync: { ok: true } }, false)).toEqual({ role: "sain", label: "PriceLabs connecté" });
  });
  it("l'échec de lecture est dit en toutes lettres, pas seulement par la couleur", () => {
    expect(pricelabsBadge({ listingId: "pl-1", lastSync: { ok: false } }, false)).toEqual({ role: "attention", label: "PriceLabs : lecture en échec" });
  });
  it("un identifiant SuperHote ne rend pas PriceLabs connecté, et inversement", () => {
    expect(pricelabsBadge({ apiKeyEnc: "x", rentalId: "42" }, false)?.label).toBe("Rattachement PriceLabs à confirmer");
    expect(superhoteBadge({ apiKeyEnc: "x", listingId: "pl-1" }, false)?.label).toBe("Rattachement SuperHote à confirmer");
  });
});

describe("destination des badges", () => {
  it("l'étape du parcours pendant la création, l'onglet de la fiche ensuite", () => {
    expect(badgeHref("pricelabs", "p1", "ONBOARDING")).toBe("/logements/p1/creation?etape=pricelabs");
    expect(badgeHref("superhote", "p1", "ONBOARDING")).toBe("/logements/p1/creation?etape=superhote");
    expect(badgeHref("pricelabs", "p1", "SHADOW")).toBe("/logements/p1?tab=pricelabs");
  });
});
