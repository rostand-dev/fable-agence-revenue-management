/**
 * Arborescence de navigation (une seule source) : colonne (bureau), rangée (tablette), barre basse et feuille (mobile).
 * Fonctions pures, sans React : testées dans nav.test.ts.
 */
export type NavBadge = "open" | "alerts" | "prices";
/** `desk` : écran réservé à l'ordinateur (voir DESK_RULES), signalé comme tel en mode poche. */
export type NavNode = { id: string; label: string; href?: string; icon?: string; badge?: NavBadge; action?: boolean; desk?: boolean; children?: NavNode[] };
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

/* ---------- Mode poche : écrans réservés à l'ordinateur ---------- */

type DeskRule = { path: RegExp; /** rubrique affichée au-dessus du titre ; null : le sous-titre de l'écran (nom du logement) */ section: string | null; why: string; /** choix « Afficher quand même » partagé par plusieurs chemins */ group?: string };

const LOGEMENT = "/logements/[^/]+";
/** Source unique des écrans réservés à l'ordinateur : le menu (champ `desk`) et l'encart s'en déduisent. Un écran absent d'ici s'affiche normalement sur téléphone. */
export const DESK_RULES: DeskRule[] = [
  { path: /^\/parametres(\/(compte|priorisation|demo))?$/, section: "Paramètres", why: "Les réglages demandent de la place et de l'attention." },
  { path: /^\/proprietaires$/, section: "Paramètres", why: "La gestion des propriétaires demande de la place et de l'attention." },
  { path: /^\/integrations(\/erreurs)?$/, section: "Paramètres", why: "Le réglage des connexions et le diagnostic des erreurs demandent de la place et de l'attention." },
  { path: /^\/modeles(\/(cles|agents|budget|catalogue))?$/, section: "IA & modèles", why: "La saisie des clés et le choix des modèles demandent de la place et de l'attention." },
  // le parcours de création est un seul écran pour la personne : l'étape 1 et la suite du dossier partagent le même choix
  { path: new RegExp(`^(/logements/nouveau|${LOGEMENT}/creation)$`), section: "Logements", why: "La création d'un logement enchaîne des formulaires longs et des montants à saisir.", group: "creation" },
  { path: new RegExp(`^${LOGEMENT}/(modifier|supprimer)$`), section: null, why: "La modification et la suppression d'un logement demandent de l'attention." },
  { path: new RegExp(`^${LOGEMENT}/(couts|saisons|strategie|compilateur|versions-economie)$`), section: null, why: "Les coûts, les seuils et la stratégie se règlent avec de nombreuses saisies chiffrées." },
  { path: new RegExp(`^${LOGEMENT}/(mapping|qualite|validations|ecarts-reservations)$`), section: null, why: "Ces contrôles comparent des tableaux larges, plus lisibles sur un grand écran." },
  { path: /^\/bilan$/, section: "Analyse", why: "Cette lecture longue est plus confortable sur un grand écran." },
  { path: /^\/methode$/, section: "Agence IA", why: "Cette lecture longue est plus confortable sur un grand écran." },
];

/**
 * Rubriques de la fiche d'un logement (`?tab=`) réservées à l'ordinateur, avec leur motif.
 * « Vue d'ensemble » (performance comprise) et « Historique » restent consultables sur téléphone.
 */
export const DESK_SECTION_WHY: Record<string, string> = {
  calendrier: "Quatre-vingt-dix jours de prix se lisent mieux sur un grand écran ; la fiche montre les quatorze prochains.",
  strategie: "La stratégie et les canaux se règlent avec de nombreuses saisies chiffrées.",
  economie: "Les coûts et les planchers demandent de la place et de l'attention.",
  donnees: "Les connexions et les contrôles des données demandent de la place et de l'attention.",
};

/** Clé du choix « Afficher quand même » partagée par les onglets et les sous-pages d'une rubrique de la fiche. */
const rubricKey = (propertyPath: string, section: string) => `${propertyPath}?rubrique=${section}`;
/** Vrai quand le choix « Afficher quand même » vaut pour toute une rubrique du logement, et pas pour un seul écran. */
export const coversRubric = (screen: Pick<DeskScreen, "key">) => screen.key.includes("?rubrique=");

export type DeskScreen = {
  /** clé du choix « Afficher quand même » (une rubrique de la fiche : un seul choix pour tous ses écrans) */ key: string;
  section: string | null; why: string;
  /** retour vers un écran disponible sur téléphone */ back: string;
  /** adresse de l'écran à transmettre à la route de bascule : chemin, plus l'onglet quand c'est lui qui est réservé */ address: string;
};

/** L'écran réservé à l'ordinateur qui correspond à cette adresse (chemin, avec ou sans paramètres), ou null. */
export function deskScreen(address: string): DeskScreen | null {
  const [target] = address.split("#");
  const mark = target.indexOf("?");
  const pathname = mark < 0 ? target : target.slice(0, mark);
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const property = propertyIdOf(path);
  const rule = DESK_RULES.find((r) => r.path.test(path));
  if (rule) {
    // la sous-page d'une rubrique réservée (`/couts`, `/mapping`…) partage le choix de cette rubrique ; le parcours de création garde le sien
    const rubrique = property && !rule.group ? PROPERTY_SECTIONS.find((s) => DESK_SECTION_WHY[s.key] && s.pages.includes(path.split("/")[3])) : undefined;
    const key = rubrique ? rubricKey(`/logements/${property}`, rubrique.key) : rule.group ?? path;
    return { key, section: rule.section, why: rule.why, back: rule.group ? "/logements" : property ? `/logements/${property}` : "/", address: path };
  }
  // la fiche elle-même : c'est l'onglet qui décide
  if (!property || path !== `/logements/${property}` || mark < 0) return null;
  const tab = new URLSearchParams(target.slice(mark + 1)).get("tab");
  if (!tab) return null;
  const section = sectionOfTab(tab);
  const why = DESK_SECTION_WHY[section.key];
  return why ? { key: rubricKey(path, section.key), section: section.label, why, back: path, address: `${path}?tab=${encodeURIComponent(tab)}` } : null;
}

/** Feuille « Plus » en mode poche : [identifiant du nœud, libellé, précision]. */
const POCKET_LINKS: [string, string, string?][] = [["historique", "Historique des décisions"], ["equipe", "Équipe de l'agence"], ["rapports", "Rapports mensuels", "lecture"], ["glossaire", "Glossaire"]];
const POCKET_DESK_LINKS: [string, string][] = [["parametres", "Paramètres"], ["modeles", "IA & modèles"], ["integrations", "Intégrations"], ["ajouter-logement", "Création d'un logement"], ["bilan", "Analyse"], ["methode", "Méthode"]];
/** Le coupe-circuit reste utilisable sur téléphone : il s'affiche au-dessus de l'encart de l'écran Intégrations. */
export const KILL_SWITCH_HREF = "/integrations";

export type PocketLink = { id: string; label: string; href: string; hint?: string };
/** Liens de la feuille allégée, tirés de l'arborescence : un nœud absent (droit manquant) n'est pas proposé. */
export function pocketMenu(groups: NavGroup[]): { links: PocketLink[]; desk: PocketLink[] } {
  const all = new Map<string, NavNode>();
  const walk = (nodes: NavNode[]) => nodes.forEach((n) => { all.set(n.id, n); walk(n.children ?? []); });
  walk(groups.flatMap((g) => g.items));
  const pick = ([id, label, hint]: [string, string, string?]): PocketLink[] => { const href = all.get(id)?.href; return href ? [{ id, label, href, hint }] : []; };
  return { links: POCKET_LINKS.flatMap(pick).filter((l) => !all.get(l.id)!.desk), desk: POCKET_DESK_LINKS.flatMap(pick).filter((l) => all.get(l.id)!.desk) };
}

/** En-tête posé par le proxy (src/proxy.ts) : chemin et paramètres de la page demandée, lus côté serveur. */
export const PATH_HEADER = "x-ns-chemin";
/** Bascule entre version allégée et version complète (route GET /vue). À utiliser avec un lien `<a>` : un `<Link>` la préchargerait et changerait de mode tout seul. */
export const viewHref = (mode: "poche" | "complet", retour: string) => `/vue?mode=${mode}&retour=${encodeURIComponent(retour)}`;

/** `properties` : du plus ancien au plus récent. `canAdd` : le rôle permet d'ajouter un logement. */
export function buildNav(properties: NavProperty[], currentPropertyId: string | null = null, canAdd = true): NavGroup[] {
  const { shown, truncated } = menuProperties(properties, currentPropertyId);
  const logements: NavNode[] = shown.map((p) => ({
    id: `property:${p.id}`, label: p.name || "Logement sans nom", href: `/logements/${p.id}`,
    children: PROPERTY_SECTIONS.map((s) => ({ id: sectionNodeId(p.id, s.key), label: s.label, href: sectionHref(p.id, s.key) })),
  }));
  if (truncated) logements.push({ id: "tous-les-logements", label: `Tous les logements (${properties.length})`, href: "/logements" });
  if (canAdd) logements.push({ id: "ajouter-logement", label: "Ajouter un logement", href: "/logements/nouveau", icon: "plus", action: true });
  const groups: NavGroup[] = [
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
  const mark = (n: NavNode): NavNode => ({
    ...n,
    ...(n.href && deskScreen(n.href) ? { desk: true } : {}),
    ...(n.children ? { children: n.children.map(mark) } : {}),
  });
  return groups.map((g) => ({ ...g, items: g.items.map(mark) }));
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
