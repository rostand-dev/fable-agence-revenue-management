/**
 * Disponibilité des modèles : lecture des listes officielles des fournisseurs et règles d'exclusion.
 * Pur (aucun réseau, aucune base). Champs lus d'après les documentations officielles :
 *  - Anthropic GET /v1/models : id, lifecycle (active | deprecated | retired), deprecated_at, retires_at, max_input_tokens, max_tokens, capabilities.structured_outputs.supported ;
 *  - Mistral GET /v1/models : id, aliases, max_context_length, capabilities.completion_chat, archived (et deprecation si présent) ;
 *  - OpenAI GET /v1/models : identifiants seulement.
 */
import { CATALOG, isMovingAlias, type CatalogModel, type ProviderKey } from "./catalog";

export type Lifecycle = "UNKNOWN" | "ACTIVE" | "DEPRECATED" | "RETIRED" | "ABSENT";
export type ListedModel = { modelId: string; aliases: string[]; lifecycle: Exclude<Lifecycle, "UNKNOWN" | "ABSENT">; deprecatedAt: Date | null; retiresAt: Date | null; maxInputTokens: number | null; maxOutputTokens: number | null; supportsJson: boolean | null };

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null);
const date = (v: unknown): Date | null => { const s = str(v); if (!s) return null; const d = new Date(s); return Number.isNaN(+d) ? null : d; };

export function parseAnthropicList(data: unknown): ListedModel[] {
  const rows = (data as any)?.data;
  if (!Array.isArray(rows)) return [];
  const out: ListedModel[] = [];
  for (const m of rows) {
    const id = str(m?.id);
    if (!id) continue;
    const lc = str(m?.lifecycle);
    const lifecycle = lc === "deprecated" ? "DEPRECATED" : lc === "retired" ? "RETIRED" : "ACTIVE";
    const so = m?.capabilities?.structured_outputs?.supported;
    out.push({ modelId: id, aliases: [], lifecycle, deprecatedAt: date(m?.deprecated_at), retiresAt: date(m?.retires_at), maxInputTokens: int(m?.max_input_tokens), maxOutputTokens: int(m?.max_tokens), supportsJson: typeof so === "boolean" ? so : null });
  }
  return out;
}

export function parseOpenAiList(data: unknown): ListedModel[] {
  const rows = (data as any)?.data;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((m: any) => (str(m?.id) ? [{ modelId: m.id as string, aliases: [], lifecycle: "ACTIVE" as const, deprecatedAt: null, retiresAt: null, maxInputTokens: null, maxOutputTokens: null, supportsJson: null }] : []));
}

/** Mistral : la documentation montre tantôt `{data: [...]}` tantôt un tableau nu ; les deux sont lus. Un modèle sans `completion_chat` n'est pas utilisable ici. */
export function parseMistralList(data: unknown): ListedModel[] {
  const rows = Array.isArray(data) ? data : (data as any)?.data;
  if (!Array.isArray(rows)) return [];
  const out: ListedModel[] = [];
  for (const m of rows) {
    const id = str(m?.id);
    if (!id) continue;
    if (m?.capabilities && m.capabilities.completion_chat === false) continue;
    const deprecation = date(m?.deprecation), retirement = date(m?.retirement ?? m?.retires_at);
    const lifecycle = m?.archived === true ? "RETIRED" : deprecation ? "DEPRECATED" : "ACTIVE";
    out.push({ modelId: id, aliases: Array.isArray(m?.aliases) ? m.aliases.filter((a: unknown) => typeof a === "string") : [], lifecycle, deprecatedAt: deprecation, retiresAt: retirement, maxInputTokens: int(m?.max_context_length), maxOutputTokens: null, supportsJson: null });
  }
  return out;
}

export const PARSERS: Record<ProviderKey, (d: unknown) => ListedModel[]> = { anthropic: parseAnthropicList, openai: parseOpenAiList, mistral: parseMistralList };

export type AvailabilityUpdate = { modelId: string; lifecycle: Lifecycle; deprecatedAt: Date | null; retiresAt: Date | null; maxInputTokens: number | null; maxOutputTokens: number | null; supportsJson: boolean | null; seen: boolean };

/**
 * Met à jour les modèles du catalogue d'un fournisseur à partir d'une liste officielle COMPLÈTE.
 * Un modèle du catalogue qui n'y figure pas (ni par identifiant ni par alias déclaré) passe en ABSENT : exclu immédiatement.
 * N'appeler qu'avec une liste obtenue sans erreur : une panne du fournisseur ne doit jamais faire croire qu'un modèle a disparu.
 */
export function applyListing(provider: ProviderKey, listed: ListedModel[], catalog: readonly CatalogModel[] = CATALOG): AvailabilityUpdate[] {
  return catalog.filter((m) => m.provider === provider).map((m) => {
    const hit = listed.find((l) => l.modelId === m.modelId) ?? listed.find((l) => l.aliases.includes(m.modelId));
    if (!hit) return { modelId: m.modelId, lifecycle: "ABSENT", deprecatedAt: null, retiresAt: null, maxInputTokens: null, maxOutputTokens: null, supportsJson: null, seen: false };
    return { modelId: m.modelId, lifecycle: hit.lifecycle, deprecatedAt: hit.deprecatedAt, retiresAt: hit.retiresAt, maxInputTokens: hit.maxInputTokens, maxOutputTokens: hit.maxOutputTokens, supportsJson: hit.supportsJson, seen: true };
  });
}

/** Marge avant retrait : un modèle déprécié est exclu 7 jours avant sa date de retrait. */
export const DEPRECATION_MARGIN_DAYS = 7;

export type RoutableRow = { modelId: string; lifecycle: Lifecycle; retiresAt: Date | null; isAlias: boolean };
export type RoutableVerdict = { routable: true } | { routable: false; reason: "alias" | "retire" | "absent" | "non_liste" | "deprecie_bientot_retire" | "sans_prix" };

/** Le modèle peut-il être routé automatiquement ? (Registre de disponibilité + prix connu ; l'aptitude par tâche s'ajoute à la PR 2.) */
export function routableVerdict(row: RoutableRow, hasPrice: boolean, now: Date): RoutableVerdict {
  if (row.isAlias || isMovingAlias(row.modelId)) return { routable: false, reason: "alias" };
  if (row.lifecycle === "RETIRED") return { routable: false, reason: "retire" };
  if (row.lifecycle === "ABSENT") return { routable: false, reason: "absent" };
  if (row.lifecycle === "UNKNOWN") return { routable: false, reason: "non_liste" };
  if (row.lifecycle === "DEPRECATED" && row.retiresAt && +row.retiresAt - DEPRECATION_MARGIN_DAYS * 86400_000 <= +now) return { routable: false, reason: "deprecie_bientot_retire" };
  if (!hasPrice) return { routable: false, reason: "sans_prix" };
  return { routable: true };
}
