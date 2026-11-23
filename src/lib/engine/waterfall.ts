import type { WaterfallStep } from "./types";

/**
 * Géométrie d'une cascade du revenu net (US-083). Pur : même étapes, mêmes barres.
 * Les totaux (prix publié, vendu, net, contribution) partent de zéro ; les mouvements (remises, commission, frais, coûts) flottent
 * entre le cumul avant et le cumul après. Les positions sont des pourcentages d'un axe commun qui englobe zéro.
 */
export type WaterfallRow = { key: string; label: string; source: string; cents: number; kind: "total" | "down" | "up" | "final"; from: number; to: number; leftPct: number; widthPct: number };
export type WaterfallGeometry = { rows: WaterfallRow[]; zeroPct: number; minCents: number; maxCents: number; closes: boolean };

const TOTALS = new Set(["published", "gross", "net"]);

/** Axe commun à plusieurs cascades (centimes) : deux barres de même longueur représentent alors le même montant. */
export type Axis = { min: number; max: number };
export function sharedAxis(all: WaterfallStep[][]): Axis {
  const g = all.map((s) => waterfallGeometry(s));
  return { min: Math.min(0, ...g.map((x) => x.minCents)), max: Math.max(0, ...g.map((x) => x.maxCents)) };
}

export function waterfallGeometry(steps: WaterfallStep[], axis?: Axis): WaterfallGeometry {
  let running = 0, closes = true;
  const raw = steps.map((s) => {
    const total = TOTALS.has(s.key) || s.kind === "net" || s.kind === "final";
    // un sous-total (vendu, net) ou la contribution doit être exactement le cumul des mouvements qui le précèdent
    if (total && s.key !== "published" && steps.indexOf(s) > 0 && running !== s.cents) closes = false;
    const from = total ? 0 : running, to = total ? s.cents : running + s.cents;
    running = total ? s.cents : to;
    const kind: WaterfallRow["kind"] = s.kind === "final" ? "final" : total ? "total" : s.cents < 0 ? "down" : "up";
    return { key: s.key, label: s.label, source: s.source, cents: s.cents, kind, from, to };
  });
  const points = raw.flatMap((r) => [r.from, r.to]).concat(0);
  const min = axis ? axis.min : Math.min(...points), max = axis ? axis.max : Math.max(...points), span = max - min || 1;
  const pos = (v: number) => ((v - min) / span) * 100;
  const rows = raw.map((r) => { const a = Math.min(r.from, r.to), b = Math.max(r.from, r.to); const width = Math.max(((b - a) / span) * 100, 0.6); return { ...r, widthPct: width, leftPct: Math.min(pos(a), 100 - width) }; });
  const last = raw[raw.length - 1];
  return { rows, zeroPct: pos(0), minCents: Math.min(...points), maxCents: Math.max(...points), closes: closes && !!last && last.kind === "final" };
}

/** Position (en % de l'axe) de repères exprimés dans la même unité, pour la jauge de plancher. */
export function gaugePositions(values: Record<string, number>): { min: number; max: number; pos: Record<string, number> } {
  const vs = Object.values(values);
  const lo = Math.min(...vs), hi = Math.max(...vs), pad = Math.max((hi - lo) * 0.15, 100);
  const min = lo - pad, max = hi + pad;
  return { min, max, pos: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, ((v - min) / (max - min)) * 100])) };
}
