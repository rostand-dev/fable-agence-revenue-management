import { CURRENCY_POLICY, GROUP_LABEL, MONEY_DICTIONARY, UNIT, isToConfirm, type Derivation, type Inclusion, type MoneyField, type MoneyGroup, type MoneySource } from "./dictionary";

const INCLUSION: Record<Inclusion, string> = { INCLUDED: "inclus", EXCLUDED: "exclu", NOT_APPLICABLE: "—", UNKNOWN: "**inconnu**" };
const SOURCE: Record<MoneySource, string> = { SUPERHOTE: "SuperHote", PRICELABS: "PriceLabs", OWNER_INPUT: "Propriétaire", COMPUTED: "Calcul", DEMO: "Démo" };
const DERIVATION: Record<Derivation, string> = { OBSERVED: "lu", DERIVED: "calculé", DECLARED: "déclaré", ESTIMATED: "estimé", MIXED: "lu, sinon estimé", NOT_COMPUTED: "non calculé" };
const cell = (s: string) => s.replace(/\|/g, "\\|");

/** Document `docs/dictionnaire-montants.md`, généré depuis le dictionnaire : ne pas le modifier à la main. */
export function renderDictionaryMarkdown(fields: MoneyField[] = MONEY_DICTIONARY): string {
  const out: string[] = [];
  out.push("# Dictionnaire canonique des montants", "");
  out.push("> Document généré par `npm run docs:money` depuis `src/lib/money/dictionary.ts`. Ne pas le modifier à la main : un test échoue s'il diverge du code.", "");
  out.push("US-001 · blueprint §8.1. SuperHote fait foi pour les réservations et leurs montants ; PriceLabs pour les prix, le marché et les réglages.", "");
  out.push("## Règles communes", "");
  out.push(`- **Unité** : ${UNIT}. Une valeur absente est \`null\` (inconnue), jamais zéro.`);
  out.push(`- **Devise** : ${CURRENCY_POLICY.code}, non stockée. ${CURRENCY_POLICY.note}`);
  out.push("- **Signe** : en base, tout montant retiré ou payé (commission, frais, coût) est stocké en valeur positive ; le signe n'est porté que par les écarts, les contributions et les étapes de la cascade de prix.");
  out.push("- **Colonnes d'inclusion** : *inclus* = le poste est dans le montant ; *exclu* = il n'y est pas ; *—* = sans objet ; **inconnu** = non établi (voir « À confirmer »). Pour commission et frais de paiement, *inclus* signifie « pas encore déduits » (brut), *exclu* « déjà déduits » (net).", "");
  const groups = [...new Set(fields.map((m) => m.group))] as MoneyGroup[];
  for (const g of groups) {
    out.push(`## ${GROUP_LABEL[g]}`, "");
    out.push("| Montant | Noms dans le code | Source | Nature | Taxe de séjour | TVA | Ménage | Commission | Frais de paiement | Signe | Statut |");
    out.push("|---|---|---|---|---|---|---|---|---|---|---|");
    for (const m of fields.filter((x) => x.group === g)) {
      out.push(`| ${cell(m.label)} | ${m.names.map((n) => "`" + n + "`").join(", ")} | ${m.sources.map((s) => SOURCE[s]).join(" / ")} | ${DERIVATION[m.derivation]} | ${INCLUSION[m.taxes.cityTax]} | ${INCLUSION[m.taxes.vat]} | ${INCLUSION[m.fees.cleaning]} | ${INCLUSION[m.fees.commission]} | ${INCLUSION[m.fees.paymentFee]} | ${m.sign === "SIGNED" ? "signé" : "≥ 0"} | ${isToConfirm(m) ? "à confirmer" : "établi"} |`);
    }
    out.push("");
    for (const m of fields.filter((x) => x.group === g)) {
      out.push(`### ${m.label}`, "", `\`${m.id}\` · ${m.location}`, "", m.definition);
      if (m.signNote) out.push("", `Signe : ${m.signNote}`);
      if (m.unit && m.unit !== "CENTS") out.push("", `Unité : ${m.unit === "EUROS" ? "euros (pas des centimes)" : "centimes non arrondis"}.`);
      if (m.nullable) out.push("", "`null` = inconnu.");
      if (m.caveats?.length) out.push("", ...m.caveats.map((c) => `- Réserve : ${c}`));
      out.push("");
    }
  }
  const open = fields.filter(isToConfirm);
  out.push("## À confirmer", "");
  out.push(`${open.length} montant${open.length > 1 ? "s" : ""} sur ${fields.length} ont au moins une inclusion non établie. Aucune valeur n'est supposée : tant qu'ils restent inconnus, toute décision qui en dépend devra demander une validation humaine (US-003, pas encore implémenté).`, "");
  const byHow = new Map<string, MoneyField[]>();
  for (const m of open) byHow.set(m.toVerify ?? "", [...(byHow.get(m.toVerify ?? "") ?? []), m]);
  for (const [how, list] of byHow) out.push(`- ${how} — ${list.map((m) => "`" + m.id + "`").join(", ")}`);
  out.push("");
  return out.join("\n");
}
