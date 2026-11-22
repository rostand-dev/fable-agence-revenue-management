/**
 * Policy engine et codes de veto (blueprint §5.6, §11.2–11.3, US-064).
 *
 * L'auditeur contrôle chaque option par des règles déterministes, chacune identifiée par un code stable. Ce module est la **source unique** de ces
 * codes : ce qu'ils contrôlent, ce que produit leur échec (veto = l'option est rejetée ; validation humaine = elle reste proposée mais ne s'approuve
 * qu'avec un commentaire), d'où vient leur seuil, et la façon de lire un verdict. Réponse strictement APPROVE, REJECT ou NEEDS_HUMAN, avec ses codes,
 * jamais une appréciation vague. Module pur, sans accès base.
 */
import type { AuditRule, AuditVerdict } from "./types";

/** VETO : un échec rejette l'option (« FAIL »). HUMAN : une alerte (« WARN ») demande une validation commentée. INFO : contrôle sans effet sur le verdict. */
export type PolicyEffect = "VETO" | "HUMAN" | "INFO";

export type PolicyRule = {
  code: string;
  label: string;
  /** Ce que la règle contrôle, en une phrase. */
  checks: string;
  /** Effet d'un échec (FAIL) et d'une alerte (WARN) ; null = la règle ne produit pas ce résultat. */
  onFail: PolicyEffect | null;
  onWarn: PolicyEffect | null;
  /** D'où vient le seuil : réglage du logement, constante du blueprint ou donnée. */
  threshold: string;
  /** Référence du blueprint. */
  ref: string;
};

export const POLICY_RULES: Record<string, PolicyRule> = {
  HARD_FLOOR: { code: "HARD_FLOOR", label: "Plancher économique absolu", checks: "Le prix vendu net de commission, frais de paiement et coûts reste au moins égal au plancher du séjour.", onFail: "VETO", onWarn: "HUMAN", threshold: "Plancher calculé par canal et durée de séjour (modèle économique)", ref: "§8.3, §11.2 : toute action sous le plancher est interdite" },
  STRATEGY_FLOOR: { code: "STRATEGY_FLOOR", label: "Plancher stratégique", checks: "Le prix vendu reste au moins égal au plancher stratégique de la saison.", onFail: null, onWarn: "HUMAN", threshold: "Plancher stratégique par saison (stratégie du logement)", ref: "§8.3" },
  DISCOUNT_STACK: { code: "DISCOUNT_STACK", label: "Cumul des remises", checks: "Le cumul des remises simulé ne dépasse pas le maximum du logement.", onFail: "VETO", onWarn: null, threshold: "Cumul maximal de remises (stratégie du logement)", ref: "§8.4, §11.3" },
  STACK_RULES: { code: "STACK_RULES", label: "Règles de cumul du canal", checks: "Les promotions en jeu sur le canal se cumulent bien selon les règles documentées ; une règle inconnue revient à un humain.", onFail: null, onWarn: "HUMAN", threshold: "Registre des règles de cumul (docs/regles-de-cumul.md)", ref: "§10.4" },
  MAX_VARIATION: { code: "MAX_VARIATION", label: "Variation maximale", checks: "La variation de prix par action reste dans la limite du logement ; au-delà de 15 % l'action est rejetée.", onFail: "VETO", onWarn: "HUMAN", threshold: "Variation maximale par action (stratégie du logement) ; plafond de 15 %", ref: "§11.2, §11.3" },
  SCOPE: { code: "SCOPE", label: "Portée en nuits", checks: "L'action ne touche pas plus de 14 nuits sans validation renforcée.", onFail: null, onWarn: "HUMAN", threshold: "14 nuits", ref: "§11.2, §11.3" },
  STRUCTURAL: { code: "STRUCTURAL", label: "Action structurelle", checks: "Une modification du prix de base s'accompagne d'un commentaire : une seule hypothèse structurante à la fois.", onFail: null, onWarn: "HUMAN", threshold: "Toute modification du prix de base", ref: "§6.4, §11.2" },
  MIN_PRICE_DOWN: { code: "MIN_PRICE_DOWN", label: "Baisse du prix minimum", checks: "Une baisse du prix minimum PriceLabs est signalée : validation commentée, et approbation du propriétaire ou du mandat (approbateur du playbook).", onFail: null, onWarn: "HUMAN", threshold: "Toute baisse du prix minimum", ref: "§11.2 : risque critique" },
  PROMO_FRESHNESS: { code: "PROMO_FRESHNESS", label: "Fraîcheur du registre des promotions", checks: "Le registre des promotions du canal a été vérifié depuis moins de 7 jours.", onFail: null, onWarn: "HUMAN", threshold: "7 jours", ref: "§11.3 : fraîcheur minimale des sources" },
  CONFLICT: { code: "CONFLICT", label: "Conflit avec une action en cours", checks: "Aucune action en période d'observation ne couvre déjà ces dates.", onFail: "VETO", onWarn: null, threshold: "Actions actives du logement", ref: "§11.3 : absence de conflit avec une action active" },
  ROLLBACK: { code: "ROLLBACK", label: "Retour arrière", checks: "Un plan de retour arrière existe pour toute action exécutable.", onFail: "VETO", onWarn: null, threshold: "Plan de retour arrière renseigné", ref: "§11.3 : rollback disponible" },
  CAPABILITY: { code: "CAPABILITY", label: "Capacité d'exécution", checks: "Le mode d'exécution est possible : une écriture non supportée ou coupée par le coupe-circuit est rejetée.", onFail: "VETO", onWarn: null, threshold: "Capacités des intégrations et coupe-circuit (Réglages)", ref: "§11.3 : kill switch, éligibilité et permissions" },
};
export const POLICY_CODES = Object.keys(POLICY_RULES);

export const OUTCOME_LABEL: Record<AuditRule["outcome"], string> = { PASS: "conforme", WARN: "validation humaine", FAIL: "veto" };

/** Verdict d'un jeu de règles : un seul échec rejette, une seule alerte demande un humain, sinon l'option est conforme. */
export function verdictOf(rules: AuditRule[]): AuditVerdict["verdict"] {
  return rules.some((r) => r.outcome === "FAIL") ? "REJECT" : rules.some((r) => r.outcome === "WARN") ? "NEEDS_HUMAN" : "APPROVE";
}
/** Codes de veto (règles en échec) et de validation humaine (règles en alerte) d'un verdict. */
export function policyCodes(v: AuditVerdict): { veto: string[]; human: string[] } {
  return { veto: v.rules.filter((r) => r.outcome === "FAIL").map((r) => r.code), human: v.rules.filter((r) => r.outcome === "WARN").map((r) => r.code) };
}
/** Une règle émise doit exister au registre, et son résultat doit être un de ceux qu'elle déclare : sinon c'est un défaut du moteur. */
export function policyViolations(rules: AuditRule[]): string[] {
  const out: string[] = [];
  for (const r of rules) {
    const p = POLICY_RULES[r.code];
    if (!p) { out.push(`règle ${r.code} absente du registre des codes de veto`); continue; }
    if (r.outcome === "FAIL" && p.onFail !== "VETO") out.push(`${r.code} ne peut pas rejeter une option`);
    if (r.outcome === "WARN" && p.onWarn !== "HUMAN") out.push(`${r.code} ne peut pas demander de validation humaine`);
  }
  return out;
}
/** Une phrase lisible : « Rejetée : Plancher économique absolu. » / « À valider : … » / « Conforme. » */
export function explainVerdict(v: AuditVerdict): string {
  const name = (code: string) => POLICY_RULES[code]?.label ?? code;
  const { veto, human } = policyCodes(v);
  if (v.verdict === "REJECT") return `Rejetée : ${veto.map(name).join(", ")}.`;
  if (v.verdict === "NEEDS_HUMAN") return `À valider avec un commentaire : ${human.map(name).join(", ")}.`;
  return "Conforme à toutes les règles.";
}
