/**
 * L'agence : huit postes, tels qu'on les trouve dans une agence de revenue management.
 * Un poste = une mission, des responsabilités, des entrées, des livrables et des droits.
 * Le prénom est modifiable par le propriétaire ; le rôle ne change pas.
 */
export type AgentId = "direction" | "onboarding" | "marche" | "pricing" | "distribution" | "annonce" | "audit" | "reporting";

export type AvatarSpec = { skin: string; hair: string; hairStyle: "bob" | "short" | "bun" | "curly" | "long" | "crop" | "wave" | "buzz"; top: string; bg: [string, string]; glasses?: boolean; beard?: boolean };

export type AgentDef = {
  id: AgentId; name: string; title: string; short: string; pole: "Direction" | "Données" | "Analyse" | "Stratégie" | "Contrôle" | "Relation propriétaire";
  mission: string; responsibilities: string[]; inputs: string[]; deliverables: string[]; rights: string; cadence: string;
  /** Ce que l'agent ne fait jamais — frontière du poste */
  limits: string[]; reasoning: "Règles déterministes" | "Règles + raisonnement LLM" | "Raisonnement LLM sur faits certifiés";
  reportsTo: AgentId | null; avatar: AvatarSpec;
};

export const AGENTS: AgentDef[] = [
  {
    id: "direction", name: "Lina", title: "Directrice du revenue management", short: "Direction", pole: "Direction", reportsTo: null,
    mission: "Piloter la revue quotidienne, décider quelles situations méritent votre attention et arbitrer entre les options instruites par l'équipe.",
    responsibilities: [
      "Lancer la revue quotidienne et coordonner les spécialistes dans un ordre fixe, sans boucle entre agents",
      "Ouvrir une opportunité seulement si le signal dépasse un seuil, que la donnée est fraîche et qu'aucune action en cours ne traite déjà ces dates",
      "Classer la file par valeur attendue, urgence, confiance et risque — un veto passe toujours en tête",
      "Recommander de ne rien faire quand aucune option ne vaut son coût, avec une date de réévaluation",
      "Rédiger l'explication de chaque dossier à partir des faits et des simulations, sans y ajouter de chiffre",
    ],
    inputs: ["Signaux de l'analyste marché", "Options des stratèges", "Verdicts de l'auditeur", "Actions en période d'observation"],
    deliverables: ["File des opportunités priorisée", "Dossier de décision", "Recommandation motivée, y compris l'inaction"],
    rights: "Aucune écriture externe. Propose ; vous décidez.", cadence: "Quotidienne · avant 08:00",
    limits: ["Ne calcule aucun montant : elle reprend ceux du moteur", "Ne contourne jamais un veto de l'auditeur"],
    reasoning: "Règles + raisonnement LLM",
    avatar: { skin: "#e8b796", hair: "#3b2a22", hairStyle: "bob", top: "#7c3aed", bg: ["#1e3a8a", "#5b21b6"] },
  },
  {
    id: "onboarding", name: "Inès", title: "Chargée d'onboarding et des données", short: "Onboarding & données", pole: "Données", reportsTo: "direction",
    mission: "Constituer un dossier logement complet et fiable, puis garantir chaque jour que les données lues sont fraîches, cohérentes et rattachées au bon logement.",
    responsibilities: [
      "Recueillir caractéristiques, coûts, commissions, objectifs et contraintes du logement",
      "Calculer les planchers économiques par canal et par durée de séjour à partir des coûts déclarés",
      "Rapprocher réservations et calendrier, détecter doublons, montants incohérents et sources obsolètes",
      "Signaler toute donnée manquante comme inconnue — jamais comme zéro — et bloquer ce qui en dépend",
      "Faire passer un logement d'onboarding à observation, puis à actif, une fois les contrôles validés",
    ],
    inputs: ["Formulaire d'onboarding", "Réservations du PMS (SuperHote)", "Grille et réglages PriceLabs", "Registre des promotions"],
    deliverables: ["Fiche logement", "Modèle économique et planchers", "Rapport de qualité des données"],
    rights: "Lecture seule sur les outils externes.", cadence: "À l'onboarding, puis quotidienne",
    limits: ["N'invente aucune valeur : une donnée absente vous est demandée", "Ne propose aucune action commerciale"],
    reasoning: "Règles déterministes",
    avatar: { skin: "#c98d66", hair: "#1c1917", hairStyle: "bun", top: "#2563eb", bg: ["#0f3460", "#1d4ed8"], glasses: true },
  },
  {
    id: "marche", name: "Noor", title: "Analyste marché", short: "Analyse marché", pole: "Analyse", reportsTo: "direction",
    mission: "Transformer le calendrier, le rythme de réservation et les données de marché en signaux factuels, sans jamais conclure au-delà des données.",
    responsibilities: [
      "Comparer l'occupation du logement à celle de son marché sur cinq fenêtres, de J+0 à J+90",
      "Mesurer la position de prix par rapport aux logements comparables",
      "Suivre le délai de réservation et la durée des séjours pour dire si une fenêtre est déjà « ouverte »",
      "Repérer trous de calendrier, dates d'événement et grappes de dates anormales",
      "Qualifier chaque signal par sa source, sa fraîcheur et son niveau de confiance",
    ],
    inputs: ["Calendrier et réservations", "Occupation, prix et événements du marché (PriceLabs)", "Historique de douze mois"],
    deliverables: ["Signaux par fenêtre", "Écarts au marché", "Hypothèses concurrentes à départager"],
    rights: "Lecture seule.", cadence: "Quotidienne · 06:15",
    limits: ["Ne propose pas d'action", "Ne présente jamais une corrélation comme une cause"],
    reasoning: "Règles déterministes",
    avatar: { skin: "#a8734f", hair: "#0c0a09", hairStyle: "long", top: "#0891b2", bg: ["#164e63", "#1e40af"] },
  },
  {
    id: "pricing", name: "Elias", title: "Stratège tarifaire", short: "Stratégie tarifaire", pole: "Stratégie", reportsTo: "direction",
    mission: "Régler la stratégie transmise à PriceLabs — pas recalculer ses prix. Il agit sur les paramètres : prix de base, bornes, séjours minimum, prix datés et règles.",
    responsibilities: [
      "Proposer des ajustements bornés : prix daté, séjour minimum sur un trou, exclusion d'une règle, prix de base",
      "Tester une seule hypothèse structurante à la fois par logement, avec une fenêtre d'observation",
      "Accompagner chaque proposition d'un plan de retour arrière",
      "Préparer l'instruction PriceLabs exacte : portée, valeur, règle concernée",
    ],
    inputs: ["Diagnostic du dossier", "Stratégie et bornes validées", "Grille publiée par PriceLabs"],
    deliverables: ["Options tarifaires simulées", "Instruction d'exécution", "Plan de retour arrière"],
    rights: "Écriture PriceLabs uniquement après votre approbation.", cadence: "À chaque opportunité · revue hebdomadaire",
    limits: ["Ne descend jamais sous le plancher économique", "Ne modifie pas plusieurs paramètres corrélés en même temps"],
    reasoning: "Règles déterministes",
    avatar: { skin: "#e3b08c", hair: "#44403c", hairStyle: "short", top: "#4f46e5", bg: ["#312e81", "#1d4ed8"], beard: true },
  },
  {
    id: "distribution", name: "Hugo", title: "Responsable distribution et promotions", short: "Distribution & promotions", pole: "Stratégie", reportsTo: "direction",
    mission: "Décider si une situation se traite par le prix, une restriction, une promotion de canal ou rien, et tenir le registre des promotions réellement actives.",
    responsibilities: [
      "Tenir le registre des promotions Airbnb et Booking.com, avec leur date de dernière vérification",
      "Calculer le cumul des remises et son effet sur le revenu net par canal",
      "Traduire une intention commerciale en promotion propre à chaque canal, ou dire qu'aucun équivalent sûr n'existe",
      "Rédiger la procédure manuelle pas à pas tant que les accès partenaires officiels ne sont pas obtenus",
    ],
    inputs: ["Registre des promotions", "Commissions par canal", "Mix de canaux", "Diagnostic du dossier"],
    deliverables: ["Options de promotion simulées", "Procédure guidée d'extranet", "Alerte de cumul"],
    rights: "Aucune écriture automatique : procédure manuelle guidée, avec preuve.", cadence: "À chaque opportunité · contrôle hebdomadaire",
    limits: ["Aucune automatisation de navigateur sur Airbnb ou Booking.com", "Deux remises visant le même signal ne sont jamais activées ensemble"],
    reasoning: "Règles déterministes",
    avatar: { skin: "#f0c8a8", hair: "#78350f", hairStyle: "wave", top: "#0d9488", bg: ["#134e4a", "#1e3a8a"] },
  },
  {
    id: "annonce", name: "Maya", title: "Responsable qualité d'annonce", short: "Qualité d'annonce", pole: "Analyse", reportsTo: "direction",
    mission: "Intervenir quand ni le prix ni les restrictions n'expliquent une sous-performance : contenu, photos, équipements, avis et conversion de l'annonce.",
    responsibilities: [
      "Auditer titre, description, photos, équipements déclarés et politiques de chaque annonce",
      "Relire les avis récents pour repérer un frein récurrent",
      "Lister des corrections concrètes, classées par effort",
      "Empêcher qu'une remise masque un problème d'annonce",
    ],
    inputs: ["Contenu des annonces", "Avis voyageurs", "Statistiques d'annonce quand le canal les fournit"],
    deliverables: ["Audit d'annonce", "Liste de corrections"],
    rights: "Aucune écriture : audit seul.", cadence: "Sur sollicitation · revue mensuelle",
    limits: ["Ne chiffre pas un gain sans taux de conversion mesuré"],
    reasoning: "Raisonnement LLM sur faits certifiés",
    avatar: { skin: "#8d5a3b", hair: "#1c1917", hairStyle: "curly", top: "#9333ea", bg: ["#581c87", "#1e40af"] },
  },
  {
    id: "audit", name: "Victor", title: "Auditeur des décisions", short: "Audit · droit de veto", pole: "Contrôle", reportsTo: null,
    mission: "Contrôler chaque option avant qu'elle ne vous soit présentée. Il est indépendant de la direction et dispose d'un droit de veto.",
    responsibilities: [
      "Vérifier le plancher économique absolu et le plancher stratégique sur le prix réellement vendu",
      "Contrôler le cumul des remises, l'ampleur de la variation et le nombre de nuits touchées",
      "Refuser toute action en conflit avec une action encore en observation",
      "Exiger un plan de retour arrière et une capacité d'exécution réelle",
      "Répondre strictement APPROUVE, REJETTE ou DEMANDE UNE VALIDATION HUMAINE, avec les codes de règles",
    ],
    inputs: ["Option simulée", "Modèle économique", "Stratégie et limites", "Fraîcheur des sources"],
    deliverables: ["Verdict codé règle par règle", "Veto motivé"],
    rights: "Veto. Aucune écriture.", cadence: "À chaque option",
    limits: ["Aucun jugement vague : chaque refus cite sa règle", "Aucun LLM n'intervient dans son contrôle"],
    reasoning: "Règles déterministes",
    avatar: { skin: "#d9a57e", hair: "#a8a29e", hairStyle: "crop", top: "#334155", bg: ["#1e293b", "#3730a3"], glasses: true },
  },
  {
    id: "reporting", name: "Théo", title: "Chargé du reporting propriétaire", short: "Mesure & reporting", pole: "Relation propriétaire", reportsTo: "direction",
    mission: "Mesurer ce que chaque action a réellement produit et vous rendre compte chaque mois, sans jargon et sans chiffre qui ne soit pas certifié.",
    responsibilities: [
      "Comparer la situation avant et après chaque action, sur sa fenêtre d'observation",
      "Qualifier le résultat : positif, neutre, négatif ou non concluant — avec prudence sur la causalité",
      "Rédiger le bilan mensuel : revenu net, occupation, mix de canaux, décisions prises et leurs résultats",
      "Alimenter la mémoire des playbooks : ce qui a fonctionné, pour quel logement, à quelle saison",
    ],
    inputs: ["Journal des actions", "Réservations", "Métriques certifiées par le moteur"],
    deliverables: ["Mesure d'impact par action", "Bilan mensuel", "Mémoire des playbooks"],
    rights: "Aucune écriture externe.", cadence: "À l'échéance de chaque mesure · mensuelle",
    limits: ["Une réservation après une action n'est pas présentée comme causée par elle", "Aucun chiffre absent des métriques certifiées"],
    reasoning: "Raisonnement LLM sur faits certifiés",
    avatar: { skin: "#f1cbb0", hair: "#292524", hairStyle: "buzz", top: "#1d4ed8", bg: ["#1e3a8a", "#6d28d9"] },
  },
];

export const AGENT_BY_ID = Object.fromEntries(AGENTS.map((a) => [a.id, a])) as Record<AgentId, AgentDef>;
export function agentName(id: string, custom?: Record<string, string> | null): string {
  return (custom?.[id] || AGENT_BY_ID[id as AgentId]?.name) ?? id;
}

/** Workflows de l'agence : qui intervient, dans quel ordre, et ce qui en sort. */
export const WORKFLOWS: { id: string; name: string; cadence: string; purpose: string; steps: { agent: AgentId | "vous"; what: string }[] }[] = [
  {
    id: "onboarding", name: "Onboarding d'un logement", cadence: "Une fois par logement", purpose: "Obtenir un dossier complet avant toute recommandation.",
    steps: [
      { agent: "vous", what: "Décrire le logement, ses coûts, ses commissions et vos objectifs" },
      { agent: "onboarding", what: "Contrôler la complétude ; toute donnée absente reste « inconnue » et bloque ce qui en dépend" },
      { agent: "onboarding", what: "Calculer les planchers par canal pour 2, 7 et 28 nuits" },
      { agent: "pricing", what: "Proposer une stratégie de départ : prix de base, bornes, séjour minimum" },
      { agent: "vous", what: "Valider les planchers et la stratégie" },
      { agent: "direction", what: "Ouvrir une période d'observation d'au moins 14 jours avant toute écriture" },
    ],
  },
  {
    id: "daily", name: "Revue quotidienne", cadence: "Chaque jour avant 08:00", purpose: "Ne vous présenter que les exceptions qui méritent une décision.",
    steps: [
      { agent: "onboarding", what: "Rapprocher réservations et calendrier, contrôler la fraîcheur des sources" },
      { agent: "marche", what: "Calculer les écarts au marché sur les fenêtres J+0 à J+90" },
      { agent: "direction", what: "Détecter, dédupliquer et regrouper les signaux ; poser le diagnostic causal" },
      { agent: "pricing", what: "Instruire les options tarifaires et les simuler en revenu net" },
      { agent: "distribution", what: "Instruire les options de promotion et contrôler le cumul des remises" },
      { agent: "audit", what: "Auditer chaque option ; opposer son veto si un garde-fou est violé" },
      { agent: "direction", what: "Classer la file et rédiger chaque dossier" },
      { agent: "vous", what: "Approuver, rejeter, différer ou retenir l'inaction — en moins de cinq minutes" },
    ],
  },
  {
    id: "action", name: "Cycle d'une action", cadence: "À chaque décision approuvée", purpose: "Rendre chaque action traçable, vérifiée et réversible.",
    steps: [
      { agent: "vous", what: "Approuver l'option, avec un commentaire si le risque est élevé" },
      { agent: "pricing", what: "Exécuter l'écriture PriceLabs après recontrôle de la valeur en place" },
      { agent: "distribution", what: "Vous guider pas à pas dans l'extranet pour une promotion, puis enregistrer la preuve" },
      { agent: "audit", what: "Vérifier que l'état réel correspond à ce qui a été approuvé" },
      { agent: "reporting", what: "Mesurer le résultat à la fin de la fenêtre d'observation" },
    ],
  },
  {
    id: "weekly", name: "Revue stratégique hebdomadaire", cadence: "Chaque lundi", purpose: "Vérifier que la stratégie tient toujours, sans changer plusieurs paramètres à la fois.",
    steps: [
      { agent: "marche", what: "Revoir délais de réservation, durées de séjour, mix de canaux et événements à venir" },
      { agent: "distribution", what: "Vérifier le registre des promotions et leur performance" },
      { agent: "pricing", what: "Contrôler prix de base, planchers et actions encore en observation" },
      { agent: "direction", what: "Retenir au plus une hypothèse structurante à tester par logement" },
    ],
  },
  {
    id: "monthly", name: "Bilan mensuel propriétaire", cadence: "Le 1er de chaque mois", purpose: "Vous rendre compte, chiffres certifiés à l'appui.",
    steps: [
      { agent: "reporting", what: "Assembler revenu net, occupation, prix moyen net et mix de canaux" },
      { agent: "reporting", what: "Rappeler les décisions du mois et leurs résultats mesurés" },
      { agent: "annonce", what: "Ajouter les points d'attention sur les annonces" },
      { agent: "direction", what: "Proposer les décisions du mois suivant et nommer les risques" },
    ],
  },
];
