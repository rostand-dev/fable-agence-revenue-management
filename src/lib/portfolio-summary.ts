import { monthlyKpis } from "@/lib/engine/metrics";
import type { Resa } from "@/lib/engine/types";
import { reinforcedNeeded, urgent, guarded, type InboxItem } from "@/lib/inbox";

export type PropertyLite = { id: string; name: string; status: string; isDemo: boolean };
export type ActionLite = { status: string; opportunityId: string };

export type PropertyRow = { id: string; name: string; status: string; isDemo: boolean; open: number; vetoes: number; urgent: number };
export type PortfolioSummary = {
  properties: number;
  /** logements réellement observés (hors saisie en cours) */
  active: number;
  open: number; vetoes: number; urgent: number; reinforced: number; guarded: number;
  /** Actions du circuit qui attendent quelqu'un : à exécuter (approuvées), à vérifier (exécutées), en échec. */
  actions: { toExecute: number; toVerify: number; failed: number };
  rows: PropertyRow[];
};

/** Agrège le portefeuille. Les dossiers ouverts sont supposés classés par priorité (`rows` garde l'ordre des logements, puis tri par veto et dossiers). */
export function summarizePortfolio(props: PropertyLite[], opps: InboxItem[], actions: ActionLite[], today: string): PortfolioSummary {
  const open = opps.filter((o) => o.status === "OPEN");
  const known = new Set(props.map((p) => p.id));
  const mine = open.filter((o) => known.has(o.propertyId)); // jamais de dossier orphelin dans les totaux
  const rows = props.map((p) => {
    const os = mine.filter((o) => o.propertyId === p.id);
    return { id: p.id, name: p.name, status: p.status, isDemo: p.isDemo, open: os.length, vetoes: os.filter((o) => o.veto).length, urgent: os.filter((o) => urgent(o, today)).length };
  }).sort((a, b) => b.vetoes - a.vetoes || b.urgent - a.urgent || b.open - a.open || a.name.localeCompare(b.name, "fr"));
  const n = (s: string) => actions.filter((a) => a.status === s).length;
  return {
    properties: props.length, active: props.filter((p) => p.status !== "ONBOARDING").length,
    open: mine.length, vetoes: mine.filter((o) => o.veto).length, urgent: mine.filter((o) => urgent(o, today)).length,
    reinforced: mine.filter(reinforcedNeeded).length, guarded: mine.filter(guarded).length,
    actions: { toExecute: n("APPROVED"), toVerify: n("EXECUTED"), failed: n("FAILED") },
    rows,
  };
}

export type Occupancy = { nights: number; available: number; rate: number | null; properties: number };
/**
 * Occupation des mois donnés, logement par logement (les nuits bloquées d'un logement ne retirent rien aux autres), puis sommée.
 * Les logements en saisie sont exclus ; un logement sans aucune réservation lue n'a pas d'historique : il n'entre pas
 * (sinon ses nuits « disponibles » feraient passer l'inconnu pour 0 %). Aucun logement avec historique : rate = null.
 */
export function portfolioOccupation(props: PropertyLite[], resas: (Resa & { propertyId: string })[], months: string[]): Occupancy {
  let nights = 0, available = 0, n = 0;
  for (const p of props) {
    if (p.status === "ONBOARDING") continue;
    const mine = resas.filter((r) => r.propertyId === p.id);
    if (mine.length === 0) continue;
    const k = monthlyKpis(mine, months);
    nights += k.reduce((a, m) => a + m.nights, 0); available += k.reduce((a, m) => a + m.available, 0); n++;
  }
  return { nights, available, rate: available > 0 ? nights / available : null, properties: n };
}
