/**
 * Drapeaux de fonctionnalité par propriétaire, logement et intégration (US-013, blueprint E1).
 *
 * Principe : un drapeau ne sert qu'à RESTREINDRE. Tout est actif par défaut ; couper un niveau (propriétaire, logement ou
 * intégration) coupe la fonction pour tout ce qu'il contient, et aucun niveau plus fin ne peut la rétablir. On ne peut donc
 * jamais, par un réglage, rendre possible ce que le code, le coupe-circuit ou les capacités d'une intégration interdisent.
 * Module pur (aucun accès base) : testable et partagé par le service, le planificateur, l'exécution et l'interface.
 */
export type FlagScope = "TENANT" | "PROPERTY" | "INTEGRATION";
export const FLAG_SCOPES: FlagScope[] = ["TENANT", "PROPERTY", "INTEGRATION"];

/** Intégrations qui ont des lectures ou une écriture automatiques : seules à pouvoir être coupées */
export const FLAG_PROVIDERS = ["pricelabs", "superhote"] as const;

export type FlagId = "write.api" | "sync.scheduled" | "review.scheduled";
export type FlagDef = {
  id: FlagId;
  label: string;
  /** Ce que couper veut dire, en une phrase */
  effect: string;
  scopes: FlagScope[];
};

export const FLAGS: FlagDef[] = [
  { id: "write.api", label: "Écriture automatique par API", scopes: ["TENANT", "PROPERTY", "INTEGRATION"],
    effect: "Coupée, une action approuvée ne peut plus s'exécuter par API : la procédure manuelle guidée reste possible et l'auditeur n'en propose plus." },
  { id: "sync.scheduled", label: "Lectures planifiées des intégrations", scopes: ["TENANT", "PROPERTY", "INTEGRATION"],
    effect: "Coupée, le planificateur ne relit plus les réservations, les prix et le marché ; vos données restent telles qu'à la dernière lecture." },
  { id: "review.scheduled", label: "Revue quotidienne automatique", scopes: ["TENANT", "PROPERTY"],
    effect: "Coupée, plus de revue lancée par le planificateur ; vous pouvez toujours lancer une revue vous-même." },
];
export const flagDef = (id: string): FlagDef | undefined => FLAGS.find((f) => f.id === id);
export const isFlagId = (v: unknown): v is FlagId => typeof v === "string" && FLAGS.some((f) => f.id === v);
export const isFlagScope = (v: unknown): v is FlagScope => typeof v === "string" && (FLAG_SCOPES as string[]).includes(v);

/** Une ligne n'existe que pour un drapeau COUPÉ ou rétabli explicitement ; l'absence de ligne vaut « actif ». */
export type FlagRow = { flag: string; scope: FlagScope; scopeId: string; enabled: boolean };
/** `scopeId` du niveau propriétaire : le propriétaire est déjà porté par la ligne, aucun identifiant supplémentaire */
export const TENANT_SCOPE_ID = "";

export type FlagContext = { propertyId?: string | null; provider?: string | null };
export type FlagResolution = { enabled: boolean; /** niveau qui coupe, si coupé */ by: FlagScope | null; reason: string | null };

const SCOPE_NAME: Record<FlagScope, string> = { TENANT: "pour tout votre espace", PROPERTY: "sur ce logement", INTEGRATION: "sur cette intégration" };

/** Un seul niveau coupé suffit à couper : voir le principe ci-dessus. */
export function resolveFlag(flag: FlagId, rows: FlagRow[], ctx: FlagContext = {}): FlagResolution {
  const def = flagDef(flag);
  if (!def) return { enabled: false, by: null, reason: "Fonction inconnue : désactivée par précaution." };
  const off = rows.find((r) => r.flag === flag && !r.enabled && def.scopes.includes(r.scope) && (
    (r.scope === "TENANT" && r.scopeId === TENANT_SCOPE_ID) ||
    (r.scope === "PROPERTY" && !!ctx.propertyId && r.scopeId === ctx.propertyId) ||
    (r.scope === "INTEGRATION" && !!ctx.provider && r.scopeId === ctx.provider)));
  return off ? { enabled: false, by: off.scope, reason: `« ${def.label} » est désactivée ${SCOPE_NAME[off.scope]}.` } : { enabled: true, by: null, reason: null };
}
