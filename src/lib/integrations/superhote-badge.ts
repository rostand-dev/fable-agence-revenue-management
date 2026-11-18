/** État du badge SuperHote affiché dans l'en-tête de la fiche logement. */
export type SuperhoteBadge = { role: "sain" | "attention" | "neutre"; label: string } | null;

/**
 * Déduit le badge de la connexion SuperHote (`properties.superhote`).
 * null = pas de badge (logement de démonstration : aucune connexion réelle).
 */
export function superhoteBadge(sh: Record<string, any> | null | undefined, isDemo: boolean): SuperhoteBadge {
  if (isDemo) return null;
  if (sh?.rentalId) {
    return sh.lastSync?.ok === false
      ? { role: "attention", label: "SuperHote : lecture en échec" }
      : { role: "sain", label: "SuperHote connecté" };
  }
  if (sh?.apiKeyEnc) return { role: "attention", label: "Rattachement SuperHote à confirmer" };
  return { role: "neutre", label: "SuperHote non connecté" };
}
