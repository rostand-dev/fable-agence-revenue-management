/**
 * Routeur LLM : « le modèle le moins cher qui convient » (plan « routeur LLM », section 6). Fonction PURE : aucune base, aucun réseau, aucune clé.
 *
 * Ordre des décisions :
 *  1. choix manuel du propriétaire pour l'agent : il gagne toujours (une seule cible, jamais de montée de niveau) ;
 *  2. candidats = modèles du catalogue routables (registre : ni alias, ni retiré, ni sans prix), accessibles avec LA clé du propriétaire chez ce fournisseur,
 *     dans les niveaux du profil, et QUALIFIÉS pour la tâche. Aucune clé du serveur n'existe : un fournisseur sans clé du propriétaire n'est jamais candidat ;
 *  2 bis. aucun modèle qualifié : « démarrage sans régression » = le modèle par défaut (ANTHROPIC_MODEL) avec la clé Anthropic du propriétaire ;
 *  3. coût estimé (jetons typiques × prix validé), puis coût effectif = coût estimé + risque d'échec × coût de la montée de niveau ;
 *  4. tri par coût effectif (égalité : le plus fiable, puis le plus rapide) ; au plus 3 cibles de niveaux croissants si le profil monte de niveau ;
 *  5. plafond mensuel : une cible dont le coût estimé dépasse ce qu'il reste est écartée ; plus rien = repli déterministe.
 */
import { computeCostUsd } from "./prices";
import type { PriceBook } from "./pricebook";
import { catalogById, TIER_RANK, type ProviderKey, type Tier } from "./catalog";
import type { TaskProfile } from "./profiles";

export type RouteModel = { modelId: string; provider: ProviderKey; tier: Tier; /** Verdict du registre (alias, retiré, absent, sans prix…) */ routable: boolean };
export type Qualification = { status: "QUALIFIED" | "SUSPENDED"; /** Taux de réussite du banc (0 à 1) */ score: number | null };

export type RouteReason = "choix_manuel" | "auto_moins_cher" | "demarrage_sans_regression" | "aucune_cle" | "aucun_modele" | "plafond_mensuel";
export type RouteTarget = { modelId: string; provider: ProviderKey; tier: Tier | null; estimatedCostUsd: number | null };
export type RouteResult = { targets: RouteTarget[]; reason: RouteReason };

export type RouteInput = {
  profile: TaskProfile;
  /** Modèle choisi à la main pour cet agent (réglage existant), sinon null = automatique */
  manualModel: string | null;
  /** Fournisseur du modèle choisi à la main (déduit du catalogue ou de la liste des modèles de la clé) */
  manualProvider: ProviderKey | null;
  /** Fournisseurs pour lesquels le propriétaire a saisi SA clé */
  ownerProviders: ReadonlySet<ProviderKey>;
  /** Modèles listés par la clé du propriétaire chez chaque fournisseur ; absent ou vide = liste inconnue, le registre fait foi */
  ownerModels: Partial<Record<ProviderKey, ReadonlySet<string>>>;
  models: readonly RouteModel[];
  /** Aptitude par modèle pour la tâche du profil ; absence = non évalué */
  qualifications: ReadonlyMap<string, Qualification>;
  priceBook: PriceBook;
  /** Durée moyenne observée par modèle (ms), pour départager deux modèles de même coût et même fiabilité */
  latencyMs: ReadonlyMap<string, number>;
  /** ANTHROPIC_MODEL : modèle de démarrage sans régression */
  defaultModel: string;
  /** Ce qu'il reste du plafond mensuel en USD ; null = pas de plafond */
  capRemainingUsd: number | null;
};

const estimate = (b: PriceBook, modelId: string, p: TaskProfile): number | null => computeCostUsd(b.get(modelId)?.price, p.estInputTokens, p.estOutputTokens);
const tierOf = (id: string): Tier | null => catalogById(id)?.tier ?? null;

function withinCap(targets: RouteTarget[], remaining: number | null): RouteTarget[] {
  if (remaining === null) return targets;
  if (remaining <= 0) return [];
  // un coût inconnu ne bloque pas (il n'est jamais inventé) ; un coût estimé supérieur à ce qu'il reste écarte la cible
  return targets.filter((t) => t.estimatedCostUsd === null || t.estimatedCostUsd <= remaining);
}

export function route(i: RouteInput): RouteResult {
  const p = i.profile;
  const target = (modelId: string, provider: ProviderKey): RouteTarget => ({ modelId, provider, tier: tierOf(modelId), estimatedCostUsd: estimate(i.priceBook, modelId, p) });

  // 1. choix manuel : toujours prioritaire (tant que le propriétaire a la clé de ce fournisseur)
  if (i.manualModel && i.manualProvider && i.ownerProviders.has(i.manualProvider) && (!p.providers || p.providers.includes(i.manualProvider))) {
    const t = withinCap([target(i.manualModel, i.manualProvider)], i.capRemainingUsd);
    return t.length ? { targets: t, reason: "choix_manuel" } : { targets: [], reason: "plafond_mensuel" };
  }

  // 2. candidats qualifiés
  const minRank = TIER_RANK[p.minTier], maxRank = TIER_RANK[p.maxTier];
  const cands = i.models.filter((m) => {
    if (!m.routable || !i.ownerProviders.has(m.provider)) return false;
    if (p.providers && !p.providers.includes(m.provider)) return false;
    const seen = i.ownerModels[m.provider];
    if (seen && seen.size > 0 && !seen.has(m.modelId)) return false;
    const r = TIER_RANK[m.tier];
    if (r < minRank || r > maxRank) return false;
    if (p.neverDowngrade && m.tier !== p.minTier) return false;
    return i.qualifications.get(m.modelId)?.status === "QUALIFIED";
  });

  if (cands.length === 0) {
    // 2 bis. démarrage sans régression : le modèle par défaut avec la clé Anthropic du propriétaire, jamais avec une clé d'un autre fournisseur
    const allowed = !p.providers || p.providers.includes("anthropic");
    // le modèle par défaut n'est pas appelé s'il est suspendu pour cette tâche, ni s'il est absent de la liste de la clé du propriétaire
    const seenA = i.ownerModels.anthropic;
    const defaultOk = i.qualifications.get(i.defaultModel)?.status !== "SUSPENDED" && !(seenA && seenA.size > 0 && !seenA.has(i.defaultModel));
    if (i.ownerProviders.has("anthropic") && allowed && defaultOk) {
      const t = withinCap([target(i.defaultModel, "anthropic")], i.capRemainingUsd);
      return t.length ? { targets: t, reason: "demarrage_sans_regression" } : { targets: [], reason: "plafond_mensuel" };
    }
    return { targets: [], reason: i.ownerProviders.size === 0 ? "aucune_cle" : "aucun_modele" };
  }

  // 3. coûts estimés, coût effectif
  const rows = cands.map((m) => ({ m, est: estimate(i.priceBook, m.modelId, p), score: i.qualifications.get(m.modelId)?.score ?? 0, lat: i.latencyMs.get(m.modelId) ?? Number.POSITIVE_INFINITY }));
  const priced = rows.filter((r) => r.est !== null) as (typeof rows[number] & { est: number })[];
  // la montée de niveau se paie au prix du modèle le plus cher des candidats
  const escalationCost = p.escalate && priced.length ? Math.max(...priced.map((r) => r.est)) : 0;
  const effective = (r: { est: number; score: number }) => r.est + (1 - Math.min(1, Math.max(0, r.score))) * escalationCost;
  // un modèle sans coût estimé (prix absent) n'est pas routable : le registre l'a déjà écarté ; par prudence, on l'ignore ici aussi
  const sorted = [...priced].sort((a, b) => effective(a) - effective(b) || b.score - a.score || a.lat - b.lat || a.m.modelId.localeCompare(b.m.modelId));
  if (sorted.length === 0) return { targets: [], reason: "aucun_modele" };

  // 4. au plus 3 cibles, de niveaux croissants
  const chosen = [sorted[0]];
  if (p.escalate) {
    for (const r of sorted.slice(1)) {
      if (chosen.length >= 3) break;
      if (TIER_RANK[r.m.tier] > TIER_RANK[chosen[chosen.length - 1].m.tier]) chosen.push(r);
    }
  }
  const targets = withinCap(chosen.map((r) => ({ modelId: r.m.modelId, provider: r.m.provider, tier: r.m.tier as Tier | null, estimatedCostUsd: r.est })), i.capRemainingUsd);
  return targets.length ? { targets, reason: "auto_moins_cher" } : { targets: [], reason: "plafond_mensuel" };
}
