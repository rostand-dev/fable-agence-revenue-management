import type { Channel, EconomicModel } from "./types";

/**
 * Parcours « Coûts et seuils » : le propriétaire répond à des questions concrètes,
 * le modèle économique en est déduit. Fonction pure, utilisée à l'écran (aperçu) et au serveur (enregistrement).
 */
export type CostAnswers = {
  airbnbPct?: string; bookingPct?: string; bookingFeePct?: string;
  taxMode?: "calc" | "direct" | "none"; taxYear?: string; grossYear?: string; taxPct?: string;
  cleaningFee?: string; cleaningCost?: string;
  linenMode?: "included" | "self" | "service" | ""; linenCost?: string;
  nightMode?: "calc" | "direct"; energyYear?: string; waterYear?: string; consumablesStay?: string; nightsYear?: string; avgStay?: string; variableDirect?: string;
  hard?: string;
  rent?: string; coop?: string; insurance?: string; subs?: string; taxes?: string; other?: string;
  nightsMonth?: string; goalMonth?: string;
  /** clés de réponses données comme estimations provisoires */
  provisional?: string[];
};

/** Champ vide ou illisible = inconnu (null). Zéro n'est retenu que s'il est écrit. */
export function parseNum(v: string | undefined | null): number | null {
  if (v === undefined || v === null) return null;
  const t = String(v).trim().replace(/\s/g, "").replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
const cents = (v: number | null) => (v === null ? null : Math.round(v * 100));
export const FIXED_KEYS = ["rent", "coop", "insurance", "subs", "taxes", "other"] as const;

export function fixedMonthly(a: CostAnswers): number | null {
  const xs = FIXED_KEYS.map((k) => parseNum(a[k])).filter((x): x is number => x !== null);
  return xs.length ? xs.reduce((s, x) => s + x, 0) : null;
}
/** Coût variable par nuit occupée : saisi directement, ou (énergie + eau) ÷ nuits occupées + consommables ÷ durée moyenne. */
export function variablePerNight(a: CostAnswers): number | null {
  if (a.nightMode === "direct") return parseNum(a.variableDirect);
  const e = parseNum(a.energyYear), w = parseNum(a.waterYear), n = parseNum(a.nightsYear), c = parseNum(a.consumablesStay), los = parseNum(a.avgStay);
  if ((e === null && w === null && c === null) || !n) return null;
  if (c !== null && !los) return null;
  return ((e ?? 0) + (w ?? 0)) / n + (c !== null ? c / los! : 0);
}

/** Part de taxe de séjour dans le montant payé par le voyageur, en %. « Aucune » est un zéro déclaré. */
export function touristTaxPct(a: CostAnswers): number | null {
  if (a.taxMode === "none") return 0;
  if (a.taxMode === "direct") return parseNum(a.taxPct);
  const t = parseNum(a.taxYear), g = parseNum(a.grossYear);
  return t !== null && g ? Math.round((t / g) * 1000) / 10 : null;
}

const LABELS: Record<string, string> = {
  airbnbPct: "commission Airbnb", bookingPct: "commission Booking.com", bookingFeePct: "frais de paiement Booking.com", cleaningFee: "frais de ménage facturés", cleaningCost: "coût du ménage",
  linenCost: "coût du linge", variable: "coûts par nuit occupée", hard: "seuil de dérangement", fixed: "charges fixes mensuelles", nightsMonth: "nuits vendues par mois", goalMonth: "revenu mensuel visé",
};

export function modelFromAnswers(a: CostAnswers): EconomicModel {
  const channels: EconomicModel["channels"] = {};
  const ab = parseNum(a.airbnbPct), bk = parseNum(a.bookingPct);
  if (ab !== null) channels.AIRBNB = { commissionPct: ab, paymentFeePct: 0 };
  if (bk !== null) channels.BOOKING = { commissionPct: bk, paymentFeePct: parseNum(a.bookingFeePct) ?? 0 };
  const hard = parseNum(a.hard), fixed = fixedMonthly(a), nights = parseNum(a.nightsMonth), goal = parseNum(a.goalMonth);
  const perNightFixed = fixed !== null && nights ? fixed / nights : null;
  // le plancher stratégique couvre les charges fixes ; il ne descend jamais sous le seuil de dérangement
  const strategy = perNightFixed === null ? null : Math.max(perNightFixed, hard ?? 0);
  const target = perNightFixed !== null && goal !== null && nights ? Math.max((fixed! + goal) / nights, strategy ?? 0) : null;
  const v = variablePerNight(a);
  return {
    channels, cleaningFeeChargedCents: cents(parseNum(a.cleaningFee)), cleaningCostCents: cents(parseNum(a.cleaningCost)),
    linenCostCents: a.linenMode === "included" ? 0 : cents(parseNum(a.linenCost)),
    nightlyVariableCostCents: v === null ? null : Math.round(v * 100),
    hardContributionPerNightCents: cents(hard), strategyContributionPerNightCents: strategy === null ? null : Math.round(strategy * 100), targetContributionPerNightCents: target === null ? null : Math.round(target * 100),
    origin: "DECLARED", touristTaxPct: touristTaxPct(a), provisional: (a.provisional ?? []).filter((k) => LABELS[k]).map((k) => LABELS[k]), answers: a,
  };
}

/** Reprise d'un dossier saisi avec l'ancien formulaire : on repart de ses valeurs, en saisie directe. */
export function answersFromModel(m: EconomicModel | null | undefined): CostAnswers {
  if (m?.answers && Object.keys(m.answers).length) return m.answers as CostAnswers;
  const e = (c: number | null | undefined) => (c === null || c === undefined ? "" : String(c / 100).replace(".", ","));
  const n = (x: number | null | undefined) => (x === null || x === undefined ? "" : String(x).replace(".", ","));
  const ch = (c: Channel) => m?.channels?.[c];
  return {
    airbnbPct: n(ch("AIRBNB")?.commissionPct), bookingPct: n(ch("BOOKING")?.commissionPct), bookingFeePct: ch("BOOKING") ? n(ch("BOOKING")!.paymentFeePct) : "",
    cleaningFee: e(m?.cleaningFeeChargedCents), cleaningCost: e(m?.cleaningCostCents), linenMode: m?.linenCostCents === 0 ? "included" : m?.linenCostCents ? "service" : "", linenCost: m?.linenCostCents ? e(m.linenCostCents) : "",
    nightMode: m?.nightlyVariableCostCents !== null && m?.nightlyVariableCostCents !== undefined ? "direct" : "calc", variableDirect: e(m?.nightlyVariableCostCents), hard: e(m?.hardContributionPerNightCents), provisional: [],
    taxMode: m?.touristTaxPct === 0 ? "none" : m?.touristTaxPct ? "direct" : "calc", taxPct: m?.touristTaxPct ? n(m.touristTaxPct) : "",
  };
}
