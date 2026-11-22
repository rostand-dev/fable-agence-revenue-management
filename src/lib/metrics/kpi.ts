/**
 * KPI canoniques d'un logement (US-050, blueprint §8.2) : occupation, ADR, Net ADR, RevPAN et Net RevPAN.
 * Module pur (aucun accès base) : l'écran, l'API et les tests s'appuient sur la même arithmétique.
 *
 * Règles (blueprint §3, principes 5 et 7) :
 * - le calcul part des NUITS (une ligne par nuit vendue, voir `reservations/nights.ts`), jamais d'une moyenne par réservation ;
 * - les montants sont des centimes entiers, additionnés sans arrondi ; l'arrondi n'intervient qu'à la dernière division ;
 * - une donnée absente n'est jamais un zéro : une commission inconnue exclut la nuit du NET (elle reste dans le brut et dans l'occupation),
 *   et le statut du net le dit (`COMPLETE`, `PARTIAL`, `UNKNOWN`) ;
 * - le Net RevPAN n'est donné que si le net est connu pour TOUTES les nuits vendues : sinon il serait sous-évalué, donc trompeur ;
 * - les nuits bloquées par le propriétaire ne sont pas disponibles à la vente ; une nuit à la fois vendue et bloquée compte comme vendue ;
 * - la période est toujours explicite : nuits du `from` inclus au `to` exclu.
 *
 * Formules :
 *   Gross Room Revenue = hébergement après remise, hors ménage et taxes
 *   Net Room Revenue   = Gross Room Revenue − commissions − frais de paiement
 *   ADR                = Gross / nuits vendues          Net ADR    = Net / nuits vendues (connues)
 *   RevPAN             = Gross / nuits disponibles      Net RevPAN = Net / nuits disponibles
 */
import { addDays, daysInMonth, diffDays, type ISODate } from "../dates";
import { nightsOf, type Snap } from "../reservations/nights";

/** Plafond d'une période : une date aberrante ne doit pas faire boucler le calcul. */
export const MAX_PERIOD_DAYS = 800;

export type NightFact = { night: ISODate; channel: string; grossRoomCents: number; commissionCents: number | null; paymentFeeCents: number | null };
export type KpiPeriod = { from: ISODate; to: ISODate };
/** COMPLETE : net connu pour toutes les nuits vendues · PARTIAL : pour une partie · UNKNOWN : pour aucune · NONE : aucune nuit vendue (le net est alors un vrai zéro). */
export type NetStatus = "COMPLETE" | "PARTIAL" | "UNKNOWN" | "NONE";

export type ChannelKpi = { channel: string; soldNights: number; grossRoomCents: number; netRoomCents: number | null; netNights: number };
export type Kpi = {
  period: KpiPeriod; days: number;
  availableNights: number; blockedNights: number; soldNights: number;
  /** Nuits vendues deux fois (double réservation) : signalées, jamais corrigées en silence. */
  overlappingNights: number;
  occupancy: number | null;
  grossRoomCents: number; adrCents: number | null; grossRevpanCents: number | null;
  netStatus: NetStatus;
  /** Nuits vendues dont la commission est connue ; `netCoverage` = part de ces nuits parmi les nuits vendues (null sans nuit vendue). */
  netNights: number; netCoverage: number | null;
  /** Net des seules nuits dont la commission est connue (le net complet si COMPLETE) ; null si UNKNOWN. */
  netRoomCents: number | null;
  netAdrCents: number | null;
  /** null tant que le net n'est pas COMPLETE : un Net RevPAN partiel serait sous-évalué. */
  netRevpanCents: number | null;
  byChannel: ChannelKpi[];
};

const inRange = (d: ISODate, p: KpiPeriod) => d >= p.from && d < p.to;
const round = (n: number) => Math.round(n);

export function periodDays(p: KpiPeriod): number {
  const n = diffDays(p.to, p.from);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PERIOD_DAYS) throw new RangeError(`Période invalide : de ${p.from} (inclus) à ${p.to} (exclu), de 1 à ${MAX_PERIOD_DAYS} jours.`);
  return n;
}

/**
 * KPI d'une période. `sold` : nuits vendues (statut confirmé) ; `blocked` : dates bloquées par le propriétaire. Les nuits hors période sont ignorées.
 */
export function computeKpi(period: KpiPeriod, sold: NightFact[], blocked: ISODate[] = []): Kpi {
  const days = periodDays(period);
  const nights = sold.filter((n) => inRange(n.night, period));
  const soldDates = new Set(nights.map((n) => n.night));
  const blockedOnly = new Set(blocked.filter((d) => inRange(d, period) && !soldDates.has(d)));
  const available = days - blockedOnly.size;

  let gross = 0, net = 0, netNights = 0;
  const ch = new Map<string, { sold: number; gross: number; net: number; netNights: number }>();
  for (const n of nights) {
    const c = ch.get(n.channel) ?? { sold: 0, gross: 0, net: 0, netNights: 0 };
    c.sold += 1; c.gross += n.grossRoomCents; gross += n.grossRoomCents;
    if (n.commissionCents !== null) { // frais de paiement absents : aucun frais (Airbnb n'en a pas) ; seule la commission décide si le net est connu
      const v = n.grossRoomCents - n.commissionCents - (n.paymentFeeCents ?? 0);
      c.net += v; c.netNights += 1; net += v; netNights += 1;
    }
    ch.set(n.channel, c);
  }
  const soldNights = nights.length;
  const netStatus: NetStatus = soldNights === 0 ? "NONE" : netNights === soldNights ? "COMPLETE" : netNights === 0 ? "UNKNOWN" : "PARTIAL";
  const netRoom = netStatus === "NONE" ? 0 : netStatus === "UNKNOWN" ? null : net;
  const complete = netStatus === "COMPLETE" || netStatus === "NONE";
  return {
    period: { ...period }, days, availableNights: available, blockedNights: blockedOnly.size, soldNights, overlappingNights: soldNights - soldDates.size,
    occupancy: available > 0 ? soldDates.size / available : null,
    grossRoomCents: gross, adrCents: soldNights ? round(gross / soldNights) : null, grossRevpanCents: available > 0 ? round(gross / available) : null,
    netStatus, netNights, netCoverage: soldNights ? netNights / soldNights : null, netRoomCents: netRoom,
    netAdrCents: netNights ? round(net / netNights) : null,
    netRevpanCents: complete && available > 0 && netRoom !== null ? round(netRoom / available) : null,
    byChannel: [...ch.entries()].sort((a, b) => b[1].gross - a[1].gross || a[0].localeCompare(b[0])).map(([channel, c]) => ({ channel, soldNights: c.sold, grossRoomCents: c.gross, netRoomCents: c.netNights === 0 ? null : c.net, netNights: c.netNights })),
  };
}

/** Mois civil « AAAA-MM » → période (premier jour inclus, premier du mois suivant exclu). */
export function monthPeriod(month: string): KpiPeriod {
  const from = `${month}-01`;
  return { from, to: addDays(from, daysInMonth(month)) };
}

/** Un KPI par mois civil : chaque nuit appartient à son mois de séjour. */
export function kpiByMonth(months: string[], sold: NightFact[], blocked: ISODate[] = []): Kpi[] {
  return months.map((m) => computeKpi(monthPeriod(m), sold, blocked));
}

/** Réservations (niveau réservation) → nuits vendues et dates bloquées, avec la même répartition en centimes que la base (`nightsOf`). Annulées et doublons : aucune nuit. */
export function nightFactsFromResas(resas: { status: string; channel: string; checkIn: ISODate; checkOut: ISODate; grossRoomCents: number; commissionCents: number | null; paymentFeeCents: number | null }[]): { sold: NightFact[]; blocked: ISODate[] } {
  const sold: NightFact[] = [], blocked: ISODate[] = [];
  for (const r of resas) {
    const snap: Snap = { status: r.status as Snap["status"], channel: r.channel, checkIn: r.checkIn, checkOut: r.checkOut, grossRoomCents: r.grossRoomCents, cleaningCents: null, commissionCents: r.commissionCents, paymentFeeCents: r.paymentFeeCents };
    for (const n of nightsOf(snap)) {
      if (n.status === "BLOCKED") blocked.push(n.night);
      else sold.push({ night: n.night, channel: n.channel, grossRoomCents: n.grossRoomCents, commissionCents: n.commissionCents, paymentFeeCents: n.paymentFeeCents });
    }
  }
  return { sold, blocked };
}

/** Libellé court et clair du statut du net, pour l'écran et l'API. */
export const NET_STATUS_LABEL: Record<NetStatus, string> = {
  COMPLETE: "Net connu pour toutes les nuits vendues",
  PARTIAL: "Net connu pour une partie des nuits vendues",
  UNKNOWN: "Net inconnu : aucune commission renseignée sur les nuits vendues",
  NONE: "Aucune nuit vendue sur la période",
};
