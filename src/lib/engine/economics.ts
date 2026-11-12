import type { Channel, EconomicModel, StackResult, WaterfallStep } from "./types";
import { CHANNEL_LABEL } from "./types";

export class UnknownEconomics extends Error {
  constructor(public fields: string[]) { super("Données économiques inconnues : " + fields.join(", ")); }
}

/** Champs bloquants : sans eux, aucun plancher n'est calculable. */
export function missingEconomics(m: EconomicModel, channel?: Channel): string[] {
  const miss: string[] = [];
  const need: [keyof EconomicModel, string][] = [
    ["cleaningFeeChargedCents", "frais de ménage facturés"], ["cleaningCostCents", "coût du ménage"],
    ["linenCostCents", "coût du linge"], ["nightlyVariableCostCents", "coûts variables par nuit"],
    ["hardContributionPerNightCents", "seuil de dérangement"],
    ["strategyContributionPerNightCents", "couverture des charges fixes"],
  ];
  for (const [k, label] of need) if (m[k] === null || m[k] === undefined) miss.push(label);
  const chans = channel ? [channel] : (Object.keys(m.channels ?? {}) as Channel[]);
  if (chans.length === 0) miss.push("commission par canal");
  for (const c of chans) if (!m.channels?.[c]) miss.push("commission " + CHANNEL_LABEL[c]);
  return miss;
}

function rate(m: EconomicModel, channel: Channel): number {
  const c = m.channels[channel];
  if (!c) throw new UnknownEconomics(["commission " + CHANNEL_LABEL[channel]]);
  return 1 - (c.commissionPct + c.paymentFeePct) / 100;
}

/**
 * Coût de séjour non récupéré : ménage + linge, moins les frais de ménage facturés
 * nets de commission. Peut être négatif (le ménage dégage alors une marge).
 */
export function unrecoveredStayCostCents(m: EconomicModel, channel: Channel): number {
  const miss = missingEconomics(m, channel);
  if (miss.length) throw new UnknownEconomics(miss);
  return Math.round(m.cleaningCostCents! + m.linenCostCents! - m.cleaningFeeChargedCents! * rate(m, channel));
}

/**
 * Plancher brut par nuit (blueprint §8.3) :
 * (contribution visée du séjour + coût de séjour non récupéré + coûts variables × n) / (n × (1 − commission − frais)).
 */
export function floorGrossNightlyCents(m: EconomicModel, channel: Channel, nights: number, contributionPerNightCents: number): number {
  if (nights < 1) throw new Error("Durée de séjour invalide");
  const stay = unrecoveredStayCostCents(m, channel);
  const num = contributionPerNightCents * nights + stay + m.nightlyVariableCostCents! * nights;
  return Math.ceil(num / (nights * rate(m, channel)));
}
export const hardFloorCents = (m: EconomicModel, c: Channel, n: number) => floorGrossNightlyCents(m, c, n, m.hardContributionPerNightCents!);
export const strategyFloorCents = (m: EconomicModel, c: Channel, n: number) => floorGrossNightlyCents(m, c, n, m.strategyContributionPerNightCents!);

export function cumulativeDiscountPct(discounts: number[]): number {
  return (1 - discounts.reduce((acc, d) => acc * (1 - d / 100), 1)) * 100;
}

export type StackInput = {
  model: EconomicModel; channel: Channel; nights: number; publishedNightlyCents: number;
  losDiscountPct?: number; promos?: { label: string; discountPct: number }[];
};

/**
 * Discount Stack Simulator (blueprint §8.4). Ordre canonique :
 * prix publié → ajustement durée → promotions du canal → commission → frais de paiement → coûts.
 * Chaque étape est conservée pour expliquer le résultat.
 */
export function simulateStack(i: StackInput): StackResult {
  const miss = missingEconomics(i.model, i.channel);
  if (miss.length) throw new UnknownEconomics(miss);
  const ce = i.model.channels[i.channel]!;
  const n = i.nights;
  const steps: WaterfallStep[] = [];
  let running = i.publishedNightlyCents * n;
  steps.push({ key: "published", label: "Prix publié", cents: running, source: `PriceLabs · ${n} nuit${n > 1 ? "s" : ""}` });
  const all = [...(i.losDiscountPct ? [{ label: "Remise durée de séjour", discountPct: i.losDiscountPct }] : []), ...(i.promos ?? [])];
  for (const p of all) {
    const cut = Math.round(running * p.discountPct / 100);
    running -= cut;
    steps.push({ key: "promo", label: `${p.label} −${fmtPct(p.discountPct)}`, cents: -cut, source: CHANNEL_LABEL[i.channel] });
  }
  const gross = running;
  steps.push({ key: "gross", label: "Hébergement vendu", cents: gross, source: "après remises, hors ménage et taxes", kind: "net" });
  const commission = Math.round(gross * ce.commissionPct / 100);
  const fee = Math.round(gross * ce.paymentFeePct / 100);
  steps.push({ key: "commission", label: `Commission ${fmtPct(ce.commissionPct)}`, cents: -commission, source: CHANNEL_LABEL[i.channel] });
  if (fee) steps.push({ key: "fee", label: `Frais de paiement ${fmtPct(ce.paymentFeePct)}`, cents: -fee, source: CHANNEL_LABEL[i.channel] });
  const net = gross - commission - fee;
  steps.push({ key: "net", label: "Revenu net d'hébergement", cents: net, source: "avant coûts", kind: "net" });
  const stay = unrecoveredStayCostCents(i.model, i.channel);
  const variable = i.model.nightlyVariableCostCents! * n;
  steps.push({ key: "stay", label: stay >= 0 ? "Coût de séjour non récupéré" : "Marge sur le ménage", cents: -stay, source: "ménage + linge − frais facturés" });
  steps.push({ key: "variable", label: "Coûts variables", cents: -variable, source: `${n} nuit${n > 1 ? "s" : ""}` });
  const contribution = net - stay - variable;
  steps.push({ key: "contribution", label: "Contribution", cents: contribution, source: "par séjour", kind: "final" });
  return {
    channel: i.channel, nights: n, publishedNightlyCents: i.publishedNightlyCents,
    soldNightlyCents: Math.round(gross / n), cumulativeDiscountPct: cumulativeDiscountPct(all.map((p) => p.discountPct)),
    grossRoomCents: gross, netRoomCents: net, contributionCents: contribution,
    contributionPerNightCents: Math.round(contribution / n), netAdrCents: Math.round(net / n), steps,
  };
}
function fmtPct(x: number): string { return (Math.round(x * 10) / 10).toString().replace(".", ",") + " %"; }

/** Grille des planchers canal × durée de séjour (2, 7 et 28 nuits par défaut). */
export function floorGrid(m: EconomicModel, los: number[] = [2, 7, 28]) {
  const out: { channel: Channel; nights: number; hardCents: number; strategyCents: number }[] = [];
  for (const c of Object.keys(m.channels) as Channel[]) for (const n of los)
    out.push({ channel: c, nights: n, hardCents: hardFloorCents(m, c, n), strategyCents: strategyFloorCents(m, c, n) });
  return out;
}
