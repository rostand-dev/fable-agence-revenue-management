/**
 * Réconciliation à ±1 % (US-054, blueprint Gate A et §17.1). Compare, réservation par réservation, le revenu net d'hébergement que calcule
 * l'application (hébergement − commission − frais de paiement) à celui que donne la source (relevé du canal, SuperHote). Module pur.
 *
 * Règles : une valeur absente n'est jamais un zéro. Une commission inconnue côté application, ou un net absent côté source, rend la ligne
 * « inconnue » : elle ne compte ni comme conforme ni comme écart, et empêche d'attester l'échantillon. La comparaison se fait en centimes entiers
 * (|écart| × 100 ≤ tolérance × net de la source), sans flottant, donc un écart d'exactement 1 % est conforme et 1,01 % ne l'est pas.
 */
import { RECONCILIATION_MAX_GAP_PCT, RECONCILIATION_MIN_SAMPLE, type ReconciliationInput } from "../activation-gates";
import type { Snap } from "../reservations/nights";

export type SampleRow = { id: string; channel: string; app: Pick<Snap, "grossRoomCents" | "commissionCents" | "paymentFeeCents">; sourceNetRoomCents: number | null };
export type RowStatus = "OK" | "GAP" | "UNKNOWN";
export type RowGap = { id: string; channel: string; appNetCents: number | null; sourceNetCents: number | null; gapCents: number | null; /** Écart signé : positif si l'application dépasse la source */ signedGapCents: number | null; gapPct: number | null; status: RowStatus };
export type ReconStatus = "OK" | "GAP" | "TOO_SMALL" | "UNKNOWN";
export type Reconciliation = {
  status: ReconStatus; sampleSize: number; compared: number; unknown: number;
  /** Plus grand écart relatif d'une réservation, en % ; null sans ligne comparée. */
  maxGapPct: number | null;
  /** Vrai si un écart est non borné (net de la source nul, application non nul) : `maxGapPct` vaut alors null à la sérialisation JSON, ce qui ne veut PAS dire inconnu. */
  unbounded: boolean;
  /** Écart relatif entre la somme des nets de l'application et celle de la source, en %. */
  aggregateGapPct: number | null;
  rows: RowGap[];
};

/** Net d'hébergement d'une réservation côté application ; null si la commission est inconnue (frais de paiement absents = aucun frais, comme dans les KPI). */
export const appNetCents = (a: SampleRow["app"]): number | null => (a.commissionCents === null ? null : a.grossRoomCents - a.commissionCents - (a.paymentFeeCents ?? 0));

const aggregateUnbounded = (c: RowGap[]) => c.length > 0 && c.reduce((a, r) => a + r.sourceNetCents!, 0) === 0 && c.reduce((a, r) => a + r.appNetCents!, 0) !== 0;

export function reconcile(sample: SampleRow[], tolerancePct = RECONCILIATION_MAX_GAP_PCT, minSample = RECONCILIATION_MIN_SAMPLE): Reconciliation {
  // La comparaison reste exacte en centimes entiers tant que la tolérance est un pourcentage entier ; toute autre valeur est refusée plutôt que tolérée.
  if (!Number.isInteger(tolerancePct) || tolerancePct < 0) throw new Error("Tolérance : un pourcentage entier, 0 ou plus.");
  if (!Number.isInteger(minSample) || minSample < 1) throw new Error("Taille minimale de l'échantillon : un entier d'au moins 1.");
  const rows: RowGap[] = sample.map((r) => {
    const app = appNetCents(r.app), src = r.sourceNetRoomCents;
    if (app === null || src === null || !Number.isInteger(app) || !Number.isInteger(src)) return { id: r.id, channel: r.channel, appNetCents: app, sourceNetCents: src, gapCents: null, signedGapCents: null, gapPct: null, status: "UNKNOWN" as const };
    const gap = Math.abs(app - src);
    return { id: r.id, channel: r.channel, appNetCents: app, sourceNetCents: src, gapCents: gap, signedGapCents: app - src, gapPct: src === 0 ? (gap === 0 ? 0 : null) : (gap / Math.abs(src)) * 100, status: gap * 100 <= tolerancePct * Math.abs(src) ? ("OK" as const) : ("GAP" as const) };
  });
  const compared = rows.filter((r) => r.status !== "UNKNOWN");
  const unknown = rows.length - compared.length;
  const pcts = compared.map((r) => r.gapPct);
  // un écart sur un net de source nul est infini : il est conservé comme tel pour que le maximum ne l'oublie pas
  const maxGapPct = compared.length ? pcts.reduce<number>((m, p) => Math.max(m, p ?? Number.POSITIVE_INFINITY), 0) : null;
  const unbounded = maxGapPct === Number.POSITIVE_INFINITY || aggregateUnbounded(compared);
  const sApp = compared.reduce((a, r) => a + r.appNetCents!, 0), sSrc = compared.reduce((a, r) => a + r.sourceNetCents!, 0);
  const aggregateGapPct = compared.length ? (sSrc === 0 ? (sApp === 0 ? 0 : Number.POSITIVE_INFINITY) : (Math.abs(sApp - sSrc) / Math.abs(sSrc)) * 100) : null;
  const status: ReconStatus = compared.some((r) => r.status === "GAP") ? "GAP" : unknown > 0 ? "UNKNOWN" : compared.length < minSample ? "TOO_SMALL" : "OK";
  return { status, sampleSize: rows.length, compared: compared.length, unknown, maxGapPct, unbounded, aggregateGapPct, rows };
}

/**
 * Attestation prête à enregistrer (checklist de qualité, US-024) : taille de l'échantillon et plus grand écart, arrondi PAR EXCÈS au centième
 * (on ne déclare jamais un écart plus petit que le réel). null si l'échantillon ne peut pas être attesté (lignes inconnues, aucun écart chiffrable).
 */
export function toAttestation(r: Reconciliation, source: string, note: string | null = null): ReconciliationInput | null {
  if (r.unknown > 0 || r.compared === 0 || r.maxGapPct === null || !Number.isFinite(r.maxGapPct)) return null;
  return { sampleSize: r.compared, maxGapPct: Math.ceil(r.maxGapPct * 100 - 1e-9) / 100, source, note };
}
