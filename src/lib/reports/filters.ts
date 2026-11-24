/** Filtres de l'historique (US-113) : lus dans l'adresse, validés, une valeur invalide est ignorée (jamais une erreur d'écran). Module pur. */
import { OUTCOMES, type Outcome } from "../experiments/outcome";

export type HistoryFilters = { etat: "CERTIFIED" | "DRAFT" | null; annee: string | null; resultat: Outcome | null };
const one = (v: string | string[] | undefined | null) => (Array.isArray(v) ? v[0] : v) ?? null;

export function parseHistoryFilters(q: Record<string, string | string[] | undefined> | URLSearchParams): HistoryFilters {
  const get = (k: string) => (q instanceof URLSearchParams ? q.get(k) : one(q[k]));
  const etat = get("etat"), annee = get("annee"), resultat = get("resultat");
  return {
    etat: etat === "CERTIFIED" || etat === "DRAFT" ? etat : null,
    annee: annee && /^(19|20)\d{2}$/.test(annee) ? annee : null,
    resultat: resultat && (OUTCOMES as readonly string[]).includes(resultat) ? (resultat as Outcome) : null,
  };
}
export const filtersQuery = (f: HistoryFilters): string => [f.etat && `etat=${f.etat}`, f.annee && `annee=${f.annee}`, f.resultat && `resultat=${f.resultat}`].filter(Boolean).join("&");
export const activeFilters = (f: HistoryFilters): number => [f.etat, f.annee, f.resultat].filter(Boolean).length;

/** Fragment de nom de fichier sûr : ASCII minuscule, tirets, 30 caractères au plus. */
export const slug = (t: string): string => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/, "") || "logement";
