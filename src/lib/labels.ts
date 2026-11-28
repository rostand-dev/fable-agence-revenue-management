export const PROPERTY_STATUS: Record<string, [string, "prep" | "approb" | "verif", string]> = {
  ONBOARDING: ["Onboarding", "prep", "clock"], SHADOW: ["Observation", "approb", "search"], ACTIVE: ["Actif", "verif", "check"],
};

/** Résultat mesuré d'une action : [libellé, rôle]. « Positif » reste une corrélation, jamais un gain attribué. */
export const OUTCOME: Record<string, [string, "sain" | "neutre" | "attention" | "tech"]> = { POSITIVE: ["Positif · corrélation", "sain"], NEUTRAL: ["Neutre", "neutre"], NEGATIVE: ["Négatif", "attention"], INCONCLUSIVE: ["Non concluant", "tech"] };
