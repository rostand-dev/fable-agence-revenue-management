import { addDays, diffDays, type ISODate } from "../dates";
import { kpiByMonth, nightFactsFromResas, type NetStatus } from "../metrics/kpi";
import type { Day, Resa } from "./types";

export const WINDOWS: { key: string; label: string; from: number; to: number }[] = [
  { key: "D0_7", label: "J+0 à J+7", from: 0, to: 7 },
  { key: "D8_14", label: "J+8 à J+14", from: 8, to: 14 },
  { key: "D15_30", label: "J+15 à J+30", from: 15, to: 30 },
  { key: "D31_60", label: "J+31 à J+60", from: 31, to: 60 },
  { key: "D61_90", label: "J+61 à J+90", from: 61, to: 90 },
];

export type WindowStat = {
  key: string; label: string; from: ISODate; to: ISODate; startOffset: number;
  available: number; booked: number; free: number;
  occupancy: number | null; marketOccupancy: number | null; gap: number | null;
  avgFreePriceCents: number | null; avgPercentile: number | null; freeDates: ISODate[];
};
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Occupation, écart au marché et position de prix par fenêtre canonique. Une donnée absente reste inconnue. */
export function windowStats(days: Day[], today: ISODate): WindowStat[] {
  return WINDOWS.map((w) => {
    const from = addDays(today, w.from), to = addDays(today, w.to + 1);
    const ds = days.filter((d) => d.date >= from && d.date < to);
    const avail = ds.filter((d) => d.state !== "BLOCKED");
    const booked = avail.filter((d) => d.state === "BOOKED");
    const free = avail.filter((d) => d.state === "FREE");
    const occ = avail.length ? booked.length / avail.length : null;
    const mo = avg(avail.map((d) => d.marketOccupancy).filter((x): x is number => x !== null));
    const prices = free.map((d) => d.priceCents).filter((x): x is number => x !== null);
    const pcts = free.map((d) => d.pricePercentile).filter((x): x is number => x !== null);
    const ap = avg(prices), apc = avg(pcts);
    return {
      key: w.key, label: w.label, from, to, startOffset: w.from, available: avail.length, booked: booked.length, free: free.length,
      occupancy: occ, marketOccupancy: mo, gap: occ !== null && mo !== null ? occ - mo : null,
      avgFreePriceCents: ap === null ? null : Math.round(ap), avgPercentile: apc === null ? null : Math.round(apc),
      freeDates: free.map((d) => d.date),
    };
  });
}

export type MonthKpi = {
  month: string; nights: number; available: number; blockedNights: number; occupancy: number; grossCents: number;
  /** Net des seules nuits dont la commission est connue (US-050) : partiel si `netIncomplete`. */
  netCents: number;
  adrCents: number | null; netAdrCents: number | null;
  /** Net connu ÷ nuits disponibles : sous-évalué si `netIncomplete` (le KPI canonique `computeKpi` renvoie alors null). */
  netRevpanCents: number; byChannel: Record<string, number>;
  /** true si une commission est inconnue sur au moins une nuit vendue : le net est alors partiel, jamais complété par un zéro */
  netIncomplete: boolean;
  /** Statut du net (voir metrics/kpi.ts) : UNKNOWN = aucune commission connue, `netCents` vaut alors 0 par défaut de valeur et ne doit PAS être affiché comme un montant. */
  netStatus: NetStatus;
};

/**
 * KPI mensuels : chaque nuit est attribuée à son mois de séjour. Net = brut − commissions − frais de paiement.
 * Vue historique de `metrics/kpi.ts` (US-050) : même arithmétique, formes inchangées pour les écrans existants.
 * Changement de fond : une commission inconnue n'est plus comptée comme nulle (ce qui surévaluait le net) ; la nuit sort du net et le mois est signalé `netIncomplete`.
 */
export function monthlyKpis(resas: Resa[], months: string[]): MonthKpi[] {
  const { sold, blocked } = nightFactsFromResas(resas);
  return kpiByMonth(months, sold, blocked).map((k, i) => ({
    month: months[i], nights: k.soldNights, available: k.availableNights, blockedNights: k.blockedNights, occupancy: k.occupancy ?? 0,
    grossCents: k.grossRoomCents, netCents: k.netRoomCents ?? 0, adrCents: k.adrCents, netAdrCents: k.netAdrCents,
    netRevpanCents: k.availableNights > 0 ? Math.round((k.netRoomCents ?? 0) / k.availableNights) : 0,
    byChannel: Object.fromEntries(k.byChannel.filter((c) => c.netRoomCents !== null).map((c) => [c.channel, c.netRoomCents as number])),
    netIncomplete: k.netStatus === "PARTIAL" || k.netStatus === "UNKNOWN", netStatus: k.netStatus,
  }));
}

export function lastMonths(today: ISODate, n: number, includeCurrent = false): string[] {
  const out: string[] = [];
  let [y, m] = today.slice(0, 7).split("-").map(Number);
  if (!includeCurrent) { m -= 1; if (m === 0) { m = 12; y -= 1; } }
  for (let i = 0; i < n; i++) { out.unshift(`${y}-${String(m).padStart(2, "0")}`); m -= 1; if (m === 0) { m = 12; y -= 1; } }
  return out;
}

/** Délai de réservation (jours entre réservation et arrivée) : médiane et 75e centile. null si historique insuffisant. */
export function leadTimes(resas: Resa[]): { median: number; p75: number; sample: number } | null {
  const xs = resas.filter((r) => r.status === "CONFIRMED").map((r) => diffDays(r.checkIn, r.bookedAt)).filter((x) => x >= 0).sort((a, b) => a - b);
  if (xs.length < 8) return null;
  return { median: xs[Math.floor(xs.length / 2)], p75: xs[Math.floor(xs.length * 0.75)], sample: xs.length };
}
export function medianLos(resas: Resa[]): number | null {
  const xs = resas.filter((r) => r.status === "CONFIRMED").map((r) => r.nights).sort((a, b) => a - b);
  return xs.length < 8 ? null : xs[Math.floor(xs.length / 2)];
}
export function channelShare(resas: Resa[]): Record<string, number> {
  const tot: Record<string, number> = {}; let sum = 0;
  for (const r of resas) if (r.status === "CONFIRMED") { tot[r.channel] = (tot[r.channel] ?? 0) + r.nights; sum += r.nights; }
  for (const k of Object.keys(tot)) tot[k] = tot[k] / (sum || 1);
  return tot;
}
