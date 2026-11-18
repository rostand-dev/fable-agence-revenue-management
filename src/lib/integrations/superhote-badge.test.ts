import { describe, expect, it } from "vitest";
import { superhoteBadge } from "./superhote-badge";

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
