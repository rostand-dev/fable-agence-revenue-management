import { describe, expect, it } from "vitest";
import { PROPERTY_SECTIONS } from "./nav";
import { HUBS, hubScreens } from "./property-hubs";

const real = { id: "p1", isDemo: false, status: "ACTIVE", economicsVersion: 2 };
const keys = (p: typeof real, k: "strategie" | "economie" | "donnees") => hubScreens(k, p).map((s) => s.key);

describe("hubs de la fiche logement", () => {
  it("chaque onglet et chaque sous-page d'une section est atteignable depuis son hub", () => {
    for (const hub of HUBS) {
      const section = PROPERTY_SECTIONS.find((s) => s.key === hub.key)!;
      expect(section.query).toBe(`?tab=${hub.tab}`);
      const paths = hub.screens.map((s) => s.path).sort();
      expect(paths).toEqual([...section.tabs.filter((t) => t !== hub.tab).map((t) => `?tab=${t}`), ...section.pages.map((p) => `/${p}`)].sort());
    }
  });
  it("logement réel et lancé : tous les écrans", () => {
    for (const hub of HUBS) expect(hubScreens(hub.key, real)).toHaveLength(hub.screens.length);
  });
  it("démonstration : seuls les écrans consultables", () => {
    const demo = { ...real, isDemo: true };
    expect(keys(demo, "strategie")).toEqual(["strategie", "canaux", "compilateur"]);
    expect(keys(demo, "economie")).toEqual(["planchers"]);
    expect(keys(demo, "donnees")).toEqual(["superhote", "pricelabs", "annonces", "qualite-donnees"]);
  });
  it("création en cours : pas d'écran d'activation ; sans version : pas d'écran des versions", () => {
    const draft = { ...real, status: "ONBOARDING", economicsVersion: 0 };
    expect(keys(draft, "strategie")).not.toContain("builder");
    expect(keys(draft, "economie")).toEqual(["couts", "planchers", "saisons"]);
    expect(keys(draft, "donnees")).toEqual(["superhote", "pricelabs", "annonces", "qualite-donnees", "ecarts"]);
  });
});
