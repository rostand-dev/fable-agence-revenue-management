/**
 * Livre de prix en vigueur (dernier instantané VALIDATED de chaque modèle) et coût d'un appel tracé par la passerelle.
 * Le coût n'est jamais inventé : un modèle sans prix validé, ou des jetons inconnus, donnent null.
 */
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { computeCostUsd, roundUsd, type PriceEntry } from "./prices";

export type PriceBookEntry = { snapshotId: string; price: PriceEntry };
export type PriceBook = Map<string, PriceBookEntry>;

type Snap = typeof schema.llmPriceSnapshots.$inferSelect;
export function snapshotToPrice(s: Pick<Snap, "inputUsdPerMtok" | "outputUsdPerMtok" | "longThresholdTokens" | "longInputUsdPerMtok" | "longOutputUsdPerMtok">): PriceEntry {
  const long = s.longThresholdTokens !== null && s.longInputUsdPerMtok !== null && s.longOutputUsdPerMtok !== null ? { thresholdTokens: s.longThresholdTokens, inputPerMtok: Number(s.longInputUsdPerMtok), outputPerMtok: Number(s.longOutputUsdPerMtok) } : null;
  return { inputPerMtok: Number(s.inputUsdPerMtok), outputPerMtok: Number(s.outputUsdPerMtok), long };
}

/** Dernier prix validé de chaque modèle. */
export async function loadPriceBook(): Promise<PriceBook> {
  const rows = await db.select().from(schema.llmPriceSnapshots).where(eq(schema.llmPriceSnapshots.status, "VALIDATED"))
    .orderBy(desc(schema.llmPriceSnapshots.observedAt), desc(schema.llmPriceSnapshots.id));
  const book: PriceBook = new Map();
  for (const r of rows) if (!book.has(r.modelId)) book.set(r.modelId, { snapshotId: r.id, price: snapshotToPrice(r) });
  return book;
}

let cached: { at: number; book: PriceBook } | null = null;
const TTL_MS = 5 * 60_000;
export const invalidatePriceBook = () => { cached = null; };

/** Livre de prix mis en cache 5 minutes. Une base indisponible donne un livre vide (coûts inconnus) : la trace d'un appel ne doit jamais le faire échouer. */
export async function getPriceBook(): Promise<PriceBook> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.book;
  try { const book = await loadPriceBook(); cached = { at: Date.now(), book }; return book; } catch { return new Map(); }
}

export type TriedCost = { model: string; outcome: string; inputTokens?: number; outputTokens?: number };

/**
 * Coût réel d'un appel : somme des essais facturables (corrections et replis compris), chacun au prix de son modèle.
 * Un essai en panne du fournisseur n'a pas de réponse donc pas de coût. null si aucun essai facturable, ou si l'un d'eux n'a ni prix ni jetons connus.
 */
export function costOfTried(tried: readonly TriedCost[], book: PriceBook): { costUsd: number | null; snapshotId: string | null } {
  const billable = tried.filter((t) => t.outcome !== "PROVIDER_ERROR");
  if (billable.length === 0) return { costUsd: null, snapshotId: null };
  let total = 0;
  for (const t of billable) {
    const c = computeCostUsd(book.get(t.model)?.price, t.inputTokens, t.outputTokens);
    if (c === null) return { costUsd: null, snapshotId: null };
    total += c;
  }
  const last = billable[billable.length - 1];
  return { costUsd: roundUsd(total), snapshotId: book.get(last.model)?.snapshotId ?? null };
}
