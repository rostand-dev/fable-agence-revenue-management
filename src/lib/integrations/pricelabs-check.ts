import { addDays, type ISODate } from "../dates";
import { PriceLabsError } from "./pricelabs";
import type { PlListing } from "./pricelabs-map";
import { mapMarket, mapPrices } from "./pricelabs-map";
import type { PriceLabsAdapterKind, PriceLabsPort } from "./pricelabs-port";

/**
 * Test de connexion PriceLabs (US-040) : vérifie, sans rien écrire ni enregistrer de snapshot, ce que la clé permet réellement de lire.
 * Le résultat dit, pour chaque lecture (annonces, prix, marché, réservations), si elle est disponible : c'est la « capacité » réelle
 * de ce compte, que les imports (US-041, US-042) respectent au lieu de la supposer. Module pur : il ne dépend que du port de lecture.
 */
export type CheckStatus = "OK" | "WARN" | "FAIL" | "SKIPPED";
export type CheckId = "key" | "listing" | "sync" | "prices" | "market" | "reservations";
export type ConnectionCheck = { id: CheckId; label: string; status: CheckStatus; detail: string };
export type PriceLabsCapabilityId = "listings" | "prices" | "market" | "reservations";
export type CapabilityState = "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN";
export type ConnectionReport = {
  at: string;
  adapter: PriceLabsAdapterKind;
  /**
   * Vrai quand l'essentiel fonctionne : clé acceptée, annonce présente et grille lisible. Marché et réservations n'en font pas partie (non bloquants).
   * `null` : la clé est valide mais aucune annonce n'est encore rattachée, donc il n'y a rien d'autre à vérifier (ce n'est pas un échec).
   */
  ok: boolean | null;
  checks: ConnectionCheck[];
  capabilities: Record<PriceLabsCapabilityId, CapabilityState>;
};

/** Seuls les messages rédigés pour l'utilisateur (PriceLabsError) sont conservés : jamais un message technique interne. */
const msg = (e: unknown) => (e instanceof PriceLabsError ? e.message : "Erreur technique pendant le test.");
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

export async function runConnectionCheck(port: PriceLabsPort, target: { listingId: string; pms: string } | null, now: Date, today: ISODate): Promise<ConnectionReport> {
  const checks: ConnectionCheck[] = [];
  const add = (id: CheckId, label: string, status: CheckStatus, detail: string) => { checks.push({ id, label, status, detail }); return status; };
  const skipFrom = (ids: [CheckId, string][], why: string) => ids.forEach(([id, label]) => add(id, label, "SKIPPED", why));
  const LATER: [CheckId, string][] = [["listing", "Annonce rattachée"], ["sync", "Synchronisation PriceLabs"], ["prices", "Grille de prix"], ["market", "Marché"], ["reservations", "Réservations"]];

  let listings: PlListing[] = [];
  try {
    listings = await port.listListings();
    add("key", "Clé API", "OK", `Acceptée par PriceLabs · ${plural(listings.length, "annonce", "annonces")} sur ce compte.`);
  } catch (e) {
    add("key", "Clé API", "FAIL", msg(e));
    skipFrom(LATER, "Non vérifié : la clé n'est pas acceptée.");
    return finish(port, now, checks);
  }
  if (!target) { skipFrom(LATER, "Non vérifié : aucune annonce n'est rattachée à ce logement."); return finish(port, now, checks, false); }

  const listing = listings.find((l) => l.id === target.listingId && l.pms === target.pms);
  if (!listing) {
    add("listing", "Annonce rattachée", "FAIL", "L'annonce rattachée n'existe plus sur ce compte PriceLabs : détachez-la et choisissez-en une autre.");
    skipFrom(LATER.slice(1), "Non vérifié : l'annonce est introuvable.");
    return finish(port, now, checks);
  }
  add("listing", "Annonce rattachée", "OK", `${listing.name} · ${listing.pms}${listing.city ? " · " + listing.city : ""}.`);
  add("sync", "Synchronisation PriceLabs", listing.pushEnabled === false ? "WARN" : listing.pushEnabled === true ? "OK" : "WARN",
    listing.pushEnabled === false ? "Désactivée dans PriceLabs : les prix lus ne sont peut-être pas ceux publiés sur vos canaux." : listing.pushEnabled === true ? "Active." : "PriceLabs ne l'indique pas.");

  let days: ReturnType<typeof mapPrices> = [];
  try {
    days = mapPrices(await port.getPrices(listing.id, listing.pms, today, addDays(today, 6)));
    if (days.length === 0) add("prices", "Grille de prix", "FAIL", "PriceLabs n'a renvoyé aucun prix pour les 7 prochains jours.");
    else add("prices", "Grille de prix", "OK", `${plural(days.length, "jour lu", "jours lus")} sur l'essai de 7 jours.`);
  } catch (e) { add("prices", "Grille de prix", "FAIL", msg(e)); }

  try {
    const data = await port.getNeighborhood(listing.id, listing.pms);
    if (!data) add("market", "Marché", "WARN", "PriceLabs ne renvoie pas de données de marché pour cette annonce.");
    else {
      const m = mapMarket(data, listing.bedrooms, days);
      if (!m.category) add("market", "Marché", "WARN", "Données de marché sans catégorie exploitable.");
      else add("market", "Marché", "OK", `Catégorie ${m.category === "-1" ? "chambre" : m.category + " chambre(s)"} · ${m.listingsUsed ?? "?"} annonces comparables.`);
    }
  } catch (e) { add("market", "Marché", "WARN", `${msg(e)} Non bloquant : les signaux de marché restent inconnus.`); }

  try {
    const rows = await port.getReservations(listing.id, listing.pms, addDays(today, -30), addDays(today, 30));
    add("reservations", "Réservations", "OK", `${plural(rows.length, "réservation", "réservations")} sur l'essai de 60 jours.`);
  } catch (e) { add("reservations", "Réservations", "WARN", `${msg(e)} Non bloquant : SuperHote fait foi pour les réservations.`); }
  return finish(port, now, checks);
}

function finish(port: PriceLabsPort, now: Date, checks: ConnectionCheck[], hasTarget = true): ConnectionReport {
  const st = (id: CheckId) => checks.find((c) => c.id === id)?.status;
  const cap = (id: CheckId, ok: CheckStatus[] = ["OK"]): CapabilityState => { const s = st(id); return !s || s === "SKIPPED" ? "UNKNOWN" : ok.includes(s) ? "AVAILABLE" : "UNAVAILABLE"; };
  return {
    at: now.toISOString(), adapter: port.adapter, checks,
    ok: st("key") === "OK" && st("listing") === "SKIPPED" && !hasTarget ? null : st("key") === "OK" && st("listing") === "OK" && st("prices") === "OK",
    capabilities: { listings: cap("key"), prices: cap("prices"), market: cap("market"), reservations: cap("reservations") },
  };
}

/**
 * Ce qui a changé dans l'annonce rattachée depuis la dernière lecture (nom, ville, chambres). Un changement n'est jamais silencieux :
 * il est journalisé et signalé dans la dernière lecture, pour que la correspondance avec le logement soit revérifiée. `prev` absent = première lecture, rien à comparer.
 */
export type ListingSnapshot = { name: string | null; city: string | null; bedrooms: number | null };
export function listingDrift(prev: ListingSnapshot | null | undefined, cur: Pick<PlListing, "name" | "city" | "bedrooms">): string[] {
  if (!prev) return [];
  const out: string[] = [];
  const show = (v: unknown) => (v === null || v === undefined || v === "" ? "inconnu" : String(v));
  if ((prev.name ?? null) !== (cur.name ?? null) && prev.name !== null) out.push(`Nom : ${show(prev.name)} → ${show(cur.name)}`);
  if ((prev.city ?? null) !== (cur.city ?? null)) out.push(`Ville : ${show(prev.city)} → ${show(cur.city)}`);
  if ((prev.bedrooms ?? null) !== (cur.bedrooms ?? null)) out.push(`Chambres : ${show(prev.bedrooms)} → ${show(cur.bedrooms)}`);
  return out;
}
