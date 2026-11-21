import type { ISODate } from "../dates";
import type { PlListing } from "./pricelabs-map";

/**
 * Port de lecture PriceLabs (blueprint §13.3 `PricingProvider`, volet lecture ; §14 « adaptateurs fake/replay »).
 *
 * Trois adaptateurs l'implémentent :
 * - `HTTP`   : l'API client PriceLabs (https://api.pricelabs.co/v1), seul adaptateur utilisé en production ;
 * - `FAKE`   : jeu de données synthétique en mémoire (tests unitaires et d'intégration) ;
 * - `REPLAY` : réponses enregistrées, rejouées à l'identique (golden cases, tests de non-régression).
 *
 * Le port ne contient AUCUNE méthode d'écriture : un test, une CI ou un agent qui s'en sert ne peut pas modifier un prix chez PriceLabs.
 * (L'écriture, `pricelabs.write`, relève de l'épic 9 et d'un port distinct.)
 * Les réponses sont renvoyées dans la forme de l'API (le passage au modèle interne est fait par `pricelabs-map.ts`),
 * de sorte que le même code de traduction est exercé avec les trois adaptateurs.
 */
export type PriceLabsAdapterKind = "HTTP" | "FAKE" | "REPLAY";

export interface PriceLabsPort {
  readonly adapter: PriceLabsAdapterKind;
  /** Annonces du compte (id, PMS, nom, ville, chambres, min/base/max, synchronisation). */
  listListings(): Promise<PlListing[]>;
  /** Grille de prix d'une annonce sur [from, to] : l'élément de la réponse `listing_prices` correspondant. Lève `PriceLabsError`. */
  getPrices(id: string, pms: string, from: ISODate, to: ISODate): Promise<any>;
  /** Marché du voisinage (`data` de `neighborhood_data`), null si PriceLabs n'en renvoie pas. */
  getNeighborhood(id: string, pms: string): Promise<any>;
  /** Réservations par date d'arrivée sur [from, to], toutes pages. */
  getReservations(id: string, pms: string, from: ISODate, to: ISODate): Promise<any[]>;
}

export type PriceLabsPortFactory = (apiKey: string) => PriceLabsPort;
