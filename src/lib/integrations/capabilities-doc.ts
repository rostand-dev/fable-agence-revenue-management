import { AVAILABILITY, CAPABILITIES, PROVIDERS, PROVIDER_INFO, type Availability, type CapabilityDef } from "./capabilities";

const BUILT: Record<CapabilityDef["built"], string> = { REAL: "oui, sur logement réel", DEMO_ONLY: "simulée sur la démonstration seulement", NONE: "non" };
const BLOCKER = { PARTNER_ACCESS: "accès partenaire non obtenu", POLICY: "exclue par les conditions du canal" } as const;
const cell = (s: string) => s.replace(/\|/g, "\\|");

/** Document `docs/capacites-integrations.md`, généré depuis le catalogue : ne pas le modifier à la main. */
export function renderCapabilitiesMarkdown(): string {
  const out: string[] = [];
  out.push("# Capacités réelles des intégrations", "");
  out.push("> Document généré par `npm run docs:capabilities` depuis `src/lib/integrations/capabilities.ts`. Ne pas le modifier à la main : un test échoue s'il diverge du code.", "");
  out.push("US-002 · blueprint §4.2. Le catalogue décrit ce que le **code** sait faire aujourd'hui, pas ce qu'une configuration affirme. Une écriture non développée est impossible : refusée côté serveur (`execute()` dans `services/decisions.ts`), rejetée par l'auditeur (règle `CAPABILITY`), et bouton désactivé dans la fiche du dossier.", "");
  out.push("## Règles", "");
  out.push("- **Lecture seule par défaut** : aucun client du code n'écrit chez un fournisseur. Un test le vérifie (aucune méthode PUT, PATCH, DELETE ; le seul POST de PriceLabs lit la grille).");
  out.push("- **Démonstration** : l'écriture PriceLabs est simulée sur les logements de démonstration. Sur un logement réel, l'option est proposée en procédure manuelle guidée.");
  out.push("- **Coupe-circuit** : par fournisseur ; bloque toute exécution vers lui, immédiatement. Les lectures continuent.");
  out.push("- **Déduit des logements** : le statut d'un fournisseur et le nombre de logements branchés viennent des rattachements réels (`listingId` PriceLabs, `rentalId` SuperHote), jamais d'une ligne de configuration.", "");
  out.push("## États affichés", "");
  out.push("| État | Sens |", "|---|---|");
  const sens: Record<Availability, string> = {
    AVAILABLE: "développée et branchée sur au moins un logement réel",
    SIMULATED: "démonstration uniquement : rien n'est lu ni écrit chez le fournisseur",
    NEEDS_CONNECTION: "développée, mais aucun logement réel n'est branché",
    NOT_BUILT: "non développée dans cette version",
    NEEDS_ACCESS: "non développée, et dépend d'un accès partenaire non obtenu",
    FORBIDDEN: "exclue : les conditions du canal l'interdisent",
  };
  for (const a of Object.keys(AVAILABILITY) as Availability[]) out.push(`| ${AVAILABILITY[a].label} | ${sens[a]} |`);
  out.push("");
  for (const p of PROVIDERS) {
    const i = PROVIDER_INFO[p];
    out.push(`## ${i.name}`, "", `${i.role}.`, "");
    out.push("| Capacité | Identifiant | Nature | Développée | Raison |", "|---|---|---|---|---|");
    for (const c of CAPABILITIES.filter((x) => x.provider === p)) {
      out.push(`| ${cell(c.label)} | \`${c.id}\` | ${c.kind === "write" ? "écriture" : "lecture"} | ${BUILT[c.built]}${c.blocker ? ` (${BLOCKER[c.blocker]})` : ""} | ${cell(c.detail)} |`);
    }
    out.push("", `Suite : ${i.next}`, "");
  }
  return out.join("\n");
}
