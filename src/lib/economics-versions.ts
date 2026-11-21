/**
 * Versions du modèle économique (US-022) : comparaison de deux modèles, en phrases lisibles.
 * Fonctions pures. Une valeur inconnue (null) se lit « inconnue », jamais « 0 ».
 */
import { CHANNEL_LABEL, type Channel, type EconomicModel } from "./engine/types";

export type EconomicChange = { key: string; label: string; from: string | null; to: string | null };
const fmtEuro = (c: number | null | undefined) => (c == null ? null : `${(c / 100).toFixed(2).replace(".", ",")} €`);
const fmtPct = (n: number | null | undefined) => (n == null ? null : `${String(n).replace(".", ",")} %`);

const MONEY: [keyof EconomicModel, string][] = [
  ["cleaningFeeChargedCents", "Frais de ménage facturés"], ["cleaningCostCents", "Coût du ménage"], ["linenCostCents", "Coût du linge"],
  ["nightlyVariableCostCents", "Coûts variables par nuit"], ["hardContributionPerNightCents", "Seuil de dérangement (par nuit)"],
  ["strategyContributionPerNightCents", "Couverture des charges fixes (par nuit)"], ["targetContributionPerNightCents", "Contribution visée (par nuit)"],
];

/** Ce qui change entre deux modèles. `prev` null = première version : tout ce qui est renseigné est listé. */
export function diffEconomics(prev: EconomicModel | null | undefined, next: EconomicModel): EconomicChange[] {
  const out: EconomicChange[] = [];
  const push = (key: string, label: string, a: string | null, b: string | null) => { if (a !== b) out.push({ key, label, from: a, to: b }); };
  for (const c of Object.keys({ ...(prev?.channels ?? {}), ...(next.channels ?? {}) }) as Channel[]) {
    const a = prev?.channels?.[c], b = next.channels?.[c];
    push(`channels.${c}.commissionPct`, `Commission ${CHANNEL_LABEL[c]}`, fmtPct(a?.commissionPct), fmtPct(b?.commissionPct));
    push(`channels.${c}.paymentFeePct`, `Frais de paiement ${CHANNEL_LABEL[c]}`, fmtPct(a?.paymentFeePct), fmtPct(b?.paymentFeePct));
  }
  for (const [k, label] of MONEY) push(k, label, fmtEuro(prev?.[k] as number | null | undefined), fmtEuro(next[k] as number | null | undefined));
  push("touristTaxPct", "Taxe de séjour dans les montants", fmtPct(prev?.touristTaxPct), fmtPct(next.touristTaxPct));
  push("origin", "Origine des valeurs", prev?.origin === "DEMO" ? "démonstration" : prev ? "déclarées" : null, next.origin === "DEMO" ? "démonstration" : "déclarées");
  return out;
}

/** Version enregistrée sans les réponses brutes du parcours (inutiles à l'historique, et volumineuses). */
export const versionModel = (m: EconomicModel): Omit<EconomicModel, "answers"> => { const { answers: _a, ...rest } = m; return rest; };
export const showValue = (v: string | null) => v ?? "inconnue";
