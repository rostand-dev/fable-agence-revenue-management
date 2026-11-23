import type { ISODate } from "../dates";

/**
 * Port d'ÉCRITURE PriceLabs (blueprint §13.3 `PricingProvider`, volet écriture ; épic 9). Distinct du port de lecture (`pricelabs-port.ts`),
 * qui ne contient volontairement aucune méthode d'écriture : un test, une CI ou un agent qui reçoit le port de lecture ne peut rien modifier.
 *
 * Deux adaptateurs : `HTTP` (l'API client PriceLabs, seul adaptateur de production) et `FAKE` (en mémoire, tests).
 * Chaque écriture pose une VALEUR ABSOLUE (jamais un delta) : la rejouer après un échec passager donne le même état.
 * Les montants du port sont en centimes ; la conversion vers la devise de l'annonce (euros décimaux) se fait dans l'adaptateur HTTP.
 */
export type PriceLabsWriteAdapterKind = "HTTP" | "FAKE";

/** Prix minimum, de base, maximum d'une annonce, en centimes. Un champ absent n'est pas modifié. */
export type ListingLimits = { minCents?: number; baseCents?: number; maxCents?: number };
/** Prix fixe posé sur une date. */
export type DatedPrice = { date: ISODate; priceCents: number };
/** Dérogation datée telle que PriceLabs la renvoie (relue pour vérifier ou pour restaurer). `raw` garde tous les champs, sauf les dates techniques. */
export type RemoteOverride = { date: ISODate; priceCents: number | null; priceType: string | null; minStay: number | null; raw: Record<string, unknown> };

/** Reçu d'une écriture : ce qui a été envoyé (empreinte, jamais la clé API) et ce que PriceLabs a répondu. */
export type WriteReceipt = {
  method: "POST" | "DELETE";
  /** Chemin appelé, sans l'hôte */
  endpoint: string;
  /** Statut HTTP de la réponse (200 ou 204) */
  status: number;
  sentAt: string;
  /** SHA-256 du corps envoyé (JSON canonique) : prouve ce qui est parti sans le conserver */
  requestHash: string;
  /** Résumé du corps envoyé : dates et montants, aucune donnée personnelle */
  summary: Record<string, unknown>;
  adapter: PriceLabsWriteAdapterKind;
};

export interface PriceLabsWritePort {
  readonly adapter: PriceLabsWriteAdapterKind;
  /** Pose le prix minimum, de base et/ou maximum de l'annonce (`POST /v1/listings`). */
  setListingLimits(id: string, pms: string, limits: ListingLimits): Promise<WriteReceipt>;
  /** Pose des prix fixes datés (`POST /v1/listings/{id}/overrides`). Tout ou rien côté PriceLabs. */
  setPriceOverrides(id: string, pms: string, items: DatedPrice[], opts: { currency: string | null; reason: string }): Promise<WriteReceipt>;
  /** Remet des dérogations relues telles quelles (retour arrière d'un prix daté qui en remplaçait un autre, US-093). */
  restoreOverrides(id: string, pms: string, previous: RemoteOverride[]): Promise<WriteReceipt>;
  /** Supprime les dérogations des dates données : PriceLabs reprend son calcul (`DELETE /v1/listings/{id}/overrides`). */
  deleteOverrides(id: string, pms: string, dates: ISODate[]): Promise<WriteReceipt>;
  /** Dérogations en vigueur sur [from, to] (`GET /v1/listings/{id}/overrides`). */
  getOverrides(id: string, pms: string, from: ISODate, to: ISODate): Promise<RemoteOverride[]>;
}

export type PriceLabsWriterFactory = (apiKey: string) => PriceLabsWritePort;
