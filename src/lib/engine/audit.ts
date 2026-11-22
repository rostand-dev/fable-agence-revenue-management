import type { AuditRule, AuditVerdict, Candidate, Channel, EconomicModel, Promo, Strategy } from "./types";
import { hardFloorCents } from "./economics";
import { strategyFloorWindow } from "./seasons";
import { euro } from "../format";
import type { ISODate } from "../dates";
import { evaluateStacking, overlapsWindow, promoKind, STACK_STATUS, type InPlayPromo } from "../stacking/rules";

export type AuditContext = {
  model: EconomicModel; strategy: Strategy;
  /** Canaux dont le registre de promotions n'a pas été vérifié depuis moins de 7 jours */
  stalePromoChannels: Channel[];
  /** Une action en cours d'observation couvre déjà ces dates */
  conflict: boolean;
  capabilities: Record<string, boolean>;
  demo: boolean;
  /** Registre des promotions du logement (US-003) : sert à contrôler les règles de cumul du canal */
  promos: Promo[];
  /** Nuits visées par l'option, [from, to[ : seules les promotions qui les recoupent entrent en jeu */
  window: { from: ISODate; to: ISODate };
};

type Draft = Omit<Candidate, "audit">;

/**
 * Une règle de cumul inconnue n'est critique que pour une option qui ajoute une remise ou baisse le prix : c'est là que le prix vendu
 * réel pourrait passer sous celui qui a été simulé. Relever un prix, retirer une promotion, changer un séjour minimum ou ne rien faire
 * ne peuvent pas creuser la remise ; le cumul déjà en place est signalé par le playbook PB-05 et par le registre.
 */
const lowersPrice = (c: Draft) => c.type === "CHANNEL_PROMO" || (c.priceChangePct !== null && c.priceChangePct < 0);
const CH_NAME: Record<string, string> = { AIRBNB: "Airbnb", BOOKING: "Booking.com" };

/**
 * Règles de cumul (US-003, blueprint §10.4). Le plancher est simulé en supposant que les promotions en jeu se cumulent ;
 * si le registre ne dit pas qu'elles le font, ou ne les connaît pas, la décision revient à un humain. Aucun cumul n'est deviné.
 */
function stackRulesOn(c: Draft, ctx: AuditContext, channel: Channel): { ok: boolean; detail: string } {
  const inPlay: InPlayPromo[] = ctx.promos
    .filter((p) => p.channel === channel && overlapsWindow(p, ctx.window.from, ctx.window.to))
    .map((p) => ({ id: p.id, kind: p.kind, label: p.label }));
  if (c.type === "CHANNEL_PROMO") inPlay.push({ id: "candidate", kind: String(c.parameters.kind ?? ""), label: String(c.parameters.label ?? c.label) });
  const ch = CH_NAME[channel];
  // un registre non vérifié depuis plus de 7 jours (ou jamais) ne dit pas quelles promotions sont réellement actives
  if (ctx.stalePromoChannels.includes(channel)) return { ok: false, detail: `Registre des promotions ${ch} non vérifié récemment : les promotions en jeu et leur cumul sont incertains.` };
  const ev = evaluateStacking(channel, inPlay);
  if (ev.count < 2) return { ok: true, detail: `Aucune autre promotion enregistrée au registre ${ch} sur ces dates : aucun cumul à contrôler.` };
  const name = (p: InPlayPromo) => `« ${promoKind(channel, p.kind)?.label ?? p.label} »`;
  if (ev.needsHuman) {
    const list = ev.unknown.map((u) => `${name(u.first)} et ${name(u.second)}`).join(" ; ");
    return { ok: false, detail: `Règle de cumul inconnue sur ${ch} entre ${list}. Le prix vendu simulé suppose un cumul non établi : confirmez le cumul dans l'extranet avant d'approuver.` };
  }
  const known = ev.pairs.map((p) => STACK_STATUS[p.status].label.toLowerCase()).filter((v, i, a) => a.indexOf(v) === i).join(", ");
  return { ok: true, detail: `${ev.pairs.length} combinaison${ev.pairs.length > 1 ? "s" : ""} de promotions ${ch} documentée${ev.pairs.length > 1 ? "s" : ""} (${known}).` };
}

function stackRulesCheck(c: Draft, ctx: AuditContext, state: { channel: Channel } | null): AuditRule | null {
  if (!lowersPrice(c)) return null;
  // une promotion vise son canal ; un prix PriceLabs s'applique à tous les canaux du logement : chacun est contrôlé
  const channels: Channel[] = c.target.channel ? [c.target.channel] : c.target.system === "PRICELABS" ? (Object.keys(ctx.model.channels) as Channel[]) : state ? [state.channel] : [];
  if (!channels.length) return null;
  const res = channels.map((ch) => stackRulesOn(c, ctx, ch));
  const bad = res.filter((r) => !r.ok);
  return { code: "STACK_RULES", label: "Règles de cumul du canal", outcome: bad.length ? "WARN" : "PASS", detail: (bad.length ? bad : res).map((r) => r.detail).join(" ") };
}

/**
 * Revenue Auditor : contrôle déterministe. Réponse strictement APPROVE, REJECT ou NEEDS_HUMAN,
 * accompagnée des codes de règles. Aucun LLM n'intervient ici.
 */
export function auditCandidate(c: Draft, ctx: AuditContext): AuditVerdict {
  const rules: AuditRule[] = [];
  const add = (code: string, label: string, outcome: AuditRule["outcome"], detail: string) => rules.push({ code, label, outcome, detail });
  const state = c.proposed ?? c.current;

  if (state) {
    const hard = hardFloorCents(ctx.model, state.channel, state.nights);
    // la saison se lit sur les nuits visées par l'option : le plancher le plus exigeant des saisons traversées s'applique
    const sf = strategyFloorWindow(ctx.model, state.channel, state.nights, ctx.window.from, ctx.window.to > ctx.window.from ? ctx.window.to : undefined);
    const strat = sf.floor;
    const seasonNote = sf.season ? ` (saison « ${sf.season.label} »)` : "";
    if (state.soldNightlyCents < hard) {
      add("HARD_FLOOR", "Plancher économique absolu", "FAIL",
        c.type === "NO_ACTION"
          ? `L'inaction maintient un prix vendu de ${euro(state.soldNightlyCents)} sous le plancher de ${euro(hard)}.`
          : `Prix vendu simulé ${euro(state.soldNightlyCents)} sous le plancher de ${euro(hard)}.`);
    } else {
      add("HARD_FLOOR", "Plancher économique absolu", "PASS", `Prix vendu ${euro(state.soldNightlyCents)} ≥ plancher ${euro(hard)} (${state.nights} nuits).`);
      add("STRATEGY_FLOOR", "Plancher stratégique", state.soldNightlyCents < strat ? "WARN" : "PASS",
        state.soldNightlyCents < strat
          ? `Prix vendu ${euro(state.soldNightlyCents)} sous le plancher stratégique de ${euro(strat)}${seasonNote}.`
          : `Prix vendu ${euro(state.soldNightlyCents)} ≥ plancher stratégique ${euro(strat)}${seasonNote}.`);
    }
    if (c.type === "CHANNEL_PROMO") {
      const max = ctx.strategy.maxDiscountStackPct;
      add("DISCOUNT_STACK", "Cumul des remises", state.cumulativeDiscountPct > max + 1e-9 ? "FAIL" : "PASS",
        `Cumul simulé ${state.cumulativeDiscountPct.toFixed(1).replace(".", ",")} % pour un maximum de ${max} %.`);
    }
  } else if (c.type !== "NO_ACTION" && c.type !== "INVESTIGATION" && c.type !== "LISTING_AUDIT") {
    add("HARD_FLOOR", "Plancher économique absolu", "WARN", "Simulation indisponible : le plancher ne peut pas être contrôlé.");
  }

  if (c.priceChangePct !== null && c.priceChangePct !== 0) {
    const abs = Math.abs(c.priceChangePct), max = ctx.strategy.maxPriceChangePct;
    const txt = `${c.priceChangePct > 0 ? "+" : "−"}${abs.toFixed(1).replace(".", ",")} %`;
    if (c.parameters.restoresFloor) add("MAX_VARIATION", "Variation maximale", "WARN", `Variation ${txt} : au-delà de ±${max} %, admise car elle rétablit une borne validée.`);
    else if (abs <= max + 0.01) add("MAX_VARIATION", "Variation maximale", "PASS", `Variation ${txt} dans la limite de ±${max} %.`);
    else if (abs <= 15) add("MAX_VARIATION", "Variation maximale", "WARN", `Variation ${txt} au-delà de ±${max} % : validation commentée requise.`);
    else add("MAX_VARIATION", "Variation maximale", "FAIL", `Variation ${txt} au-delà de 15 % par action.`);
  }
  if (c.type === "BASE_PRICE_CHANGE") add("STRUCTURAL", "Action structurelle", "WARN", "Modification du prix de base : une seule hypothèse structurante à la fois, commentaire obligatoire.");
  if (c.nightsTouched > 14 && c.type !== "BASE_PRICE_CHANGE") add("SCOPE", "Portée en nuits", "WARN", `${c.nightsTouched} nuits touchées pour un maximum de 14 sans validation renforcée.`);
  else if (c.nightsTouched > 0) add("SCOPE", "Portée en nuits", "PASS", `${c.nightsTouched} nuit${c.nightsTouched > 1 ? "s" : ""} touchée${c.nightsTouched > 1 ? "s" : ""}.`);

  if ((c.type === "CHANNEL_PROMO" || c.type === "PROMO_REMOVAL") && c.target.channel) {
    const stale = ctx.stalePromoChannels.includes(c.target.channel);
    add("PROMO_FRESHNESS", "Fraîcheur du registre des promotions", stale ? "WARN" : "PASS",
      stale ? "Registre non vérifié depuis plus de 7 jours : les règles de cumul sont incertaines." : "Registre vérifié depuis moins de 7 jours.");
  }
  const stack = stackRulesCheck(c, ctx, state);
  if (stack) rules.push(stack);
  if (c.type !== "NO_ACTION") {
    add("CONFLICT", "Conflit avec une action en cours", ctx.conflict ? "FAIL" : "PASS",
      ctx.conflict ? "Une action en période d'observation couvre déjà ces dates." : "Aucune action active sur ces dates.");
    add("ROLLBACK", "Retour arrière", c.rollbackPlan ? "PASS" : "FAIL", c.rollbackPlan || "Aucun plan de retour arrière.");
    if (c.executionMode === "API_PRICELABS") {
      // un write non supporté est impossible (US-002) : l'option est rejetée, jamais proposée comme exécutable
      if (!ctx.capabilities["pricelabs.write"]) add("CAPABILITY", "Capacité d'exécution", "FAIL", "Écriture PriceLabs impossible : capacité absente ou coupe-circuit actif. Procédure manuelle guidée seulement.");
      else add("CAPABILITY", "Capacité d'exécution", "PASS", ctx.demo ? "Écriture PriceLabs simulée — mode démonstration." : "Écriture PriceLabs par API après approbation.");
    } else {
      add("CAPABILITY", "Capacité d'exécution", "PASS", c.executionMode === "MANUAL_RUNBOOK" ? "Procédure manuelle guidée dans l'extranet officiel, avec preuve." : "Tâche interne, sans écriture externe.");
    }
  }

  const verdict = rules.some((r) => r.outcome === "FAIL") ? "REJECT" : rules.some((r) => r.outcome === "WARN") ? "NEEDS_HUMAN" : "APPROVE";
  return { verdict, rules };
}
