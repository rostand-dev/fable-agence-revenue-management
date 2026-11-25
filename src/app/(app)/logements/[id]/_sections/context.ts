import type { schema } from "@/db";
import type { requireUser } from "@/lib/auth";
import type { EconomicModel, Strategy } from "@/lib/engine/types";
import type { monthlyKpis } from "@/lib/engine/metrics";
import type { loadEngineInput } from "@/lib/services/review";

/** Paramètres d'URL de la fiche logement. */
export type FicheParams = { tab?: string; erreur?: string; erreurSh?: string; canal?: string; jour?: string; lance?: string };

/** Ce que la page lit une fois et que toutes les sections de la fiche partagent. */
export type Fiche = {
  user: Awaited<ReturnType<typeof requireUser>>;
  p: typeof schema.properties.$inferSelect;
  sp: FicheParams;
  today: string;
  now: Date;
  input: NonNullable<Awaited<ReturnType<typeof loadEngineInput>>>;
  opps: (typeof schema.opportunities.$inferSelect)[];
  model: EconomicModel;
  strat: Strategy;
  names: Record<string, string> | null;
  /** Données manquantes du modèle économique. */
  miss: string[];
  /** Logement réel dont le parcours de création n'est pas terminé. */
  onboarding: boolean;
  hasHistory: boolean;
  hasCal: boolean;
  /** Douze derniers mois complets et leurs indicateurs. */
  months: string[];
  kpis: ReturnType<typeof monthlyKpis>;
  period: string;
  trend: "croissante" | "décroissante" | "stable" | null;
};
