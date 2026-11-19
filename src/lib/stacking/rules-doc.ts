import { CHANNEL_LABEL, type Channel } from "../engine/types";
import { RULES_CHECKED_AT, SOURCES, STACK_STATUS, kindsOf, matrix, promoKind } from "./rules";

const cell = (s: string) => s.replace(/\|/g, "\\|");
const CHANNELS_DOC: Channel[] = ["BOOKING", "AIRBNB"];

/** Document `docs/regles-de-cumul.md`, généré depuis le registre : ne pas le modifier à la main. */
export function renderStackingMarkdown(): string {
  const out: string[] = [];
  out.push("# Règles de cumul des promotions", "");
  out.push("> Document généré par `npm run docs:stacking` depuis `src/lib/stacking/rules.ts`. Ne pas le modifier à la main : un test échoue s'il diverge du code.", "");
  out.push("US-003 · blueprint §10.4. Deux promotions d'un même canal, valables sur les mêmes nuits, se cumulent-elles ? Trois réponses : **Cumulables**, **Une seule s'applique**, **Inconnue**.", "");
  out.push("## Règles", "");
  out.push("- **Une règle inconnue n'est jamais devinée.** Toute option qui s'appuie sur un cumul inconnu reçoit le verdict `NEEDS_HUMAN` (règle d'audit `STACK_RULES`, `src/lib/engine/audit.ts`) : validation commentée obligatoire.");
  out.push("- **Sources** : seules les aides officielles des canaux établissent une règle. Les blogs et les channel managers n'ont pas valeur de preuve : sans source officielle, la règle reste inconnue.");
  out.push("- **Quelles options sont contrôlées** : celles qui ajoutent une remise ou baissent le prix, seules à pouvoir creuser la remise réelle sous celle qui a été simulée. Relever un prix, retirer une promotion, changer un séjour minimum ou ne rien faire ne sont pas critiques.");
  out.push("- **Qui est en jeu** : les promotions du registre du logement, sur le même canal, dont les dates de séjour recoupent les nuits visées par l'option, plus la promotion proposée. Une promotion sans date est permanente.");
  out.push("- **Un registre non vérifié depuis plus de 7 jours** rend aussi le contrôle incertain : l'option est soumise à validation. Un prix PriceLabs est contrôlé sur chaque canal du logement.");
  out.push("- **Un type de promotion absent du registre** rend la règle inconnue.");
  out.push("- **Le cumul déjà en place** n'est pas bloqué par ce contrôle : il est signalé par le playbook PB-05, et un registre périmé par `PROMO_FRESHNESS`.");
  out.push("- **Une règle exclusive** n'est pas un blocage : le simulateur retient le cumul, hypothèse prudente pour le plancher. La mention rappelle que l'effet réel de la seconde promotion peut être nul.");
  out.push("- **Un rejet l'emporte** : sous le plancher absolu ou au-delà du plafond de cumul, l'option reste rejetée, quelle que soit la règle de cumul.");
  out.push(`- **Relecture des sources** : ${RULES_CHECKED_AT}. À refaire quand un canal change ses règles.`, "");
  out.push("## Sources officielles", "");
  out.push("| Source | Adresse | Consultée le | Remarque |", "|---|---|---|---|");
  for (const s of Object.values(SOURCES)) out.push(`| ${cell(s.label)} | ${s.url} | ${s.checkedAt} | ${cell(s.note)} |`);
  out.push("");
  for (const ch of CHANNELS_DOC) {
    out.push(`## ${CHANNEL_LABEL[ch]}`, "");
    out.push("Types de promotion connus : " + kindsOf(ch).map((k) => `\`${k.kind}\` (${k.label})`).join(", ") + ".", "");
    out.push("| Promotion A | Promotion B | Règle | Source | Détail |", "|---|---|---|---|---|");
    for (const r of matrix(ch)) {
      out.push(`| ${promoKind(ch, r.a)!.label} | ${promoKind(ch, r.b)!.label} | ${STACK_STATUS[r.status].label} | ${r.source ? r.source.id : "—"} | ${cell(r.detail)} |`);
    }
    out.push("");
  }
  return out.join("\n");
}
