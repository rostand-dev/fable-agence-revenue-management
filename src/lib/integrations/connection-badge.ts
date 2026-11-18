/** Badges de connexion SuperHote et PriceLabs affichés dans l'en-tête de la fiche logement : même logique, même vocabulaire. */
export type ConnectionBadge = { role: "sain" | "attention" | "neutre"; label: string } | null;
export type Integration = "superhote" | "pricelabs";
const NAME: Record<Integration, string> = { superhote: "SuperHote", pricelabs: "PriceLabs" };

/**
 * Déduit le badge d'une connexion (`properties.superhote` ou `properties.pricelabs`).
 * Le rattachement est `rentalId` (SuperHote) ou `listingId` (PriceLabs). null = pas de badge (logement de démonstration).
 * L'état n'est jamais porté par la couleur seule : le libellé dit toujours ce qui se passe.
 */
export function connectionBadge(kind: Integration, conn: Record<string, any> | null | undefined, isDemo: boolean): ConnectionBadge {
  if (isDemo) return null;
  const name = NAME[kind], linked = kind === "superhote" ? conn?.rentalId : conn?.listingId;
  if (linked) return conn?.lastSync?.ok === false ? { role: "attention", label: `${name} : lecture en échec` } : { role: "sain", label: `${name} connecté` };
  if (conn?.apiKeyEnc) return { role: "attention", label: `Rattachement ${name} à confirmer` };
  return { role: "neutre", label: `${name} non connecté` };
}
export const superhoteBadge = (sh: Record<string, any> | null | undefined, isDemo: boolean) => connectionBadge("superhote", sh, isDemo);
export const pricelabsBadge = (pl: Record<string, any> | null | undefined, isDemo: boolean) => connectionBadge("pricelabs", pl, isDemo);

/** Destination du badge : l'étape du parcours de création tant que le logement n'est pas lancé, sinon l'onglet de la fiche. */
export const badgeHref = (kind: Integration, propertyId: string, status: string) =>
  status === "ONBOARDING" ? `/logements/${propertyId}/creation?etape=${kind}` : `/logements/${propertyId}?tab=${kind}`;
