/**
 * Prix des modèles : lecture du fichier communautaire LiteLLM, surcharges, détection de changement, calcul du coût.
 * Tout est pur (aucun réseau, aucune base) : le job de synchronisation (sync.ts) fait les entrées-sorties.
 * Règle : un modèle sans prix connu n'est jamais routé automatiquement, et un coût n'est jamais inventé (null).
 */
import { z } from "zod";
import { CATALOG, type CatalogModel } from "./catalog";

/** Prix en USD par million de jetons. `long` : palier de prompt long, appliqué à toute la requête quand l'entrée le dépasse. */
export type PriceEntry = {
  inputPerMtok: number;
  outputPerMtok: number;
  long: { thresholdTokens: number; inputPerMtok: number; outputPerMtok: number } | null;
};
export type ModelFacts = { price: PriceEntry; supportsJson: boolean | null; maxInputTokens: number | null; maxOutputTokens: number | null };

/** Dollars par jeton → dollars par million, sans bruit de virgule flottante (1e-7 × 1e6 = 0,1 et non 0,09999999999999999). */
const perMtok = (perToken: number): number => Number((perToken * 1e6).toPrecision(9));
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** Un modèle du fichier LiteLLM → faits utiles, ou null si le prix d'entrée ou de sortie manque. Seul le palier standard (« above_Nk_tokens » sans suffixe batch, flex, priority…) est lu. */
export function readLitellmEntry(raw: unknown): ModelFacts | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const inp = num(e.input_cost_per_token), out = num(e.output_cost_per_token);
  if (inp === null || out === null) return null;
  let long: PriceEntry["long"] = null;
  for (const k of Object.keys(e)) {
    const m = /^input_cost_per_token_above_(\d+)k_tokens$/.exec(k);
    if (!m) continue;
    const lo = num(e[`output_cost_per_token_above_${m[1]}k_tokens`]), li = num(e[k]);
    if (li === null || lo === null) continue;
    const threshold = Number(m[1]) * 1000;
    if (!long || threshold < long.thresholdTokens) long = { thresholdTokens: threshold, inputPerMtok: perMtok(li), outputPerMtok: perMtok(lo) };
  }
  return {
    price: { inputPerMtok: perMtok(inp), outputPerMtok: perMtok(out), long },
    supportsJson: typeof e.supports_response_schema === "boolean" ? e.supports_response_schema : null,
    maxInputTokens: num(e.max_input_tokens), maxOutputTokens: num(e.max_output_tokens),
  };
}

/** Faits des modèles du catalogue trouvés dans le fichier LiteLLM (document JSON déjà décodé). Un modèle absent n'a pas d'entrée. */
export function parseLitellmPrices(doc: unknown, catalog: readonly CatalogModel[] = CATALOG): Map<string, ModelFacts> {
  const out = new Map<string, ModelFacts>();
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return out;
  const d = doc as Record<string, unknown>;
  for (const m of catalog) {
    const f = readLitellmEntry(d[m.priceKey]);
    if (f) out.set(m.modelId, f);
  }
  return out;
}

const overrideSchema = z.record(z.string(), z.object({
  input: z.number().min(0).max(10000), output: z.number().min(0).max(10000),
  longThresholdTokens: z.number().int().min(1).optional(), longInput: z.number().min(0).max(10000).optional(), longOutput: z.number().min(0).max(10000).optional(),
}).strict());

/**
 * Surcharges de prix (variable LLM_PRICE_OVERRIDES) : JSON `{"<modèle>": {"input": 1, "output": 5}}`, en USD par million de jetons ; palier long facultatif.
 * Valeur vide ou `{}` = aucune. JSON invalide : aucune surcharge n'est appliquée et l'erreur est remontée (jamais de prix deviné).
 */
export function parsePriceOverrides(raw: string | undefined): { overrides: Map<string, PriceEntry>; error: string | null } {
  const overrides = new Map<string, PriceEntry>();
  if (!raw || !raw.trim()) return { overrides, error: null };
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return { overrides, error: "LLM_PRICE_OVERRIDES n'est pas un JSON valide : aucune surcharge appliquée." }; }
  const v = overrideSchema.safeParse(json);
  if (!v.success) return { overrides, error: "LLM_PRICE_OVERRIDES a un format incorrect (attendu : {\"modèle\": {\"input\": 1, \"output\": 5}}) : aucune surcharge appliquée." };
  for (const [id, o] of Object.entries(v.data)) {
    const long = o.longThresholdTokens && o.longInput !== undefined && o.longOutput !== undefined ? { thresholdTokens: o.longThresholdTokens, inputPerMtok: o.longInput, outputPerMtok: o.longOutput } : null;
    overrides.set(id, { inputPerMtok: o.input, outputPerMtok: o.output, long });
  }
  return { overrides, error: null };
}

const same = (a: number | null | undefined, b: number | null | undefined) => (a ?? null) === (b ?? null);
export function samePrice(a: PriceEntry, b: PriceEntry): boolean {
  return same(a.inputPerMtok, b.inputPerMtok) && same(a.outputPerMtok, b.outputPerMtok)
    && same(a.long?.thresholdTokens, b.long?.thresholdTokens) && same(a.long?.inputPerMtok, b.long?.inputPerMtok) && same(a.long?.outputPerMtok, b.long?.outputPerMtok);
}

/** Décision pour un prix observé face au dernier prix validé : première observation → enregistrer ; identique → rien ; différent → signaler « prix à vérifier ». */
export type PriceDecision = "RECORD" | "KEEP" | "FLAG";
export function decidePrice(validated: PriceEntry | null, observed: PriceEntry): PriceDecision {
  if (!validated) return "RECORD";
  return samePrice(validated, observed) ? "KEEP" : "FLAG";
}

/** Coût en USD d'un appel (ou d'un ensemble d'essais d'un même modèle). `null` si le prix est inconnu ou si les jetons manquent : jamais de chiffre inventé. */
export function computeCostUsd(price: PriceEntry | null | undefined, inputTokens: number | null | undefined, outputTokens: number | null | undefined): number | null {
  if (!price || inputTokens == null || outputTokens == null || inputTokens < 0 || outputTokens < 0) return null;
  const p = price.long && inputTokens > price.long.thresholdTokens ? price.long : price;
  return (inputTokens * p.inputPerMtok + outputTokens * p.outputPerMtok) / 1e6;
}

/** Arrondi stable pour le stockage (numeric(14,6)). */
export const roundUsd = (v: number): number => Math.round(v * 1e6) / 1e6;
