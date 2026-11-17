import { addDays, type ISODate } from "../dates";
import { leadTimes } from "./metrics";
import type { Day, Resa } from "./types";

/**
 * Rythme de suivi d'un logement : à quelle fréquence relire ses données et le repasser en revue.
 * Calcul déterministe et transparent — chaque point du score correspond à une raison affichée au propriétaire.
 * Le rythme règle seulement la fréquence des passages ; il ne décide d'aucune action.
 */
export type CadenceLevel = "SOUTENU" | "ACTIF" | "REGULIER" | "CALME";

export const CADENCE_LABEL: Record<CadenceLevel, string> = { SOUTENU: "Suivi soutenu", ACTIF: "Suivi actif", REGULIER: "Suivi régulier", CALME: "Suivi allégé" };

/** Paliers en heures : réservations et disponibilités (SuperHote), prix et marché (PriceLabs), revue par les agents. */
export const CADENCE_HOURS: Record<CadenceLevel, { reservations: number; prices: number; review: number }> = {
  SOUTENU: { reservations: 1, prices: 12, review: 6 },
  ACTIF: { reservations: 2, prices: 12, review: 12 },
  REGULIER: { reservations: 4, prices: 24, review: 24 },
  CALME: { reservations: 6, prices: 24, review: 48 },
};
/** Sans SuperHote, les réservations ne viennent que de PriceLabs : sa lecture complète ne descend pas sous ce délai. */
export const PRICELABS_ONLY_MIN_HOURS = 3;
/** Tant que PriceLabs n'a pas refait son calcul nocturne, sa grille est relue à ce rythme pour le capter au plus tôt. */
export const AWAITING_GRID_HOURS = 3;

export type CadenceInput = {
  today: ISODate;
  days: Day[];
  resas: Resa[];
  /** Actions en cours d'observation et dossiers différés : ils imposent au moins une revue par jour. */
  followUps: number;
  /** Variation de l'occupation moyenne du marché (J+0 à J+30) depuis le relevé de référence, en points. null = inconnue. */
  marketDeltaPts: number | null;
  isDemo?: boolean;
  hasSuperhote?: boolean;
};

export type CadenceSignals = { freeNear: number; pickup7: number; pickup14: number; leadMedian: number | null; marketDeltaPts: number | null; eventNights: number; followUps: number };

export type Cadence = {
  level: CadenceLevel;
  score: number;
  /** Raisons en clair, de la plus lourde à la plus légère. */
  reasons: string[];
  reservationsEveryH: number;
  pricesEveryH: number;
  reviewEveryH: number;
  signals: CadenceSignals;
};

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

export function levelFor(score: number): CadenceLevel {
  return score >= 8 ? "SOUTENU" : score >= 5 ? "ACTIF" : score >= 2 ? "REGULIER" : "CALME";
}

/** Occupation moyenne du marché sur J+0 à J+30 (0 à 1). null si le marché n'est pas lu. */
export function marketOccupancy30(days: Day[], today: ISODate): number | null {
  const to = addDays(today, 30);
  const xs = days.filter((d) => d.date >= today && d.date <= to).map((d) => d.marketOccupancy).filter((x): x is number => x !== null);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function computeCadence(i: CadenceInput): Cadence {
  const none: CadenceSignals = { freeNear: 0, pickup7: 0, pickup14: 0, leadMedian: null, marketDeltaPts: null, eventNights: 0, followUps: i.followUps };
  const fixed = (reason: string): Cadence => ({ level: "REGULIER", score: 0, reasons: [reason], reservationsEveryH: CADENCE_HOURS.REGULIER.reservations, pricesEveryH: CADENCE_HOURS.REGULIER.prices, reviewEveryH: 24, signals: none });
  if (i.isDemo) return fixed("Logement de démonstration : une revue par jour");
  if (i.days.length === 0) return fixed("Calendrier pas encore lu : rythme quotidien par défaut");

  const near = addDays(i.today, 13), month = addDays(i.today, 30);
  const freeNear = i.days.filter((d) => d.state === "FREE" && d.date >= i.today && d.date <= near).length;
  const confirmed = i.resas.filter((r) => r.status === "CONFIRMED");
  const since = (n: number) => confirmed.filter((r) => r.bookedAt > addDays(i.today, -n) && r.bookedAt <= i.today).length;
  const pickup7 = since(7), pickup14 = since(14);
  const lead = leadTimes(i.resas)?.median ?? null;
  const eventNights = i.days.filter((d) => d.state === "FREE" && d.event && d.date >= i.today && d.date <= month).length;
  const delta = i.marketDeltaPts;

  const parts: { pts: number; reason: string }[] = [];
  const add = (pts: number, reason: string) => { if (pts > 0) parts.push({ pts, reason }); };
  add(freeNear >= 5 ? 3 : freeNear >= 2 ? 2 : freeNear === 1 ? 1 : 0, `${plural(freeNear, "nuit libre", "nuits libres")} dans les 14 prochains jours`);
  add(pickup7 >= 3 ? 3 : pickup7 >= 1 ? 2 : pickup14 >= 1 ? 1 : 0, pickup7 >= 1 ? `${plural(pickup7, "réservation reçue", "réservations reçues")} en 7 jours` : `${plural(pickup14, "réservation reçue", "réservations reçues")} en 14 jours`);
  add(lead === null ? 0 : lead <= 7 ? 2 : lead <= 21 ? 1 : 0, `réservations prises tard (délai médian ${lead} j)`);
  add(delta === null ? 0 : Math.abs(delta) >= 5 ? 2 : Math.abs(delta) >= 2 ? 1 : 0, `occupation du marché en ${delta !== null && delta < 0 ? "baisse" : "hausse"} de ${Math.abs(Math.round(delta ?? 0))} points`);
  add(eventNights > 0 ? 1 : 0, `événement à venir sur ${plural(eventNights, "nuit libre", "nuits libres")}`);
  add(i.followUps > 0 ? 2 : 0, `${plural(i.followUps, "action ou dossier", "actions ou dossiers")} en cours de suivi`);

  const score = parts.reduce((a, p) => a + p.pts, 0);
  const level = levelFor(score);
  const h = CADENCE_HOURS[level];
  const reasons = parts.sort((a, b) => b.pts - a.pts).map((p) => p.reason);
  if (level === "CALME") {
    if (freeNear === 0) reasons.push("aucune nuit libre dans les 14 prochains jours");
    if (pickup14 === 0) reasons.push("aucune réservation reçue en 14 jours");
  }
  return {
    level, score, reasons,
    reservationsEveryH: i.hasSuperhote === false ? Math.max(PRICELABS_ONLY_MIN_HOURS, h.reservations) : h.reservations,
    pricesEveryH: h.prices,
    // une action en observation ou un dossier différé ne doit pas attendre deux jours
    reviewEveryH: i.followUps > 0 ? Math.min(h.review, 24) : h.review,
    signals: { freeNear, pickup7, pickup14, leadMedian: lead, marketDeltaPts: delta, eventNights, followUps: i.followUps },
  };
}

export type MarketRef = { value: number; at: string; deltaPts: number | null };

/**
 * Relevé de référence de l'occupation du marché : comparé au relevé courant au plus une fois par 24 h,
 * pour mesurer une variation réelle plutôt que le bruit d'une lecture à l'autre.
 */
export function rollMarketRef(prev: MarketRef | null | undefined, current: number | null, now: Date): MarketRef | null {
  if (current === null) return prev ?? null;
  if (!prev) return { value: current, at: now.toISOString(), deltaPts: null };
  if (+now - +new Date(prev.at) < 24 * 3600000) return prev;
  return { value: current, at: now.toISOString(), deltaPts: Math.round((current - prev.value) * 1000) / 10 };
}

/** Délai avant nouvelle tentative après des lectures en échec : 15 min, 30 min, 1 h, 2 h… plafonné à 6 h. */
export function backoffMinutes(failures: number): number {
  return Math.min(360, 15 * 2 ** Math.max(0, failures - 1));
}

/** La grille PriceLabs lue date-t-elle d'avant son calcul nocturne (entre 20 h et 48 h) ? Alors une lecture rapprochée est utile. */
export function awaitingGrid(gridRefreshedAt: string | null | undefined, readAt: string | null | undefined): boolean {
  if (!gridRefreshedAt || !readAt) return false;
  const g = +new Date(gridRefreshedAt), r = +new Date(readAt);
  if (!Number.isFinite(g) || !Number.isFinite(r)) return false;
  const ageH = (r - g) / 3600000;
  return ageH >= 20 && ageH <= 48;
}

/** « toutes les heures », « toutes les 6 h », « une fois par jour », « tous les 2 jours ». */
export function everyLabel(hours: number): string {
  if (hours === 1) return "toutes les heures";
  if (hours === 24) return "une fois par jour";
  if (hours > 24 && hours % 24 === 0) return `tous les ${hours / 24} jours`;
  return `toutes les ${hours} h`;
}

/** Réservations confirmées apparues ou disparues entre deux lectures (identifiants externes). */
export function reservationChanges(before: Set<string>, after: Set<string>): { added: number; cancelled: number } {
  let added = 0, cancelled = 0;
  for (const id of after) if (!before.has(id)) added++;
  for (const id of before) if (!after.has(id)) cancelled++;
  return { added, cancelled };
}
