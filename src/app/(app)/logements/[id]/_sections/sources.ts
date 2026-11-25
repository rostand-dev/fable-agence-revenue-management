import type { Fiche } from "./context";

/** Promotion jamais vérifiée, ou vérifiée il y a plus de sept jours. */
export const promosToVerify = ({ input, now }: Pick<Fiche, "input" | "now">) => input.promos.some((x) => !x.verifiedAt || +now - +x.verifiedAt > 7 * 86400000);

/** Nombre de lignes « à revoir » du tableau de qualité des données (mêmes conditions que l'écran). */
export function sourcesToReview(f: Pick<Fiche, "input" | "now" | "miss" | "hasHistory" | "hasCal">) {
  return [!f.hasHistory, !f.hasCal, !f.input.days.some((d) => d.marketOccupancy !== null), promosToVerify(f), f.miss.length > 0].filter(Boolean).length;
}
