/**
 * Catalogue de départ du routeur LLM (plan « routeur LLM », section 3) : 5 modèles, identifiants API figés.
 * Pur : aucune base, aucun réseau. Un modèle absent d'ici n'est jamais routé automatiquement ; un alias mouvant (« -latest ») non plus.
 */
export type ProviderKey = "anthropic" | "openai" | "mistral";
export type Tier = "eco" | "intermediaire" | "premium";
export const TIER_RANK: Record<Tier, number> = { eco: 0, intermediaire: 1, premium: 2 };

export type CatalogModel = {
  modelId: string;
  provider: ProviderKey;
  label: string;
  tier: Tier;
  /** Clé du modèle dans le fichier de prix LiteLLM : table de correspondance entre notre identifiant figé et leur nom. */
  priceKey: string;
};

export const CATALOG: readonly CatalogModel[] = [
  { modelId: "claude-haiku-5-5", provider: "anthropic", label: "Claude Haiku 5.5", tier: "eco", priceKey: "claude-haiku-5-5" },
  { modelId: "gpt-6-luna", provider: "openai", label: "GPT-6 Luna", tier: "eco", priceKey: "gpt-6-luna" },
  // Mistral Small 4 : le fichier LiteLLM le publie sous l'alias « mistral-small-latest » et sous l'identifiant daté « mistral-small-2603 » (mêmes prix).
  // On route l'identifiant daté ; l'alias, lui, ne l'est jamais. La disponibilité réelle est confirmée par la liste officielle de Mistral.
  { modelId: "mistral-small-2603", provider: "mistral", label: "Mistral Small 4", tier: "eco", priceKey: "mistral/mistral-small-2603" },
  { modelId: "gpt-6.1-terra", provider: "openai", label: "GPT-6.1 Terra", tier: "intermediaire", priceKey: "gpt-6.1-terra" },
  { modelId: "claude-sonnet-5-5", provider: "anthropic", label: "Claude Sonnet 5.5", tier: "premium", priceKey: "claude-sonnet-5-5" },
];

export const catalogById = (id: string): CatalogModel | undefined => CATALOG.find((m) => m.modelId === id);

/** Alias mouvants (pointent vers un modèle qui change) : jamais routés, quel que soit le fournisseur. */
export function isMovingAlias(modelId: string): boolean {
  return /-latest$/i.test(modelId) || /^(chatgpt-)?latest$/i.test(modelId);
}
