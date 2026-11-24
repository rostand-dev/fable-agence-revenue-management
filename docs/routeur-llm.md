# Routeur LLM « le moins cher adapté » : registres et coût tracé (PR 1 sur 3)

Plan de référence : `claude/plan-routeur-llm.md` (version 5, projet Claude « Fable-Agence-RM »). Cette PR pose les **registres** et la **trace du coût** ; elle ne change **aucun comportement des agents** (le choix du modèle vient avec la PR 2).

## Ce que contient la PR 1

| Brique | Où | Rôle |
|---|---|---|
| Catalogue des 5 modèles | `src/lib/llm-registry/catalog.ts` | Identifiants API figés, gamme (éco, intermédiaire, premium), table de correspondance vers le fichier de prix LiteLLM. Les alias mouvants (`-latest`) ne sont jamais routés. |
| Prix | `prices.ts`, `sync.ts` | Lecture du fichier open source LiteLLM, surcharges `LLM_PRICE_OVERRIDES`, palier de prompt long. Première observation : enregistrée. Prix modifié : **signalé « à vérifier »**, appliqué après validation (`price-validation.ts`). Surcharge de l'exploitant : appliquée directement. |
| Disponibilité | `availability.ts`, `sync.ts` | Listes officielles des fournisseurs (Anthropic : `lifecycle`, `retires_at`, tailles, JSON structuré ; Mistral ; OpenAI). Modèle retiré ou absent : exclu immédiatement ; déprécié : exclu 7 jours avant son retrait. Une liste en erreur ne fait jamais conclure qu'un modèle a disparu. |
| Coût réel | `pricebook.ts`, `agents/runner.ts`, `agents/gateway.ts` | Chaque appel d'agent enregistre `cost_usd` (tous les essais, chacun au prix de son modèle) et `price_snapshot_id`. **Prix inconnu : null, jamais un chiffre inventé.** |
| Plafond mensuel | `cap.ts` | Réglage en euros par propriétaire (`tenants.settings.llmMonthlyCapEur`), **vide par défaut = aucun plafond**. Son application (alerte à 80 %, arrêt à 100 %) vient avec le routeur. |
| Job | `job.ts`, `src/instrumentation-node.ts` | Au démarrage puis contrôle horaire ; ne synchronise que si la dernière passe a plus de `LLM_SYNC_INTERVAL_HOURS`. Relecture de la disponibilité aussi à chaque enregistrement de clé. |

## Tables (migration `0034_llm_registres.sql`, idempotente)

- `llm_models` : un modèle, son fournisseur, sa gamme, son état (`UNKNOWN`, `ACTIVE`, `DEPRECATED`, `RETIRED`, `ABSENT`), ses tailles, le support du JSON structuré.
- `llm_price_snapshots` : historique des prix (USD par million de jetons). Prix en vigueur = dernier `VALIDATED`. Au plus un changement `PENDING` par modèle.
- `llm_sync_runs` : journal des synchronisations.
- `agent_runs` : colonnes `cost_usd`, `cost_estimated_usd` (renseignée à partir de la PR 2), `price_snapshot_id`.

## Variables d'environnement ajoutées

Décrites une à une dans `.env.example` et `docker-compose.yml` : `MISTRAL_API_BASE`, `LLM_PRICES_URL`, `LLM_PRICE_OVERRIDES`, `LLM_SYNC_INTERVAL_HOURS` (0 = job coupé, utilisé en CI), `LLM_USD_EUR_RATE`.

## Limites connues de cette PR

- La disponibilité n'est lue qu'avec les clés **enregistrées par les propriétaires** (jamais une clé du serveur). Aujourd'hui seule la clé Anthropic existe : OpenAI et Mistral restent `UNKNOWN` tant que les clés correspondantes ne sont pas saisissables (PR 2).
- Le coût des conversations en direct avec un agent (chat) n'est pas encore tracé : seules les tâches passant par l'exécuteur d'agent le sont.
- L'identifiant figé `mistral-small-2603` est celui du fichier LiteLLM ; il n'est routable qu'une fois listé par Mistral avec une clé de propriétaire.
