import { describe, expect, it } from "vitest";
import { ancestorIds, buildNav, currentNodeId, deskScreen, KILL_SWITCH_HREF, menuProperties, pocketMenu, PROPERTY_SECTIONS, propertyIdOf, sectionHref, viewHref, type NavNode, hasPriceBadge } from "./nav";

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

describe("mode poche : écrans réservés à l'ordinateur", () => {
  const reserves = ["/parametres", "/parametres/compte", "/parametres/priorisation", "/parametres/demo", "/proprietaires", "/integrations", "/integrations/erreurs",
    "/modeles", "/modeles/cles", "/modeles/agents", "/modeles/budget", "/modeles/catalogue", "/logements/nouveau", "/bilan", "/methode",
    ...["creation", "modifier", "supprimer", "couts", "saisons", "strategie", "compilateur", "versions-economie", "mapping", "qualite", "validations", "ecarts-reservations"].map((s) => `/logements/p1/${s}`)];
  const disponibles = ["/", "/portefeuille", "/alertes", "/logements", "/logements/p1", "/historique", "/equipe", "/equipe/direction", "/glossaire", "/rapports", "/rapports/r1", "/dossier/OPP-1", "/vue", "/inconnu"];
  it("la liste couvre la configuration et l'analyse, pas la consultation ni la décision", () => {
    for (const p of reserves) expect(deskScreen(p), p).not.toBeNull();
    for (const p of disponibles) expect(deskScreen(p), p).toBeNull();
    expect(deskScreen("/bilan/")?.key).toBe("/bilan");
  });
  it("chaque page de réglage d'un logement connue du menu est réservée", () => {
    for (const s of PROPERTY_SECTIONS) for (const page of s.pages) expect(deskScreen(`/logements/p1/${page}`), page).not.toBeNull();
  });
  it("le choix est propre à un écran, sauf le parcours de création qui n'en fait qu'un", () => {
    expect(deskScreen("/logements/p1/couts")?.key).not.toBe(deskScreen("/logements/p2/couts")?.key);
    expect(deskScreen("/logements/nouveau")?.key).toBe(deskScreen("/logements/p1/creation")?.key);
  });
  it("le retour mène à un écran disponible sur téléphone", () => {
    for (const p of reserves) expect(deskScreen(deskScreen(p)!.back), p).toBeNull();
    expect(deskScreen("/logements/p1/couts")?.back).toBe("/logements/p1");
  });
  it("le menu porte le champ desk sur ces écrans", () => {
    const nodes = flat(buildNav(props(1)).flatMap((g) => g.items));
    for (const id of ["parametres", "compte", "proprietaires", "integrations", "modeles", "ia-cles", "priorisation", "demonstration", "ajouter-logement", "bilan", "methode"]) expect(nodes.find((n) => n.id === id)?.desk, id).toBe(true);
    for (const id of ["tableau-de-bord", "opportunites", "alertes", "logements", "historique", "rapports", "equipe", "glossaire", "section:p1:apercu", "section:p1:calendrier"]) expect(nodes.find((n) => n.id === id)?.desk, id).toBeUndefined();
  });
  it("feuille « Plus » : consultation d'un côté, ordinateur de l'autre", () => {
    const m = pocketMenu(buildNav(props(1)));
    expect(m.links.map((l) => l.label)).toEqual(["Historique des décisions", "Équipe de l'agence", "Rapports mensuels", "Glossaire"]);
    expect(m.desk.map((l) => l.label)).toEqual(["Paramètres", "IA & modèles", "Intégrations", "Création d'un logement", "Analyse", "Méthode"]);
    expect(pocketMenu(buildNav(props(1), null, false)).desk.map((l) => l.id)).not.toContain("ajouter-logement");
    expect(deskScreen(KILL_SWITCH_HREF)).not.toBeNull();
  });
  it("l'adresse de bascule encode le retour", () => {
    expect(viewHref("complet", "/logements/p1?tab=calendrier")).toBe("/vue?mode=complet&retour=%2Flogements%2Fp1%3Ftab%3Dcalendrier");
  });
});
