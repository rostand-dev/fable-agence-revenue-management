/**
 * Types d'action qui s'écrivent par l'API PriceLabs sur un logement réel (épic 9). Module pur, sans dépendance : importé par le catalogue de capacités,
 * le moteur et l'interface (le reste de l'écriture, qui utilise `node:crypto` et le réseau, est dans `pricelabs-write.ts`).
 *
 * `MIN_STAY_OVERRIDE` n'y est pas : la documentation ne dit pas ce qu'une dérogation sans prix fait au prix déjà posé (l'exemple officiel envoie `price: "0"`) ;
 * écrire à l'aveugle pourrait publier un prix nul. Il reste une procédure manuelle guidée (et une simulation sur la démonstration).
 */
export const API_WRITE_TYPES = ["MIN_PRICE_CHANGE", "BASE_PRICE_CHANGE", "PRICE_OVERRIDE", "RULE_EXCLUSION"] as const;
export type ApiWriteType = (typeof API_WRITE_TYPES)[number];
export const isApiWriteType = (t: unknown): t is ApiWriteType => typeof t === "string" && (API_WRITE_TYPES as readonly string[]).includes(t);
/** Une action peut-elle s'écrire par API ? La démonstration simule tous les types ; un logement réel n'écrit que ceux de `API_WRITE_TYPES`. */
export const apiWriteSupports = (type: string | undefined | null, isDemo: boolean): boolean => isDemo || isApiWriteType(type);
