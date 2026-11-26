import { describe, expect, it } from "vitest";
import { ancestorIds, buildNav, currentNodeId, menuProperties, PROPERTY_SECTIONS, propertyIdOf, sectionHref, type NavNode, hasPriceBadge } from "./nav";

const props = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `Logement ${i + 1}`, status: "ACTIVE" }));
const flat = (nodes: NavNode[]): NavNode[] => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);

describe("navigation", () => {
  it("range chaque onglet de la fiche logement dans une section, sans en oublier", () => {
    const tabs = PROPERTY_SECTIONS.flatMap((s) => s.tabs);
    expect([...tabs].sort()).toEqual(["annonces", "apercu", "calendrier", "canaux", "donnees", "economie", "historique", "hub-donnees", "hub-economie", "hub-strategie", "performance", "pricelabs", "strategie", "superhote"]);
    expect(new Set(tabs).size).toBe(tabs.length);
  });
  it("conserve tous les écrans de l'ancien menu", () => {
    const hrefs = flat(buildNav(props(1)).flatMap((g) => g.items)).map((n) => n.href);
    for (const h of ["/portefeuille", "/", "/logements", "/historique", "/alertes", "/equipe", "/methode", "/glossaire", "/bilan", "/rapports", "/proprietaires", "/integrations", "/modeles", "/modeles/cles", "/modeles/agents", "/modeles/budget", "/modeles/catalogue", "/parametres", "/parametres/compte", "/parametres/priorisation", "/parametres/demo"]) expect(hrefs).toContain(h);
  });
  it("identifiants uniques", () => {
    const ids = flat(buildNav(props(12), "p1").flatMap((g) => g.items)).map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("liste tous les logements jusqu'à 8, puis les 5 plus récents et le logement affiché", () => {
    expect(menuProperties(props(8)).shown).toHaveLength(8);
    expect(menuProperties(props(9)).shown.map((p) => p.id)).toEqual(["p5", "p6", "p7", "p8", "p9"]);
    expect(menuProperties(props(9), "p2").shown.map((p) => p.id)).toEqual(["p2", "p5", "p6", "p7", "p8", "p9"]);
    expect(flat(buildNav(props(9)).flatMap((g) => g.items)).some((n) => n.id === "tous-les-logements")).toBe(true);
  });
  it("reconnaît l'écran courant, onglet compris", () => {
    expect(currentNodeId("/", null)).toBe("opportunites");
    expect(currentNodeId("/dossier/OPP-1", null)).toBe("opportunites");
    expect(currentNodeId("/logements", null)).toBe("logements");
    expect(currentNodeId("/logements/nouveau", null)).toBe("ajouter-logement");
    expect(currentNodeId("/logements/p1", null)).toBe("section:p1:apercu");
    expect(currentNodeId("/logements/p1", "canaux")).toBe("section:p1:strategie");
    expect(currentNodeId("/logements/p1", "annonces")).toBe("section:p1:donnees");
    expect(currentNodeId("/logements/p1", "inconnu")).toBe("section:p1:apercu");
    expect(currentNodeId("/logements/p1/saisons", null)).toBe("section:p1:economie");
    expect(currentNodeId("/logements/p1/validations", null)).toBe("section:p1:donnees");
    expect(currentNodeId("/rapports/r1", null)).toBe("rapports");
    expect(currentNodeId("/integrations/erreurs", null)).toBe("integrations");
    expect(propertyIdOf("/logements/nouveau")).toBeNull();
    expect(currentNodeId("/logements/p1", "performance")).toBe("section:p1:apercu");
    expect(currentNodeId("/logements/p1", "hub-economie")).toBe("section:p1:economie");
    expect(sectionHref("p1", "apercu")).toBe("/logements/p1");
    expect(sectionHref("p1", "donnees")).toBe("/logements/p1?tab=hub-donnees");
  });
  it("ouvre les branches qui mènent à l'écran courant", () => {
    const g = buildNav(props(2));
    expect(ancestorIds(g, "section:p2:economie")).toEqual(["logements", "property:p2"]);
    expect(ancestorIds(g, "modeles")).toEqual(["parametres"]);
    expect(ancestorIds(g, currentNodeId("/modeles/catalogue", null))).toEqual(["parametres", "modeles"]);
    expect(ancestorIds(g, currentNodeId("/parametres/compte", null))).toEqual(["parametres"]);
    expect(currentNodeId("/parametres", null)).toBe("parametres");
    expect(ancestorIds(g, "alertes")).toEqual([]);
    expect(ancestorIds(g, null)).toEqual([]);
  });
});

describe("pastille des prix", () => {
  it("remonte du Catalogue jusqu'à « Paramètres », et nulle part ailleurs", () => {
    const items = buildNav([]).flatMap((g) => g.items);
    expect(items.filter(hasPriceBadge).map((n) => n.id)).toEqual(["parametres"]);
  });
});

describe("droits", () => {
  it("l'entrée « Ajouter un logement » n'est proposée qu'à qui peut gérer les logements", () => {
    const ids = (canAdd: boolean) => buildNav([], null, canAdd).flatMap((g) => g.items).flatMap((n) => n.children ?? []).map((n) => n.id);
    expect(ids(true)).toContain("ajouter-logement");
    expect(ids(false)).not.toContain("ajouter-logement");
  });
});
