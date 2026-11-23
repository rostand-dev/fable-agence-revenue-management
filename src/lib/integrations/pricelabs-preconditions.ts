import type { RemoteOverride } from "./pricelabs-write-port";
import type { WritePlan } from "./pricelabs-write";

/**
 * Préconditions d'une écriture PriceLabs (épic 9, US-091). Fonction PURE : on lui donne l'état réel relu chez PriceLabs, l'état local sur lequel la simulation
 * a été faite et l'action ; elle rend la liste des raisons de refuser. Liste vide = on peut écrire. Une valeur inconnue du côté réel n'est JAMAIS prise pour conforme
 * quand la comparaison en dépend (échec fermé).
 */
/** Alignée sur la variation quotidienne maximale de la stratégie (5 %) : PriceLabs recalcule chaque jour, une dérive plus faible est normale */
export const GRID_DRIFT_TOLERANCE_PCT = 5;
export const BASE_DRIFT_TOLERANCE_PCT = 2;

export type PreconditionInput = {
  plan: Exclude<WritePlan, { kind: "UNSUPPORTED" }>;
  type: string;
  parameters: Record<string, any>;
  remote: {
    limits: { minCents: number | null; baseCents: number | null; maxCents: number | null };
    pushEnabled: boolean | null;
    prices: Record<string, number | null>;
    overrides: RemoteOverride[];
  };
  /** Ce sur quoi la simulation s'est appuyée : grille simulée figée dans l'action (à défaut, grille locale) et stratégie du logement */
  local: { prices: Record<string, number | null>; baseCents: number | null; minCents?: number | null };
};

const eur = (c: number) => (c / 100).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
const pct = (a: number, b: number) => (Math.abs(a - b) / b) * 100;

export function checkPreconditions(i: PreconditionInput): string[] {
  const out: string[] = [];
  const { remote: r } = i;
  // une annonce dont la synchronisation vers le canal est coupée accepterait l'écriture sans aucun effet
  if (r.pushEnabled === false) out.push("la synchronisation des prix est désactivée sur cette annonce chez PriceLabs : l'écriture n'aurait aucun effet");

  if (i.plan.kind === "LISTING_LIMITS") {
    const l = i.plan.limits;
    const min = l.minCents ?? r.limits.minCents, base = l.baseCents ?? r.limits.baseCents, max = l.maxCents ?? r.limits.maxCents;
    if (l.minCents !== undefined && r.limits.minCents !== l.minCents) { // déjà à la valeur cible : état conforme, rien à comparer
      const was = typeof i.parameters.previousMinPriceCents === "number" ? i.parameters.previousMinPriceCents : i.local.minCents ?? null;
      if (was === null) out.push("l'action n'indique pas le prix minimum de départ de la simulation : impossible de contrôler l'état chez PriceLabs, relancez la revue");
      else if (r.limits.minCents === null) out.push("le prix minimum actuel chez PriceLabs est inconnu : impossible de le comparer à la simulation");
      else if (r.limits.minCents !== was) out.push(`le prix minimum chez PriceLabs est ${eur(r.limits.minCents)}, pas ${eur(was)} comme lors de la simulation`);
    }
    if (l.baseCents !== undefined && r.limits.baseCents !== l.baseCents) {
      const ref = typeof i.parameters.previousBasePriceCents === "number" ? i.parameters.previousBasePriceCents : i.local.baseCents;
      if (ref) {
        if (r.limits.baseCents === null) out.push("le prix de base actuel chez PriceLabs est inconnu : impossible de le comparer à la simulation");
        else if (pct(r.limits.baseCents, ref) > BASE_DRIFT_TOLERANCE_PCT) out.push(`le prix de base chez PriceLabs (${eur(r.limits.baseCents)}) s'écarte de celui de la simulation (${eur(ref)}) de plus de ${BASE_DRIFT_TOLERANCE_PCT} % : relancez la revue`);
      }
    }
    // contrôles croisés : seulement les couples qui impliquent un champ modifié (une incohérence préexistante sans rapport ne bloque pas)
    if (l.minCents !== undefined || l.maxCents !== undefined) if (min !== null && max !== null && min > max) out.push(`le prix minimum (${eur(min)}) dépasserait le prix maximum chez PriceLabs (${eur(max)})`);
    if (l.minCents !== undefined || l.baseCents !== undefined) if (min !== null && base !== null && min > base) out.push(`le prix minimum (${eur(min)}) dépasserait le prix de base (${eur(base)})`);
    if (l.baseCents !== undefined || l.maxCents !== undefined) if (base !== null && max !== null && base > max) out.push(`le prix de base (${eur(base)}) dépasserait le prix maximum chez PriceLabs (${eur(max)})`);
    return out;
  }

  const describe = (o: RemoteOverride) => (o.priceCents === null ? "valeur inconnue" : (o.priceType ?? "fixed") === "fixed" ? eur(o.priceCents) : `variation de ${o.priceCents / 100} %`);
  for (const it of i.plan.items) {
    const o = r.overrides.find((x) => x.date === it.date);
    if (o) {
      const same = o.priceCents === it.priceCents && (o.priceType ?? "fixed") === "fixed";
      // un prix daté différent déjà posé n'est pas écrasé en silence ; le même prix = rejeu inoffensif… sauf s'il porte un séjour minimum, que l'écriture effacerait
      if (!same) out.push(`le ${it.date} porte déjà un prix daté chez PriceLabs (${describe(o)}) : supprimez-le ou relancez la revue`);
      else if (o.minStay !== null && o.minStay !== undefined) out.push(`le ${it.date} porte un séjour minimum daté chez PriceLabs que l'écriture effacerait`);
    }
    // la variation en % a été simulée sur la grille de ce jour-là : si PriceLabs l'a recalculée depuis, la simulation n'est plus la bonne
    if (typeof i.parameters.changePct === "number" && !(i.type === "RULE_EXCLUSION" || i.parameters.restoresFloor)) {
      const sim = i.parameters.simulatedPrices?.[it.date], loc = typeof sim === "number" ? sim : i.local.prices[it.date], rem = r.prices[it.date];
      if (typeof loc !== "number" || loc <= 0) out.push(`le prix simulé du ${it.date} est inconnu : impossible de contrôler la grille, relancez la revue`);
      else if (typeof rem !== "number" || rem <= 0) out.push(`le prix du ${it.date} est inconnu chez PriceLabs : impossible de le comparer à la simulation`);
      else if (pct(rem, loc) > GRID_DRIFT_TOLERANCE_PCT) out.push(`le prix du ${it.date} a changé depuis la simulation (${eur(loc)} → ${eur(rem)}) : relancez la revue`);
    }
    if (r.limits.maxCents !== null && it.priceCents > r.limits.maxCents) out.push(`le prix du ${it.date} (${eur(it.priceCents)}) dépasse le prix maximum chez PriceLabs (${eur(r.limits.maxCents)})`);
    if (r.limits.minCents !== null && it.priceCents < r.limits.minCents) out.push(`le prix du ${it.date} (${eur(it.priceCents)}) passe sous le prix minimum chez PriceLabs (${eur(r.limits.minCents)})`);
  }
  return out;
}
