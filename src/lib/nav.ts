/**
 * Arborescence de navigation (une seule source) : colonne (bureau), rangée (tablette), barre basse et feuille (mobile).
 * Fonctions pures, sans React : testées dans nav.test.ts.
 */
export type NavBadge = "open" | "alerts" | "prices";
export type NavNode = { id: string; label: string; href?: string; icon?: string; badge?: NavBadge; action?: boolean; children?: NavNode[] };
export type NavGroup = { label: string; items: NavNode[] };
export type NavProperty = { id: string; name: string; status: string };

/** Au-delà de ce nombre de logements, le menu n'en liste que les plus récents. */
export const NAV_MAX_PROPERTIES = 8;
export const NAV_RECENT_PROPERTIES = 5;

type SectionDef = { key: string; label: string; query: string; tabs: string[]; pages: string[] };
/** Les six sections d'un logement : onglets (`?tab=`) et sous-pages rattachés à chacune. */
export const PROPERTY_SECTIONS: SectionDef[] = [
  { key: "apercu", label: "Vue d'ensemble", query: "", tabs: ["apercu", "performance"], pages: ["modifier", "supprimer"] },
  { key: "calendrier", label: "Calendrier 90 jours", query: "?tab=calendrier", tabs: ["calendrier"], pages: [] },
  { key: "strategie", label: "Stratégie & prix", query: "?tab=hub-strategie", tabs: ["hub-strategie", "strategie", "canaux"], pages: ["strategie", "compilateur"] },
  { key: "economie", label: "Économie", query: "?tab=hub-economie", tabs: ["hub-economie", "economie"], pages: ["couts", "saisons", "versions-economie"] },
  { key: "donnees", label: "Données & connexions", query: "?tab=hub-donnees", tabs: ["hub-donnees", "superhote", "pricelabs", "annonces", "donnees"], pages: ["mapping", "qualite", "ecarts-reservations", "validations"] },
  { key: "historique", label: "Historique", query: "?tab=historique", tabs: ["historique"], pages: [] },
];

/** Section à laquelle appartient un onglet de la fiche (la vue d'ensemble pour un onglet inconnu). */
export const sectionOfTab = (tab: string) => PROPERTY_SECTIONS.find((s) => s.tabs.includes(tab)) ?? PROPERTY_SECTIONS[0];
export const sectionHref = (propertyId: string, key: string) => `/logements/${propertyId}${PROPERTY_SECTIONS.find((s) => s.key === key)?.query ?? ""}`;
export const sectionNodeId = (propertyId: string, key: string) => `section:${propertyId}:${key}`;

/** Identifiant du logement affiché, d'après le chemin (`/logements/<id>/…`) ; null hors d'une fiche. */
export function propertyIdOf(path: string): string | null {
  const m = /^\/logements\/([^/]+)/.exec(path);
  return m && m[1] !== "nouveau" ? m[1] : null;
}

/** Logements montrés dans le menu (ordre de création conservé) : tous jusqu'à 8, sinon les 5 plus récents, plus celui qui est affiché. */
export function menuProperties(all: NavProperty[], currentPropertyId: string | null = null): { shown: NavProperty[]; truncated: boolean } {
  if (all.length <= NAV_MAX_PROPERTIES) return { shown: all, truncated: false };
  const recent = new Set(all.slice(-NAV_RECENT_PROPERTIES).map((p) => p.id));
  return { shown: all.filter((p) => recent.has(p.id) || p.id === currentPropertyId), truncated: true };
}

/** `properties` : du plus ancien au plus récent. `canAdd` : le rôle permet d'ajouter un logement. */
export function buildNav(properties: NavProperty[], currentPropertyId: string | null = null, canAdd = true): NavGroup[] {
  const { shown, truncated } = menuProperties(properties, currentPropertyId);
  const logements: NavNode[] = shown.map((p) => ({
    id: `property:${p.id}`, label: p.name || "Logement sans nom", href: `/logements/${p.id}`,
    children: PROPERTY_SECTIONS.map((s) => ({ id: sectionNodeId(p.id, s.key), label: s.label, href: sectionHref(p.id, s.key) })),
  }));
  if (truncated) logements.push({ id: "tous-les-logements", label: `Tous les logements (${properties.length})`, href: "/logements" });
  if (canAdd) logements.push({ id: "ajouter-logement", label: "Ajouter un logement", href: "/logements/nouveau", icon: "plus", action: true });
  return [
    { label: "Pilotage", items: [
      { id: "tableau-de-bord", label: "Tableau de bord", href: "/portefeuille", icon: "chart" },
      { id: "opportunites", label: "Opportunités", href: "/", icon: "inbox", badge: "open" },
      { id: "alertes", label: "Alertes", href: "/alertes", icon: "alert", badge: "alerts" },
    ] },
    { label: "Portefeuille", items: [{ id: "logements", label: "Logements", href: "/logements", icon: "home", children: logements }] },
    { label: "Agence", items: [
      { id: "analyse", label: "Analyse", icon: "chart", children: [
        { id: "bilan", label: "Bilan mensuel", href: "/bilan" },
        { id: "rapports", label: "Rapports mensuels", href: "/rapports" },
        { id: "historique", label: "Historique des décisions", href: "/historique" },
      ] },
      { id: "agence-ia", label: "Agence IA", icon: "team", children: [
        { id: "equipe", label: "Équipe", href: "/equipe" },
        { id: "methode", label: "Méthode de travail", href: "/methode" },
        { id: "glossaire", label: "Glossaire", href: "/glossaire" },
      ] },
      { id: "parametres", label: "Paramètres", href: "/parametres", icon: "sliders", children: [
        { id: "compte", label: "Compte & sécurité", href: "/parametres/compte" },
        { id: "proprietaires", label: "Propriétaires", href: "/proprietaires" },
        { id: "integrations", label: "Intégrations", href: "/integrations" },
        { id: "modeles", label: "IA & modèles", href: "/modeles", children: [
          { id: "ia-cles", label: "Clés fournisseurs", href: "/modeles/cles" },
          { id: "ia-agents", label: "Agents", href: "/modeles/agents" },
          { id: "ia-budget", label: "Budget", href: "/modeles/budget" },
          { id: "ia-catalogue", label: "Catalogue", href: "/modeles/catalogue", badge: "prices" },
        ] },
        { id: "priorisation", label: "Priorisation des dossiers", href: "/parametres/priorisation" },
        { id: "demonstration", label: "Démonstration", href: "/parametres/demo" },
      ] },
    ] },
  ];
}

/** Vrai si ce nœud ou l'un de ses descendants porte la pastille des prix : une rubrique repliée la reprend, pour qu'elle reste visible. */
export const hasPriceBadge = (n: NavNode): boolean => n.badge === "prices" || !!n.children?.some(hasPriceBadge);

const within = (path: string, base: string) => path === base || path.startsWith(base + "/");

/** Nœud du menu qui correspond à l'écran courant (chemin et onglet), ou null. */
export function currentNodeId(path: string, tab: string | null): string | null {
  if (path === "/" || within(path, "/dossier")) return "opportunites";
  if (path === "/logements") return "logements";
  if (path === "/logements/nouveau") return "ajouter-logement";
  const pid = propertyIdOf(path);
  if (pid) {
    const page = path.split("/")[3];
    const section = page ? PROPERTY_SECTIONS.find((s) => s.pages.includes(page)) : PROPERTY_SECTIONS.find((s) => s.tabs.includes(tab ?? "apercu"));
    return sectionNodeId(pid, section?.key ?? "apercu");
  }
  const leaves: [string, string][] = [["/portefeuille", "tableau-de-bord"], ["/alertes", "alertes"], ["/bilan", "bilan"], ["/rapports", "rapports"], ["/historique", "historique"],
    ["/equipe", "equipe"], ["/methode", "methode"], ["/glossaire", "glossaire"], ["/parametres/compte", "compte"], ["/parametres/priorisation", "priorisation"], ["/parametres/demo", "demonstration"], ["/parametres", "parametres"], ["/proprietaires", "proprietaires"], ["/integrations", "integrations"], ["/modeles/cles", "ia-cles"], ["/modeles/agents", "ia-agents"], ["/modeles/budget", "ia-budget"], ["/modeles/catalogue", "ia-catalogue"], ["/modeles", "modeles"]];
  return leaves.find(([base]) => within(path, base))?.[1] ?? null;
}

/** Identifiants des nœuds parents d'un nœud (du plus haut au plus proche) : les branches à ouvrir pour le montrer. */
export function ancestorIds(groups: NavGroup[], id: string | null): string[] {
  const walk = (nodes: NavNode[], trail: string[]): string[] | null => {
    for (const n of nodes) {
      if (n.id === id) return trail;
      const found = n.children && walk(n.children, [...trail, n.id]);
      if (found) return found;
    }
    return null;
  };
  return walk(groups.flatMap((g) => g.items), []) ?? [];
}

/** Rubriques repliées dans la feuille « Plus » (mobile) et dans la rangée tablette. Sur tablette, une rubrique qui a sa propre page (Paramètres) y mène directement, et un chevron à côté ouvre la feuille de ses sous-écrans. */
export const FOLDED_NODES = ["analyse", "agence-ia", "parametres"];
