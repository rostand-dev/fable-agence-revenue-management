/**
 * Affichage d'une mesure de signal (US-060) : « observé » face à « seuil », avec l'unité en toutes lettres. Module pur, partagé par le dossier
 * d'opportunité et par la page « Méthode » (seuils du catalogue).
 */
import { euro, pct } from "../format";
import type { SignalMeasure } from "./types";

const OP: Record<NonNullable<SignalMeasure["op"]>, string> = { "<=": "≤", ">=": "≥", "<": "<", ">": ">" };
const frNum = (x: number) => String(Math.round(x * 100) / 100).replace(".", ",");

/** Valeur lisible selon son unité. `null` = inconnue : jamais « 0 ». */
export function formatValue(v: number | string | null, unit: string): string {
  if (v === null) return "inconnu";
  if (typeof v === "string") return v;
  switch (unit) {
    case "cents": return euro(v);
    case "ratio": return pct(v);
    case "points": return `${v < 0 ? "−" : v > 0 ? "+" : ""}${frNum(Math.abs(v) * 100)} pts`;
    case "%": return `${frNum(v)} %`;
    case "percentile": return `${Math.round(v)}e percentile`;
    case "nuits": return `${v} nuit${Math.abs(v) > 1 ? "s" : ""}`;
    case "jours": return `${v} jour${Math.abs(v) > 1 ? "s" : ""}`;
    case "séjours": return `${v} séjour${Math.abs(v) > 1 ? "s" : ""}`;
    default: return frNum(v);
  }
}
export function formatMeasure(m: SignalMeasure): { label: string; observed: string; threshold: string | null } {
  return {
    label: m.label,
    observed: formatValue(m.measured, m.unit),
    threshold: m.threshold === null || m.op === null ? null : `${OP[m.op]} ${formatValue(m.threshold, m.unit)}`,
  };
}
