/**
 * Catalogue des playbooks (blueprint §9.5, US-060). Source unique des seuils, des données nécessaires, du cooldown, des candidates,
 * des règles de veto, de l'approbateur, de la vérification et de l'horizon de mesure de chaque playbook : « chaque playbook définit
 * seuils, données nécessaires, cooldown, candidates, règles de veto, approbateur, vérification et horizon de mesure ».
 *
 * Module pur, sans accès base. Les règles de signal (`signals.ts`) lisent leurs seuils ici et nulle part ailleurs : changer un seuil se fait
 * à un seul endroit, et la page « Méthode » affiche ce catalogue tel quel.
 *
 * Le blueprint s'arrête à PB-12 ; PB-13 (minimum PriceLabs sous le plancher) est une extension décidée avec la propriétaire.
 */
import type { FreshnessKind } from "../freshness";
import type { CandidateType } from "./types";

export type PlaybookCode = "PB-01" | "PB-02" | "PB-03" | "PB-04" | "PB-05" | "PB-06" | "PB-07" | "PB-08" | "PB-09" | "PB-10" | "PB-11" | "PB-12" | "PB-13";
/** Donnée dont dépend un signal : sa fraîcheur est contrôlée avant d'ouvrir une opportunité (US-061). */
export type DataKind = FreshnessKind | "ECONOMICS" | "STRATEGY";
/** Qui valide une action du playbook (blueprint §11.2) : jamais un agent. */
export type Approver = "REVENUE_MANAGER" | "REVENUE_MANAGER_AND_OWNER" | "OPERATOR_AND_RM" | "NONE";

export type Threshold = { value: number; unit: string; label: string };

export type Playbook = {
  code: PlaybookCode;
  key: string;
  label: string;
  /** Déclencheur résumé (§9.5). */
  trigger: string;
  /** IMPLEMENTED = le moteur ouvre des opportunités ; PLANNED = décrit au blueprint, pas encore codé. */
  status: "IMPLEMENTED" | "PLANNED";
  thresholds: Record<string, Threshold>;
  requiredData: DataKind[];
  /** Jours pendant lesquels un dossier tranché par un humain n'est pas rouvert pour le même signal (US-061). */
  cooldownDays: number;
  candidates: CandidateType[];
  /** Exclusions majeures (§9.5) : cas où le playbook ne propose pas d'action commerciale. */
  exclusions: string[];
  /** Règles de l'auditeur qui peuvent opposer un veto à une candidate de ce playbook. */
  vetoRules: string[];
  approver: Approver;
  verification: string;
  /** Fenêtre d'observation avant de mesurer le résultat d'une action, en jours. */
  measurementHorizonDays: number;
};

const t = (value: number, unit: string, label: string): Threshold => ({ value, unit, label });

export const PLAYBOOKS: Record<PlaybookCode, Playbook> = {
  "PB-01": {
    code: "PB-01", key: "PACE_LOW", label: "Rythme sous le marché", status: "IMPLEMENTED",
    trigger: "L'occupation d'une fenêtre à venir est nettement sous celle du marché, avec assez de nuits libres pour agir.",
    thresholds: {
      paceGap: t(-0.18, "points", "Écart d'occupation au marché à partir duquel on parle de retard (fenêtre J+8 et au-delà)"),
      minFreeNights: t(4, "nuits", "Nuits libres minimales dans la fenêtre"),
      weakMarketOccupancy: t(0.35, "ratio", "Occupation du marché en dessous de laquelle la demande est jugée faible"),
      priceHighPercentile: t(65, "percentile", "Position de prix à partir de laquelle le prix est jugé au-dessus du marché"),
      restrictiveMinStay: t(3, "nuits", "Séjour minimum à partir duquel la restriction peut écarter la demande"),
      maxTargetNights: t(14, "nuits", "Nuits ciblées au plus par action"),
    },
    requiredData: ["AVAILABILITY", "MARKET", "PRICING"],
    cooldownDays: 14,
    candidates: ["PRICE_OVERRIDE", "CHANNEL_PROMO", "LISTING_AUDIT", "NO_ACTION"],
    exclusions: ["Marché également faible, sans avantage clair à baisser le prix", "Fenêtre de réservation pas encore ouverte pour ce logement"],
    vetoRules: ["HARD_FLOOR", "DISCOUNT_STACK", "CONFLICT"],
    approver: "REVENUE_MANAGER",
    verification: "Relire les prix datés dans PriceLabs, ou la promotion dans l'extranet du canal, puis comparer le rythme de réservation à celui d'avant l'action.",
    measurementHorizonDays: 7,
  },
  "PB-02": {
    code: "PB-02", key: "PACE_HIGH", label: "Réservations trop précoces", status: "IMPLEMENTED",
    trigger: "Une fenêtre lointaine se remplit bien plus vite que le marché : le prix de base est probablement trop bas à cet horizon.",
    thresholds: {
      paceGap: t(0.25, "points", "Avance sur le marché à partir de laquelle on parle d'avance (fenêtre J+31 et au-delà)"),
      minOccupancy: t(0.55, "ratio", "Occupation minimale de la fenêtre"),
      minFreeNights: t(4, "nuits", "Nuits libres minimales à l'horizon pour que la hausse serve"),
      strongGap: t(0.35, "points", "Avance au-delà de laquelle la confiance augmente"),
    },
    requiredData: ["AVAILABILITY", "MARKET", "PRICING", "STRATEGY"],
    cooldownDays: 21,
    candidates: ["BASE_PRICE_CHANGE", "PRICE_OVERRIDE", "NO_ACTION"],
    exclusions: ["Événement mal capturé : un séjour long unique ou une date précise peut produire le même signal"],
    vetoRules: ["MAX_VARIATION", "MAX_VARIATION_7D", "STRUCTURAL_LOCK", "CONFLICT"],
    approver: "REVENUE_MANAGER_AND_OWNER",
    verification: "Relire le prix de base dans PriceLabs ; une seule hypothèse structurante à la fois par logement, fenêtre d'observation de 14 jours.",
    measurementHorizonDays: 14,
  },
  "PB-03": {
    code: "PB-03", key: "ORPHAN_GAP", label: "Trou invendable entre deux séjours", status: "IMPLEMENTED",
    trigger: "Un trou de 1 à 3 nuits, encadré par deux séjours, est bloqué par un séjour minimum plus long que lui.",
    thresholds: {
      maxGapNights: t(3, "nuits", "Longueur maximale du trou"),
      minLeadDays: t(2, "jours", "Délai minimal avant la première nuit du trou"),
      maxLeadDays: t(45, "jours", "Délai maximal avant la première nuit du trou"),
    },
    requiredData: ["AVAILABILITY", "PRICING"],
    cooldownDays: 7,
    candidates: ["MIN_STAY_OVERRIDE", "NO_ACTION"],
    exclusions: ["Coût de séjour non couvert sur une durée aussi courte"],
    vetoRules: ["HARD_FLOOR", "CONFLICT", "SCOPE"],
    approver: "REVENUE_MANAGER",
    verification: "Relire le séjour minimum daté dans PriceLabs, puis constater si les nuits se réservent.",
    measurementHorizonDays: 7,
  },
  "PB-04": {
    code: "PB-04", key: "CHANNEL_GAP", label: "Un canal sous-performe", status: "IMPLEMENTED",
    trigger: "La part d'un canal dans les nuits déjà réservées à venir est nettement sous sa part habituelle, alors que le logement dans son ensemble suit son marché.",
    thresholds: {
      shareGap: t(-0.2, "points", "Écart de part du canal, face à sa part habituelle, à partir duquel il sous-performe"),
      horizonDays: t(60, "jours", "Horizon des nuits réservées comparées"),
      minOnBooksNights: t(10, "nuits", "Nuits réservées minimales à l'horizon pour comparer"),
      minHistoryStays: t(12, "séjours", "Séjours confirmés minimaux dans l'historique pour établir la part habituelle"),
      maxUnknownChannelShare: t(0.2, "ratio", "Part maximale de séjours au canal non identifié (au-delà, la comparaison n'est pas fiable)"),
      minHistoricalShare: t(0.3, "ratio", "Part habituelle minimale du canal : sous ce seuil, l'écart n'a pas de sens"),
      minFreeNights: t(4, "nuits", "Nuits libres minimales dans l'horizon"),
      maxTargetNights: t(14, "nuits", "Nuits ciblées au plus par action"),
    },
    requiredData: ["RESERVATIONS", "AVAILABILITY", "PROMOTIONS"],
    cooldownDays: 14,
    candidates: ["CHANNEL_PROMO", "LISTING_AUDIT", "NO_ACTION"],
    exclusions: ["Retard général du logement (traité par PB-01)", "Inventaire non distribué sur le canal : non vérifiable sans accès partenaire, à contrôler avant toute remise"],
    vetoRules: ["HARD_FLOOR", "DISCOUNT_STACK", "STACK_RULES"],
    approver: "OPERATOR_AND_RM",
    verification: "Relire la promotion dans l'extranet du canal, puis comparer la part du canal dans les réservations des 14 jours suivants.",
    measurementHorizonDays: 14,
  },
  "PB-05": {
    code: "PB-05", key: "STACK_RISK", label: "Remises cumulées", status: "IMPLEMENTED",
    trigger: "Au moins deux remises d'un même canal se cumulent sur les mêmes nuits au-delà du plafond de la stratégie, ou sous le plancher stratégique.",
    thresholds: {
      minPromotions: t(2, "promotions", "Promotions simultanées minimales"),
      minRunNights: t(2, "nuits", "Nuits contiguës minimales"),
    },
    requiredData: ["PROMOTIONS", "ECONOMICS", "STRATEGY"],
    cooldownDays: 14,
    candidates: ["PROMO_REMOVAL", "NO_ACTION"],
    exclusions: ["Engagement de campagne : une promotion de campagne ne se retire pas librement"],
    vetoRules: ["STACK_RULES", "PROMO_FRESHNESS"],
    approver: "OPERATOR_AND_RM",
    verification: "Relire la liste des promotions actives dans l'extranet du canal et confirmer le registre.",
    measurementHorizonDays: 14,
  },
  "PB-06": {
    code: "PB-06", key: "FLOOR_BREACH", label: "Prix net sous le plancher", status: "IMPLEMENTED",
    trigger: "Le prix vendu simulé d'une nuit libre, après majoration et remises, passe sous le plancher économique absolu.",
    thresholds: {
      minStayFloor: t(2, "nuits", "Durée de séjour retenue pour calculer le plancher quand la stratégie n'en fixe pas"),
    },
    requiredData: ["AVAILABILITY", "PRICING", "ECONOMICS"],
    cooldownDays: 3,
    candidates: ["RULE_EXCLUSION", "PRICE_OVERRIDE", "NO_ACTION"],
    exclusions: [],
    vetoRules: ["HARD_FLOOR"],
    approver: "REVENUE_MANAGER",
    verification: "Relire le prix daté dans PriceLabs puis recalculer le prix vendu net : il doit atteindre le plancher.",
    measurementHorizonDays: 7,
  },
  "PB-07": {
    code: "PB-07", key: "EVENT_UPLIFT", label: "Demande événementielle", status: "IMPLEMENTED",
    trigger: "Un événement déclaré coïncide avec un marché très occupé alors que le prix reste bas dans le marché.",
    thresholds: {
      marketOccupancy: t(0.8, "ratio", "Occupation du marché minimale"),
      maxPricePercentile: t(45, "percentile", "Position de prix maximale"),
    },
    requiredData: ["AVAILABILITY", "MARKET", "PRICING"],
    cooldownDays: 7,
    candidates: ["PRICE_OVERRIDE", "NO_ACTION"],
    exclusions: ["Signal d'événement non confirmé par le marché"],
    vetoRules: ["MAX_VARIATION", "CONFLICT"],
    approver: "REVENUE_MANAGER",
    verification: "Relire le prix daté dans PriceLabs et suivre le rythme de réservation de ces dates.",
    measurementHorizonDays: 14,
  },
  "PB-08": {
    code: "PB-08", key: "CANCELLATION", label: "Dates rouvertes par une annulation", status: "IMPLEMENTED",
    trigger: "Une annulation récente rouvre des nuits à venir encore libres : réévaluer la fenêtre et les promotions, sans remise automatique.",
    thresholds: {
      windowDays: t(3, "jours", "Une annulation reste à traiter pendant ce nombre de jours après son enregistrement"),
      minReopenedNights: t(2, "nuits", "Nuits rouvertes minimales, encore libres, pour ouvrir un dossier"),
      maxLeadDays: t(60, "jours", "Horizon maximal des nuits rouvertes : au-delà, la fenêtre de réservation n'est pas concernée"),
      noActionLeadDays: t(45, "jours", "Au-delà de ce délai avant la première nuit rouverte, l'inaction est retenue (la fenêtre est encore lointaine)"),
      rateWindowDays: t(14, "jours", "Fenêtre du taux d'annulation"),
      expiryDays: t(7, "jours", "Durée de vie du dossier ouvert avant expiration"),
      alertRate: t(0.25, "ratio", "Taux d'annulation sur 14 jours au-delà duquel le dossier signale une série (information, sans changer l'option)"),
      minRateSample: t(4, "séjours", "Réservations prises et annulées minimales sur 14 jours pour calculer un taux (en dessous, le taux est inconnu)"),
    },
    requiredData: ["RESERVATIONS", "AVAILABILITY"], cooldownDays: 3, candidates: ["INVESTIGATION", "NO_ACTION"],
    exclusions: ["Historique des annulations inconnu (logement jamais relu depuis SuperHote) : le playbook reste silencieux", "Nuits déjà revendues ou bloquées", "Action immédiate non justifiée : aucune remise ni baisse de prix n'est proposée"],
    vetoRules: [], approver: "REVENUE_MANAGER",
    verification: "Relire le calendrier des nuits rouvertes et la réservation annulée, puis constater si elles se revendent dans les 7 jours.", measurementHorizonDays: 7,
  },
  "PB-09": {
    code: "PB-09", key: "LONG_STAY", label: "Séjours longs en basse saison", status: "IMPLEMENTED",
    trigger: "Un trou libre d'au moins 7 nuits consécutives, au-delà de J+8, tombe sur une période où le marché est peu occupé (basse saison définie par la donnée) : proposer une offre de durée de séjour 7, 14 ou 28 nuits.",
    thresholds: {
      minGapNights: t(7, "nuits", "Nuits libres consécutives minimales pour parler de trou long"),
      minLeadDays: t(8, "jours", "Délai minimal avant la première nuit du trou"),
      maxLeadDays: t(90, "jours", "Délai maximal avant la première nuit du trou"),
      lowMarketOccupancy: t(0.4, "ratio", "Occupation moyenne du marché sur le trou en dessous de laquelle la période est en basse saison (donnée de marché obligatoire : inconnue = silence)"),
      maxRuns: t(2, "trous", "Trous traités au plus par revue"),
      maxTargetNights: t(28, "nuits", "Nuits du trou ciblées au plus par offre (au-delà, la fenêtre d'arrivées est tronquée)"),
      discount7Pct: t(10, "%", "Remise proposée pour un séjour de 7 nuits et plus"),
      discount14Pct: t(12, "%", "Remise proposée pour un séjour de 14 nuits et plus"),
      discount28Pct: t(18, "%", "Remise proposée pour un séjour de 28 nuits et plus (mensuelle)"),
      commentOverPct: t(15, "%", "Remise de durée de séjour au-delà de laquelle l'approbation exige un commentaire (§11.2)"),
    },
    requiredData: ["AVAILABILITY", "MARKET", "PRICING", "ECONOMICS"], cooldownDays: 14, candidates: ["CHANNEL_PROMO", "INVESTIGATION", "NO_ACTION"],
    exclusions: ["Marché inconnu (ou lu depuis plus de 48 h, donc traité comme inconnu au chargement) : aucune basse saison ne peut être affirmée", "Net du séjour long sous le plancher (une offre dont le prix vendu passe sous le plancher est rejetée par l'auditeur)", "Booking n'a pas de type de promotion de durée de séjour dans le registre : seule une vérification manuelle est proposée, aucune remise inventée", "Nuits déjà traitées par un autre playbook"],
    vetoRules: ["HARD_FLOOR", "DISCOUNT_STACK", "STACK_RULES", "CONFLICT"], approver: "REVENUE_MANAGER",
    verification: "Relire l'offre de durée de séjour dans l'extranet du canal, puis comparer le rythme de réservation des 28 jours suivants.", measurementHorizonDays: 28,
  },
  "PB-10": {
    code: "PB-10", key: "DATA_DRIFT", label: "Données incohérentes ou périmées", status: "IMPLEMENTED",
    trigger: "Le registre des promotions d'un canal n'a pas été vérifié depuis plus de 7 jours : le cumul réel des remises est incertain.",
    thresholds: { maxAgeDays: t(7, "jours", "Ancienneté maximale de la dernière vérification des promotions") },
    requiredData: ["PROMOTIONS"],
    cooldownDays: 7,
    candidates: ["INVESTIGATION"],
    exclusions: ["Aucune action commerciale : seule la donnée est à rétablir"],
    vetoRules: [],
    approver: "OPERATOR_AND_RM",
    verification: "Confirmer le registre après relecture de l'extranet.",
    measurementHorizonDays: 0,
  },
  "PB-11": {
    code: "PB-11", key: "BASE_LOW", label: "Prix de base trop bas", status: "IMPLEMENTED",
    trigger: "Le logement se réserve nettement plus tôt qu'avant, sans ralentir : comparé à lui-même (sans donnée de marché), le délai de réservation récent s'allonge. Relever le prix de base par un palier.",
    thresholds: {
      recentDays: t(28, "jours", "Fenêtre récente des réservations prises"),
      refDays: t(56, "jours", "Fenêtre de référence qui précède la fenêtre récente"),
      minRecentBookings: t(6, "séjours", "Réservations minimales prises dans la fenêtre récente"),
      minRefBookings: t(6, "séjours", "Réservations minimales prises dans la fenêtre de référence"),
      leadGrowth: t(0.5, "ratio", "Allongement relatif du délai médian de réservation (0,5 = 50 % plus anticipé) à partir duquel le prix de base est suspect"),
      minLeadShiftDays: t(14, "jours", "Allongement absolu minimal du délai médian de réservation"),
      minBookingRatio: t(1, "ratio", "Rythme de prises récent ÷ référence, à longueur égale : en dessous, la demande faiblit et le prix n'est pas en cause"),
      maxChannelShift: t(0.25, "ratio", "Déplacement maximal de la part d'un canal dans les nuits vendues : au-delà, le mix de canaux a changé et explique le délai"),
      startOffsetDays: t(14, "jours", "Début de la fenêtre de nuits visées, en jours à partir d'aujourd'hui (les nuits plus proches relèvent du dernier moment)"),
      horizonDays: t(90, "jours", "Fin de la fenêtre de nuits visées, en jours à partir d'aujourd'hui"),
      minFreeNights: t(4, "nuits", "Nuits libres minimales dans la fenêtre visée pour que la hausse serve"),
      stepPct: t(4, "%", "Palier de hausse du prix de base proposé (plafonné à 15 % sur 7 jours, une seule hypothèse structurante à la fois)"),
    },
    requiredData: ["RESERVATIONS", "PRICING", "STRATEGY"], cooldownDays: 21, candidates: ["BASE_PRICE_CHANGE", "NO_ACTION"],
    exclusions: ["Mix de canaux modifié : le délai de réservation change avec le canal", "Historique trop court ou trop peu de réservations : inconnu, le playbook reste silencieux", "PB-02 prioritaire : si l'avance sur le marché explique déjà le signal, PB-11 ne propose rien", "PB-11 prime sur PB-01, PB-04, PB-08 et PB-09 pour les nuits J+14 à J+90 : un signal de hausse et un signal de baisse ne se superposent pas (une seule hypothèse structurante à la fois)", "Prix de base déjà en cours de modification (verrou structurant) ou plafond de 7 jours atteint"],
    vetoRules: ["MAX_VARIATION", "MAX_VARIATION_7D", "STRUCTURAL_LOCK", "CONFLICT"], approver: "REVENUE_MANAGER_AND_OWNER",
    verification: "Relire le prix de base dans PriceLabs ; une seule hypothèse structurante à la fois par logement, observation de 14 jours.", measurementHorizonDays: 14,
  },
  "PB-12": {
    code: "PB-12", key: "BASE_HIGH", label: "Prix de base trop haut", status: "PLANNED",
    trigger: "Sous-performance durable : baisser le prix de base par paliers.",
    thresholds: {}, requiredData: ["RESERVATIONS", "MARKET", "PRICING", "STRATEGY"], cooldownDays: 21, candidates: ["BASE_PRICE_CHANGE", "LISTING_AUDIT", "NO_ACTION"],
    exclusions: ["Contenu ou visibilité non exclus"], vetoRules: ["HARD_FLOOR", "MAX_VARIATION", "MAX_VARIATION_7D", "STRUCTURAL_LOCK"], approver: "REVENUE_MANAGER_AND_OWNER",
    verification: "Relire le prix de base dans PriceLabs.", measurementHorizonDays: 14,
  },
  "PB-13": {
    code: "PB-13", key: "MIN_PRICE_BELOW_FLOOR", label: "Minimum PriceLabs sous le plancher", status: "IMPLEMENTED",
    trigger: "Le prix minimum configuré dans PriceLabs, majoration comprise, laisse vendre sous le plancher absolu d'un canal.",
    thresholds: {},
    requiredData: ["CONFIG", "ECONOMICS", "STRATEGY"],
    cooldownDays: 7,
    candidates: ["MIN_PRICE_CHANGE", "NO_ACTION"],
    exclusions: ["Canal dont la majoration est inconnue (exclu de la revue)"],
    vetoRules: ["HARD_FLOOR"],
    approver: "REVENUE_MANAGER_AND_OWNER",
    verification: "Relire le prix minimum dans PriceLabs.",
    measurementHorizonDays: 14,
  },
};

export const PLAYBOOK_CODES = Object.keys(PLAYBOOKS) as PlaybookCode[];

/**
 * Groupes de repos (blueprint §6.4 : une seule hypothèse structurante à la fois). Les playbooks d'un groupe agissent sur le même levier,
 * le prix de base, souvent dans des sens opposés : une décision humaine sur l'un met les autres au repos.
 */
export const COOLDOWN_GROUPS: PlaybookCode[][] = [["PB-02", "PB-11", "PB-12"]];
export function cooldownGroupOf(code: string): PlaybookCode[] | null {
  return COOLDOWN_GROUPS.find((g) => (g as string[]).includes(code)) ?? null;
}
export const IMPLEMENTED_PLAYBOOKS = PLAYBOOK_CODES.filter((c) => PLAYBOOKS[c].status === "IMPLEMENTED");

/** Seuil d'un playbook, lu au catalogue. Un seuil inconnu est une erreur de programmation : elle éclate au premier test. */
export function threshold(code: PlaybookCode, key: string): number {
  const th = PLAYBOOKS[code].thresholds[key];
  if (!th) throw new Error(`Seuil inconnu : ${code}.${key}`);
  return th.value;
}
export function playbookOf(code: string): Playbook | null {
  return (PLAYBOOKS as Record<string, Playbook>)[code] ?? null;
}
