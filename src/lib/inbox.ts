import { diffDays } from "@/lib/dates";
import type { Candidate } from "@/lib/engine/types";

/** Forme minimale d'une opportunité nécessaire au classement (indépendante de la base). */
export type InboxItem = {
  id: string; propertyId: string; playbook: string; status: string; veto: boolean; priority: number;
  stayFrom: string; stayTo: string; impactCents: number | null; candidates: unknown; selected: number;
};

export const STATUS_FILTERS = [["a-traiter", "À traiter"], ["garde-fous", "Garde-fous & vetos"], ["traitees", "Traitées"], ["toutes", "Toutes"]] as const;
export const URGENCY_FILTERS = [["", "Toutes urgences"], ["urgent", "Séjour en cours ou sous 14 jours"], ["veto", "Veto économique"], ["renforcee", "Validation renforcée"]] as const;
export const SORTS = [["priorite", "Priorité"], ["impact", "Impact net simulé"], ["sejour", "Séjour le plus proche"]] as const;
export const URGENT_DAYS = 14;

export type InboxQuery = { f: string; p: string; pb: string; u: string; s: string };
type Raw = Partial<Record<keyof InboxQuery, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/** Normalise les paramètres d'URL : toute valeur inconnue retombe sur la valeur par défaut, sans erreur. */
export function parseInboxQuery(raw: Raw, known: { propertyIds: string[]; playbooks: string[] }): InboxQuery {
  const pick = (v: string, allowed: readonly string[], d: string) => (allowed.includes(v) ? v : d);
  return {
    f: pick(one(raw.f), STATUS_FILTERS.map((x) => x[0]), "a-traiter"),
    p: pick(one(raw.p), known.propertyIds, ""),
    pb: pick(one(raw.pb), known.playbooks, ""),
    u: pick(one(raw.u), URGENCY_FILTERS.map((x) => x[0]).filter(Boolean), ""),
    s: pick(one(raw.s), SORTS.map((x) => x[0]), "priorite"),
  };
}

const cand = (o: InboxItem) => (o.candidates as Candidate[])[o.selected];
export const guarded = (o: InboxItem) => o.veto || (o.candidates as Candidate[]).some((c) => c.audit.verdict === "REJECT");
/** Même critère que le badge « Validation renforcée » de la carte : verdict NEEDS_HUMAN de l'option retenue. */
const reinforced = (o: InboxItem) => cand(o)?.audit.verdict === "NEEDS_HUMAN";
export const reinforcedNeeded = reinforced;
/** Urgent : séjour en cours ou à venir, dont le début tombe dans les 14 jours. Un séjour terminé n'est jamais urgent. */
export const urgent = (o: InboxItem, today: string) => diffDays(o.stayTo, today) >= 0 && diffDays(o.stayFrom, today) <= URGENT_DAYS;

/** Rang de priorité de chaque situation ouverte, calculé sur la liste complète : filtrer ne renumérote jamais. */
export function priorityRanks(all: InboxItem[]): Map<string, number> {
  return new Map(all.filter((o) => o.status === "OPEN").map((o, i) => [o.id, i + 1]));
}

/** `all` arrive déjà classé (veto, priorité). Retourne la liste affichée. */
export function applyInbox<T extends InboxItem>(all: T[], q: InboxQuery, today: string): T[] {
  const base = q.f === "garde-fous" ? all.filter((o) => o.status === "OPEN" && guarded(o)) : q.f === "traitees" ? all.filter((o) => o.status !== "OPEN") : q.f === "toutes" ? all : all.filter((o) => o.status === "OPEN");
  const out = base.filter((o) => (!q.p || o.propertyId === q.p) && (!q.pb || o.playbook === q.pb)
    && (q.u === "" || (q.u === "urgent" ? urgent(o, today) : q.u === "veto" ? o.veto : reinforced(o))));
  // tris stables (Array.sort l'est) : à égalité, l'ordre de priorité d'origine est conservé
  if (q.s === "impact") return [...out].sort((a, b) => (a.impactCents === null ? 1 : 0) - (b.impactCents === null ? 1 : 0) || (a.impactCents === null || b.impactCents === null ? 0 : b.impactCents - a.impactCents));
  if (q.s === "sejour") {
    const past = (o: T) => (diffDays(o.stayTo, today) < 0 ? 1 : 0); // séjours terminés en dernier
    return [...out].sort((a, b) => past(a) - past(b) || a.stayFrom.localeCompare(b.stayFrom));
  }
  return out;
}

/** Nombre de filtres actifs hors statut et tri (pour le compteur et le bouton « Réinitialiser »). */
export const activeFilters = (q: InboxQuery) => [q.p, q.pb, q.u].filter(Boolean).length + (q.f !== "a-traiter" ? 1 : 0) + (q.s !== "priorite" ? 1 : 0);

export function inboxHref(q: InboxQuery, patch: Partial<InboxQuery>): string {
  const n = { ...q, ...patch };
  const sp = new URLSearchParams();
  if (n.f !== "a-traiter") sp.set("f", n.f);
  for (const k of ["p", "pb", "u"] as const) if (n[k]) sp.set(k, n[k]);
  if (n.s !== "priorite") sp.set("s", n.s);
  const s = sp.toString();
  return s ? `/?${s}` : "/";
}
