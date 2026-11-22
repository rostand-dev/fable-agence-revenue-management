import { addDays, diffDays, type ISODate } from "../dates";
import { floorGrossNightlyCents, floorGrid } from "./economics";
import type { Channel, EconomicModel, Season } from "./types";

/**
 * Saisons du modèle économique (US-052). Une saison fait varier la couverture des charges fixes (plancher stratégique) ;
 * le plancher absolu (seuil de dérangement) reste constant toute l'année. Les dates hors saison utilisent la valeur de base du modèle.
 * Fonctions pures : aucune lecture de la base ni de l'horloge.
 */
export const MAX_SEASONS = 8;
const MMDD = /^(\d{2})-(\d{2})$/;
/** Jours par mois d'une année bissextile : « 02-29 » est une date valide, et une saison à cheval sur le 29 février reste cohérente. */
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export const isMonthDay = (s: unknown): s is string => {
  if (typeof s !== "string") return false;
  const m = MMDD.exec(s);
  if (!m) return false;
  const mo = Number(m[1]), d = Number(m[2]);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= DAYS_IN_MONTH[mo - 1];
};

/** Rang du jour dans une année bissextile (1 à 366). */
function dayRank(md: string): number {
  const [mo, d] = md.split("-").map(Number);
  let r = d;
  for (let i = 0; i < mo - 1; i++) r += DAYS_IN_MONTH[i];
  return r;
}

/** Jours de l'année couverts par une saison (bornes incluses ; `to` avant `from` = saison à cheval sur le nouvel an). */
function coveredDays(s: Pick<Season, "from" | "to">): number[] {
  const a = dayRank(s.from), b = dayRank(s.to);
  const out: number[] = [];
  if (a <= b) for (let i = a; i <= b; i++) out.push(i);
  else { for (let i = a; i <= 366; i++) out.push(i); for (let i = 1; i <= b; i++) out.push(i); }
  return out;
}

export type SeasonsParse = { ok: true; seasons: Season[] } | { ok: false; error: string };

/**
 * Valide une liste de saisons saisie par le propriétaire. Refuse plutôt que de corriger : libellé, dates MM-JJ, montant entier en centimes,
 * pas de chevauchement, pas plus de MAX_SEASONS, et un plancher stratégique jamais sous le seuil de dérangement du modèle (s'il est connu).
 */
export function parseSeasons(raw: unknown, model?: Pick<EconomicModel, "hardContributionPerNightCents">): SeasonsParse {
  if (raw === undefined || raw === null) return { ok: true, seasons: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "Les saisons doivent être une liste." };
  if (raw.length > MAX_SEASONS) return { ok: false, error: `Au plus ${MAX_SEASONS} saisons.` };
  const out: Season[] = [];
  const seen = new Map<number, string>();
  const ids = new Set<string>();
  // identifiants : ceux déjà donnés sont gardés tels quels ; une saison sans identifiant reçoit le premier « sN » libre (jamais d'après sa position)
  const given = raw.map((r) => { const id = (r as Record<string, unknown> | null)?.id; return typeof id === "string" && /^[a-z0-9_-]{1,40}$/i.test(id) ? id : null; });
  const taken = new Set(given.filter((x): x is string => !!x));
  let nextN = 1;
  const freeId = () => { while (taken.has(`s${nextN}`)) nextN++; const id = `s${nextN}`; taken.add(id); return id; };
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] as Record<string, unknown> | null;
    const n = i + 1;
    if (!r || typeof r !== "object") return { ok: false, error: `Saison ${n} : valeur invalide.` };
    const label = typeof r.label === "string" ? r.label.trim() : "";
    if (label.length < 2 || label.length > 40) return { ok: false, error: `Saison ${n} : un nom de 2 à 40 caractères.` };
    if (!isMonthDay(r.from) || !isMonthDay(r.to)) return { ok: false, error: `Saison « ${label} » : dates au format MM-JJ (par exemple 07-01).` };
    const c = r.strategyContributionPerNightCents;
    if (typeof c !== "number" || !Number.isInteger(c) || c < 0 || c > 10_000_000) return { ok: false, error: `Saison « ${label} » : la couverture des charges fixes par nuit est un montant en centimes, entier et positif.` };
    const hard = model?.hardContributionPerNightCents;
    if (typeof hard === "number" && c < hard) return { ok: false, error: `Saison « ${label} » : la couverture des charges fixes ne peut pas être sous le seuil de dérangement du logement.` };
    const id = given[i] ?? freeId();
    if (ids.has(id)) return { ok: false, error: `Saison « ${label} » : identifiant en double.` };
    ids.add(id);
    const s: Season = { id, label, from: r.from, to: r.to, strategyContributionPerNightCents: c };
    for (const d of coveredDays(s)) {
      const other = seen.get(d);
      if (other) return { ok: false, error: `Les saisons « ${other} » et « ${label} » se chevauchent.` };
      seen.set(d, label);
    }
    out.push(s);
  }
  return { ok: true, seasons: out };
}

/** Saison en vigueur à une date de séjour (aucune si la date est hors saison). */
export function seasonOn(m: Pick<EconomicModel, "seasons">, date: ISODate): Season | null {
  const seasons = m.seasons ?? [];
  if (!seasons.length) return null;
  const md = String(date).slice(5, 10);
  if (!isMonthDay(md)) return null;
  const r = dayRank(md);
  return seasons.find((s) => { const a = dayRank(s.from), b = dayRank(s.to); return a <= b ? r >= a && r <= b : r >= a || r <= b; }) ?? null;
}

/** Contribution de sécurité par nuit applicable à une date : celle de la saison, sinon la valeur de base. */
export function strategyContributionOn(m: EconomicModel, date: ISODate): number | null {
  return seasonOn(m, date)?.strategyContributionPerNightCents ?? m.strategyContributionPerNightCents;
}

/**
 * Plancher stratégique brut pour un séjour de `nights` nuits qui commence à `from`, ou pour des nuits visées [from, to[ : le plus exigeant
 * des planchers des saisons que ces nuits traversent (prudence : un séjour à cheval sur deux saisons n'est jamais jugé sur la plus clémente).
 * `season` est la saison qui fixe ce plancher (null : la valeur de base). Sans saison, c'est exactement le plancher de base.
 * Une fenêtre est bornée à 400 nuits ; au-delà, une erreur plutôt qu'un plancher sous-estimé.
 */
export function strategyFloorWindow(m: EconomicModel, channel: Channel, nights: number, from: ISODate, to?: ISODate): { floor: number; season: Season | null } {
  if (!(m.seasons ?? []).length) return { floor: floorGrossNightlyCents(m, channel, nights, m.strategyContributionPerNightCents!), season: null };
  const count = Math.max(1, to && to > from ? diffDays(to, from) : nights);
  if (count > 400) throw new Error("Fenêtre de plus de 400 nuits : les saisons ne peuvent pas être évaluées.");
  let best = { floor: -1, season: null as Season | null };
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    const s = seasonOn(m, addDays(from, i));
    const key = s?.id ?? "";
    if (seen.has(key)) continue;
    seen.add(key);
    const floor = floorGrossNightlyCents(m, channel, nights, s?.strategyContributionPerNightCents ?? m.strategyContributionPerNightCents!);
    if (floor > best.floor) best = { floor, season: s };
  }
  return best;
}
export const strategyFloorOver = (m: EconomicModel, channel: Channel, nights: number, from: ISODate, to?: ISODate): number => strategyFloorWindow(m, channel, nights, from, to).floor;

/** Plancher stratégique brut par nuit à une date de séjour. Lève UnknownEconomics si le modèle est incomplet. */
export function strategyFloorOn(m: EconomicModel, channel: Channel, nights: number, date: ISODate): number {
  return floorGrossNightlyCents(m, channel, nights, strategyContributionOn(m, date)!);
}

export type SeasonalFloorRow = {
  channel: Channel; nights: number; hardCents: number; strategyCents: number;
  seasons: { seasonId: string; label: string; strategyCents: number }[];
};

/** Grille canal × durée × saison : le plancher absolu est unique par ligne, le plancher stratégique est donné pour la base et pour chaque saison. */
export function seasonalFloorGrid(m: EconomicModel, los: number[] = [2, 7, 28]): SeasonalFloorRow[] {
  const seasons = m.seasons ?? [];
  return floorGrid(m, los).map((g) => ({
    ...g,
    seasons: seasons.map((s) => ({ seasonId: s.id, label: s.label, strategyCents: floorGrossNightlyCents(m, g.channel, g.nights, s.strategyContributionPerNightCents) })),
  }));
}
