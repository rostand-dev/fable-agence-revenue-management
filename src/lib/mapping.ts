/**
 * Mapping des identifiants externes d'un logement (US-021) : quel logement SuperHote, quelle annonce PriceLabs,
 * quelle annonce Airbnb / Booking correspondent à ce logement. Fonctions pures : la base n'est lue que par le service.
 *
 * Un mauvais rattachement fausse tout ce qui suit (prix, réservations, planchers) sans que rien ne plante :
 * le mapping est donc confirmé par une personne, et cette confirmation tombe dès qu'un identifiant change.
 */
export type MappingKey = "pricelabs" | "superhote" | "airbnb" | "booking";
export type MappingState = "ok" | "missing" | "warning";
export type MappingStatus = "INCOMPLETE" | "TO_CONFIRM" | "CONFIRMED" | "STALE";

export type MappingFacts = {
  property: { name: string; city: string; bedrooms: number | null; capacity: number | null };
  superhote: { rentalId: string; rentalName: string | null; city: string | null; capacity: number | null } | null;
  pricelabs: { listingId: string; pms: string | null; listingName: string | null; city: string | null; bedrooms: number | null } | null;
  /** Annonces actives du logement (US-020). */
  listings: { channel: string; externalId: string | null }[];
  confirmation: { fingerprint: string; at: string; by: string } | null;
};
export type MappingItem = { key: MappingKey; label: string; required: boolean; state: MappingState; detail: string; value: string | null; fix: "pricelabs" | "superhote" | "annonces" };
export type MappingCheck = { id: string; message: string };
export type MappingEvaluation = { items: MappingItem[]; checks: MappingCheck[]; status: MappingStatus; fingerprint: string; confirmable: boolean; missingRequired: MappingKey[] };

/** Sans accents ni casse ni ponctuation : « Évry-Courcouronnes » et « evry courcouronnes » désignent la même ville. */
export const normPlace = (s: string | null | undefined) => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const sameCity = (a: string | null, b: string | null) => {
  const x = normPlace(a), y = normPlace(b);
  if (!x || !y) return true; // inconnu : pas de contradiction
  return x === y || x.includes(y) || y.includes(x);
};

/** Empreinte des identifiants : change dès qu'un rattachement change. */
export function mappingFingerprint(f: Pick<MappingFacts, "superhote" | "pricelabs" | "listings">): string {
  const l = f.listings.filter((x) => x.externalId).map((x) => `${x.channel}:${x.externalId}`).sort().join(",");
  return [`sh:${f.superhote?.rentalId ?? "-"}`, `pl:${f.pricelabs ? `${f.pricelabs.listingId}|${f.pricelabs.pms ?? ""}` : "-"}`, `ls:${l || "-"}`].join(";");
}

export function evaluateMapping(f: MappingFacts): MappingEvaluation {
  const items: MappingItem[] = [];
  const pl = f.pricelabs, sh = f.superhote;
  items.push(pl
    ? { key: "pricelabs", label: "Annonce PriceLabs", required: true, state: "ok", detail: `${pl.listingName ?? "Annonce"} (${pl.listingId}${pl.pms ? ` · ${pl.pms}` : ""})`, value: pl.listingId, fix: "pricelabs" }
    : { key: "pricelabs", label: "Annonce PriceLabs", required: true, state: "missing", detail: "Aucune annonce PriceLabs rattachée : sans elle, ni calendrier ni prix à analyser.", value: null, fix: "pricelabs" });
  items.push(sh
    ? { key: "superhote", label: "Logement SuperHote", required: false, state: "ok", detail: `${sh.rentalName ?? "Logement"} (${sh.rentalId})`, value: sh.rentalId, fix: "superhote" }
    : { key: "superhote", label: "Logement SuperHote", required: false, state: "missing", detail: "Non rattaché : les réservations viennent alors de PriceLabs, moins fiables que SuperHote.", value: null, fix: "superhote" });
  for (const [key, channel, label] of [["airbnb", "AIRBNB", "Annonce Airbnb"], ["booking", "BOOKING", "Annonce Booking.com"]] as const) {
    const l = f.listings.find((x) => x.channel === channel);
    items.push(l?.externalId
      ? { key, label, required: false, state: "ok", detail: `Identifiant ${l.externalId}`, value: l.externalId, fix: "annonces" }
      : { key, label, required: false, state: "missing", detail: l ? "Annonce saisie sans identifiant." : "Pas encore renseignée : elle permet de vérifier la promotion ou le prix sur le bon canal.", value: null, fix: "annonces" });
  }

  const checks: MappingCheck[] = [];
  if (pl && !sameCity(f.property.city, pl.city)) checks.push({ id: "pl-city", message: `La ville de l'annonce PriceLabs (${pl.city}) ne correspond pas à celle du logement (${f.property.city}).` });
  if (pl && pl.bedrooms != null && f.property.bedrooms != null && pl.bedrooms !== f.property.bedrooms) checks.push({ id: "pl-bedrooms", message: `L'annonce PriceLabs compte ${pl.bedrooms} chambre${pl.bedrooms > 1 ? "s" : ""}, le logement en déclare ${f.property.bedrooms}.` });
  if (sh && !sameCity(f.property.city, sh.city)) checks.push({ id: "sh-city", message: `La ville du logement SuperHote (${sh.city}) ne correspond pas à celle du logement (${f.property.city}).` });
  if (sh && sh.capacity != null && f.property.capacity != null && sh.capacity !== f.property.capacity) checks.push({ id: "sh-capacity", message: `Le logement SuperHote accueille ${sh.capacity} personne${sh.capacity > 1 ? "s" : ""}, le logement en déclare ${f.property.capacity}.` });
  if (pl && sh && !sameCity(pl.city, sh.city)) checks.push({ id: "pl-sh-city", message: `PriceLabs (${pl.city}) et SuperHote (${sh.city}) ne situent pas le logement dans la même ville.` });
  const warned = new Set<MappingKey>();
  for (const c of checks) { if (c.id.startsWith("pl")) warned.add("pricelabs"); if (c.id.startsWith("sh") || c.id === "pl-sh-city") warned.add("superhote"); }
  for (const it of items) if (it.state === "ok" && warned.has(it.key)) it.state = "warning";

  const missingRequired = items.filter((i) => i.required && i.state === "missing").map((i) => i.key);
  const fingerprint = mappingFingerprint(f);
  const status: MappingStatus = missingRequired.length ? "INCOMPLETE" : !f.confirmation ? "TO_CONFIRM" : f.confirmation.fingerprint === fingerprint ? "CONFIRMED" : "STALE";
  return { items, checks, status, fingerprint, confirmable: missingRequired.length === 0, missingRequired };
}

export const MAPPING_STATUS_LABEL: Record<MappingStatus, string> = {
  INCOMPLETE: "Incomplet",
  TO_CONFIRM: "À confirmer",
  CONFIRMED: "Confirmé",
  STALE: "À reconfirmer (un identifiant a changé)",
};
