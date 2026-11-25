/**
 * Les trois « hubs » de la fiche logement et leurs écrans : une seule liste, lue par les cartes des hubs, la vue d'ensemble
 * et la feuille des sections (mobile et tablette). Fonctions pures : testées dans property-hubs.test.ts.
 */
export type HubKey = "strategie" | "economie" | "donnees";
export type ScreenKey = "strategie" | "builder" | "canaux" | "compilateur" | "couts" | "planchers" | "saisons" | "versions"
  | "superhote" | "pricelabs" | "annonces" | "mapping" | "qualite-donnees" | "checklist" | "ecarts" | "validations";
export type PropertyRef = { id: string; isDemo: boolean; status: string; economicsVersion: number };

/** reel : pas sur un logement de démonstration ; lance : réel et parcours de création terminé ; versionne : réel avec au moins une version. */
type Need = "reel" | "lance" | "versionne";
type ScreenDef = { key: ScreenKey; label: string; path: string; description: string; need?: Need };
export type PropertyScreen = ScreenDef & { href: string };

export const isLaunched = (p: Pick<PropertyRef, "isDemo" | "status">) => !p.isDemo && p.status !== "ONBOARDING";

export const HUBS: { key: HubKey; tab: `hub-${HubKey}`; label: string; description: string; screens: ScreenDef[] }[] = [
  { key: "strategie", tab: "hub-strategie", label: "Stratégie & prix", description: "La stratégie de prix, ses brouillons, les canaux et les promotions.", screens: [
    { key: "strategie", label: "Stratégie en vigueur", path: "?tab=strategie", description: "Objectif, prix de base, bornes et séjour minimum." },
    { key: "builder", label: "Strategy Builder", path: "/strategie", description: "Préparer un brouillon, le publier, relire l'historique.", need: "lance" },
    { key: "canaux", label: "Canaux et promotions", path: "?tab=canaux", description: "Mix de canaux et registre des promotions." },
    { key: "compilateur", label: "Compilateur", path: "/compilateur", description: "Traduire une intention en règle de promotion contrôlée." },
  ] },
  { key: "economie", tab: "hub-economie", label: "Économie", description: "Ce que coûte une nuit et le prix en dessous duquel elle ne se vend pas.", screens: [
    { key: "couts", label: "Coûts et seuils", path: "/couts", description: "Commissions, ménage, linge et seuils par nuit.", need: "reel" },
    { key: "planchers", label: "Planchers par canal", path: "?tab=economie", description: "Prix vendu minimal par canal et durée de séjour." },
    { key: "saisons", label: "Saisons du plancher", path: "/saisons", description: "Relever ou abaisser le plancher selon les dates.", need: "reel" },
    { key: "versions", label: "Versions du modèle", path: "/versions-economie", description: "Historique des modèles économiques publiés.", need: "versionne" },
  ] },
  { key: "donnees", tab: "hub-donnees", label: "Données & connexions", description: "Les sources lues par la revue et ce qui reste à vérifier.", screens: [
    { key: "superhote", label: "SuperHote", path: "?tab=superhote", description: "Réservations, calendrier envoyé et webhook." },
    { key: "pricelabs", label: "PriceLabs", path: "?tab=pricelabs", description: "Prix recommandés, marché et instantanés." },
    { key: "annonces", label: "Annonces", path: "?tab=annonces", description: "Les annonces publiées sur chaque canal." },
    { key: "mapping", label: "Mapping des identifiants", path: "/mapping", description: "Vérifier que chaque source désigne le même logement.", need: "lance" },
    { key: "qualite-donnees", label: "Qualité des données", path: "?tab=donnees", description: "Fraîcheur et complétude de chaque source." },
    { key: "checklist", label: "Checklist de qualité", path: "/qualite", description: "Ce qui doit être vrai avant d'activer le logement.", need: "lance" },
    { key: "ecarts", label: "Écarts de réservations", path: "/ecarts-reservations", description: "SuperHote comparé à PriceLabs.", need: "reel" },
    { key: "validations", label: "Validations avant activation", path: "/validations", description: "Planchers et rapprochement validés par une personne.", need: "lance" },
  ] },
];

const allowed = (p: PropertyRef, need?: Need) =>
  !need || (need === "reel" ? !p.isDemo : need === "lance" ? isLaunched(p) : !p.isDemo && p.economicsVersion > 0);

export const hubByKey = (key: HubKey) => HUBS.find((h) => h.key === key)!;
export const hubByTab = (tab: string) => HUBS.find((h) => h.tab === tab);

/** Écrans d'un hub réellement ouvrables pour ce logement (les autres ne sont pas montrés). */
export const hubScreens = (key: HubKey, p: PropertyRef): PropertyScreen[] =>
  hubByKey(key).screens.filter((s) => allowed(p, s.need)).map((s) => ({ ...s, href: `/logements/${p.id}${s.path}` }));
