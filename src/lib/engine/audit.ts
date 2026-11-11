import type { AuditRule, AuditVerdict, Candidate, Channel, EconomicModel, Strategy } from "./types";
import { hardFloorCents, strategyFloorCents } from "./economics";
import { euro } from "../format";

export type AuditContext = {
  model: EconomicModel; strategy: Strategy;
  /** Canaux dont le registre de promotions n'a pas été vérifié depuis moins de 7 jours */
  stalePromoChannels: Channel[];
  /** Une action en cours d'observation couvre déjà ces dates */
  conflict: boolean;
  capabilities: Record<string, boolean>;
  demo: boolean;
};

type Draft = Omit<Candidate, "audit">;

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
    const strat = strategyFloorCents(ctx.model, state.channel, state.nights);
    if (state.soldNightlyCents < hard) {
      add("HARD_FLOOR", "Plancher économique absolu", "FAIL",
        c.type === "NO_ACTION"
          ? `L'inaction maintient un prix vendu de ${euro(state.soldNightlyCents)} sous le plancher de ${euro(hard)}.`
          : `Prix vendu simulé ${euro(state.soldNightlyCents)} sous le plancher de ${euro(hard)}.`);
    } else {
      add("HARD_FLOOR", "Plancher économique absolu", "PASS", `Prix vendu ${euro(state.soldNightlyCents)} ≥ plancher ${euro(hard)} (${state.nights} nuits).`);
      add("STRATEGY_FLOOR", "Plancher stratégique", state.soldNightlyCents < strat ? "WARN" : "PASS",
        state.soldNightlyCents < strat
          ? `Prix vendu ${euro(state.soldNightlyCents)} sous le plancher stratégique de ${euro(strat)}.`
          : `Prix vendu ${euro(state.soldNightlyCents)} ≥ plancher stratégique ${euro(strat)}.`);
    }
    if (c.type === "CHANNEL_PROMO") {
      const max = ctx.strategy.maxDiscountStackPct;
      add("DISCOUNT_STACK", "Cumul des remises", state.cumulativeDiscountPct > max ? "FAIL" : "PASS",
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
  if (c.type !== "NO_ACTION") {
    add("CONFLICT", "Conflit avec une action en cours", ctx.conflict ? "FAIL" : "PASS",
      ctx.conflict ? "Une action en période d'observation couvre déjà ces dates." : "Aucune action active sur ces dates.");
    add("ROLLBACK", "Retour arrière", c.rollbackPlan ? "PASS" : "FAIL", c.rollbackPlan || "Aucun plan de retour arrière.");
    const mode = c.executionMode === "API_PRICELABS"
      ? (ctx.demo ? "Écriture PriceLabs simulée — mode démonstration." : ctx.capabilities["pricelabs.write"] ? "Écriture PriceLabs par API après approbation." : "Écriture PriceLabs indisponible : procédure guidée manuelle.")
      : c.executionMode === "MANUAL_RUNBOOK" ? "Procédure manuelle guidée dans l'extranet officiel, avec preuve." : "Tâche interne, sans écriture externe.";
    add("CAPABILITY", "Capacité d'exécution", "PASS", mode);
  }

  const verdict = rules.some((r) => r.outcome === "FAIL") ? "REJECT" : rules.some((r) => r.outcome === "WARN") ? "NEEDS_HUMAN" : "APPROVE";
  return { verdict, rules };
}
