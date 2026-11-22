import { addDays, type ISODate } from "../dates";
import { euro } from "../format";
import { evaluateStacking, promoKind, STACK_STATUS, type InPlayPromo, type StackEvaluation } from "../stacking/rules";
import { cumulativeDiscountPct, hardFloorCents, simulateStack, unrecoveredStayCostCents } from "./economics";
import { strategyFloorWindow } from "./seasons";
import type { Channel, EconomicModel, Season, StackResult } from "./types";
import { CHANNEL_LABEL } from "./types";

/**
 * Discount Stack Simulator explicable (US-053, blueprint §8.4). Pur : même entrée, même sortie, aucune lecture de la base.
 * Ordre canonique : prix publié → remise de durée → promotions du canal (l'une après l'autre sur le montant restant) → commission → frais de paiement → coûts.
 * Chaque étape dit en une phrase d'où vient son montant ; la cascade se referme exactement sur la contribution ; le verdict compare le prix vendu
 * aux planchers de la saison du séjour et applique les règles de cumul (US-003) : une règle inconnue n'est jamais devinée (NEEDS_HUMAN).
 */
export type SimPromo = { kind: string; label: string; discountPct: number };
export type SimInput = {
  model: EconomicModel; channel: Channel; nights: number; stayFrom: ISODate; publishedNightlyCents: number;
  /** Remise de durée de séjour (type LOS) */
  losDiscountPct?: number;
  promos?: SimPromo[];
  /** Plafond de cumul de la stratégie, en % */
  maxDiscountStackPct: number;
  /** Le registre des promotions du canal n'a pas été vérifié récemment : le cumul réel est incertain */
  registryStale?: boolean;
};

export type SimVerdict = "OK" | "WARN" | "NEEDS_HUMAN" | "REJECT";
export type ExplainedStep = { key: string; label: string; cents: number; kind?: "net" | "final"; explanation: string };
export type SimReason = { code: "HARD_FLOOR" | "STRATEGY_FLOOR" | "DISCOUNT_STACK" | "STACK_RULES"; outcome: "PASS" | "WARN" | "FAIL" | "HUMAN"; detail: string };
export type Simulation = {
  result: StackResult;
  steps: ExplainedStep[];
  /** La somme signée des étapes (hors sous-totaux) est exactement la contribution */
  reconciles: boolean;
  floors: { hardCents: number; strategyCents: number; season: Season | null };
  stacking: StackEvaluation;
  verdict: SimVerdict;
  reasons: SimReason[];
};

const pct = (x: number) => (Math.round(x * 10) / 10).toString().replace(".", ",") + " %";
const nightsText = (n: number) => `${n} nuit${n > 1 ? "s" : ""}`;

function explain(i: SimInput, r: StackResult): ExplainedStep[] {
  const ch = CHANNEL_LABEL[i.channel], m = i.model, ce = m.channels[i.channel]!;
  const total = i.publishedNightlyCents * i.nights;
  let running = total;
  const stay = unrecoveredStayCostCents(m, i.channel);
  const gross = r.grossRoomCents;
  return r.steps.map((s) => {
    let explanation = "";
    switch (s.key) {
      case "published": explanation = `Prix publié sur ${ch} : ${euro(i.publishedNightlyCents, true)} par nuit × ${nightsText(i.nights)} = ${euro(total, true)}.`; break;
      case "promo": { const before = running; running += s.cents; explanation = `Remise appliquée au montant restant (${euro(before, true)}), pas ajoutée aux autres : ${euro(-s.cents, true)} retirés. Reste ${euro(running, true)}.`; break; }
      case "gross": explanation = `Ce que paie le voyageur pour l'hébergement après remises, hors ménage et taxes : ${euro(Math.round(gross / i.nights), true)} par nuit.`; break;
      case "commission": explanation = `${pct(ce.commissionPct)} du montant vendu (${euro(gross, true)}) retenus par ${ch}.`; break;
      case "fee": explanation = `${pct(ce.paymentFeePct)} du montant vendu (${euro(gross, true)}) de frais de paiement.`; break;
      case "net": explanation = `Montant vendu moins commission et frais de paiement : ce qui arrive réellement, avant tout coût.`; break;
      case "stay": explanation = stay >= 0
        ? `Ménage ${euro(m.cleaningCostCents!, true)} + linge ${euro(m.linenCostCents!, true)} − frais de ménage facturés ${euro(m.cleaningFeeChargedCents!, true)} (soit ${euro(m.cleaningCostCents! + m.linenCostCents! - stay, true)} une fois commission et frais de paiement retirés) = ${euro(stay, true)} à la charge du séjour.`
        : `Les frais de ménage facturés (nets de commission) dépassent le coût du ménage et du linge : le ménage dégage ${euro(-stay, true)} (frais facturés nets de commission et frais de paiement : ${euro(m.cleaningCostCents! + m.linenCostCents! - stay, true)}).`; break;
      case "variable": explanation = `${euro(m.nightlyVariableCostCents!, true)} de coûts variables par nuit × ${nightsText(i.nights)}.`; break;
      case "contribution": explanation = `Revenu net − coût de séjour − coûts variables : ce que laisse le séjour, soit ${euro(r.contributionPerNightCents, true)} par nuit, avant charges fixes.`; break;
    }
    return { key: s.key, label: s.label, cents: s.cents, kind: s.kind, explanation };
  });
}

export function simulate(i: SimInput): Simulation {
  const promos = i.promos ?? [];
  const result = simulateStack({ model: i.model, channel: i.channel, nights: i.nights, publishedNightlyCents: i.publishedNightlyCents, losDiscountPct: i.losDiscountPct, promos: promos.map((p) => ({ label: p.label, discountPct: p.discountPct })) });
  const steps = explain(i, result);
  const signed = steps.filter((s) => !s.kind).reduce((a, s) => a + s.cents, 0);
  const reconciles = signed === result.contributionCents;

  const to = addDays(i.stayFrom, i.nights);
  const hard = hardFloorCents(i.model, i.channel, i.nights);
  const sf = strategyFloorWindow(i.model, i.channel, i.nights, i.stayFrom, to);
  const strat = sf.floor, season = sf.season;
  const seasonNote = season ? ` (saison « ${season.label} »)` : "";

  const inPlay: InPlayPromo[] = [...(i.losDiscountPct ? [{ id: "los", kind: "LOS", label: "Remise de durée de séjour" }] : []), ...promos.map((p, n) => ({ id: `p${n}`, kind: p.kind, label: p.label }))];
  const stacking = evaluateStacking(i.channel, inPlay);

  const reasons: SimReason[] = [];
  const sold = result.soldNightlyCents;
  reasons.push(sold < hard
    ? { code: "HARD_FLOOR", outcome: "FAIL", detail: `Prix vendu ${euro(sold, true)} sous le plancher absolu de ${euro(hard, true)} (${nightsText(i.nights)}).` }
    : { code: "HARD_FLOOR", outcome: "PASS", detail: `Prix vendu ${euro(sold, true)} ≥ plancher absolu ${euro(hard, true)}.` });
  reasons.push(sold < strat
    ? { code: "STRATEGY_FLOOR", outcome: "WARN", detail: `Prix vendu ${euro(sold, true)} sous le plancher stratégique de ${euro(strat, true)}${seasonNote}.` }
    : { code: "STRATEGY_FLOOR", outcome: "PASS", detail: `Prix vendu ${euro(sold, true)} ≥ plancher stratégique ${euro(strat, true)}${seasonNote}.` });
  const cum = cumulativeDiscountPct([...(i.losDiscountPct ? [i.losDiscountPct] : []), ...promos.map((p) => p.discountPct)]);
  reasons.push(cum > i.maxDiscountStackPct + 1e-9
    ? { code: "DISCOUNT_STACK", outcome: "FAIL", detail: `Cumul des remises ${pct(cum)} au-delà du maximum de ${pct(i.maxDiscountStackPct)}.` }
    : { code: "DISCOUNT_STACK", outcome: "PASS", detail: `Cumul des remises ${pct(cum)} pour un maximum de ${pct(i.maxDiscountStackPct)}.` });
  const name = (p: InPlayPromo) => `« ${promoKind(i.channel, p.kind)?.label ?? p.label} »`;
  const unknownKinds = inPlay.filter((p) => !promoKind(i.channel, p.kind));
  if (i.registryStale) reasons.push({ code: "STACK_RULES", outcome: "HUMAN", detail: `Registre des promotions ${CHANNEL_LABEL[i.channel]} non vérifié récemment : les promotions réellement actives et leur cumul sont incertains.` });
  else if (unknownKinds.length) reasons.push({ code: "STACK_RULES", outcome: "HUMAN", detail: `Type de promotion absent du registre de cumul de ${CHANNEL_LABEL[i.channel]} : ${unknownKinds.map((p) => p.kind).join(", ")}. Rien n'est supposé : confirmez son effet dans l'extranet.` });
  else if (stacking.needsHuman) reasons.push({ code: "STACK_RULES", outcome: "HUMAN", detail: `Règle de cumul inconnue sur ${CHANNEL_LABEL[i.channel]} entre ${stacking.unknown.map((u) => `${name(u.first)} et ${name(u.second)}`).join(" ; ")}. Le prix simulé suppose un cumul non établi : confirmez-le dans l'extranet.` });
  else if (stacking.count >= 2) reasons.push({ code: "STACK_RULES", outcome: "PASS", detail: `${stacking.pairs.length} combinaison${stacking.pairs.length > 1 ? "s" : ""} documentée${stacking.pairs.length > 1 ? "s" : ""} (${[...new Set(stacking.pairs.map((p) => STACK_STATUS[p.status].label.toLowerCase()))].join(", ")}).${stacking.pairs.some((p) => p.status === "EXCLUSIVE") ? " Quand une seule s'applique, la cascade les cumule par prudence : l'effet réel peut être plus faible." : ""}` });
  else reasons.push({ code: "STACK_RULES", outcome: "PASS", detail: "Moins de deux promotions : aucun cumul à contrôler." });

  // un rejet l'emporte sur tout ; puis la décision humaine ; puis l'avertissement
  const verdict: SimVerdict = reasons.some((r) => r.outcome === "FAIL") ? "REJECT" : reasons.some((r) => r.outcome === "HUMAN") ? "NEEDS_HUMAN" : reasons.some((r) => r.outcome === "WARN") ? "WARN" : "OK";
  return { result, steps, reconciles, floors: { hardCents: hard, strategyCents: strat, season }, stacking, verdict, reasons };
}
