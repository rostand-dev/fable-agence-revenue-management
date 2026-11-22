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
  // saisons (US-052) : une ligne par saison ajoutée, retirée ou modifiée
  const ps = new Map((prev?.seasons ?? []).map((x) => [x.id, x])), ns = new Map((next.seasons ?? []).map((x) => [x.id, x]));
  const seasonText = (x?: { label: string; from: string; to: string; strategyContributionPerNightCents: number }) => (x ? `« ${x.label} » ${x.from} → ${x.to} : ${fmtEuro(x.strategyContributionPerNightCents)} par nuit` : null);
  for (const id of new Set([...ps.keys(), ...ns.keys()])) push(`seasons.${id}`, `Saison « ${(ns.get(id) ?? ps.get(id))!.label} »`, seasonText(ps.get(id)), seasonText(ns.get(id)));
  push("touristTaxPct", "Taxe de séjour dans les montants", fmtPct(prev?.touristTaxPct), fmtPct(next.touristTaxPct));
  // l'origine ne se compare que si on la connaissait : jamais d'« avant » inventé
  if (prev?.origin && prev.origin !== next.origin) push("origin", "Origine des valeurs", prev.origin === "DEMO" ? "démonstration" : "déclarées", next.origin === "DEMO" ? "démonstration" : "déclarées");
  return out;
}

/** Version enregistrée sans les réponses brutes du parcours (inutiles à l'historique, et volumineuses). */
export const versionModel = (m: EconomicModel): Omit<EconomicModel, "answers"> => { const { answers: _a, ...rest } = m; return rest; };
export const showValue = (v: string | null) => v ?? "inconnue";
