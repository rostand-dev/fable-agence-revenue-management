# Routeur LLM « le moins cher adapté » (PR 1 : registres et coût ; PR 2 : routeur, clés par fournisseur, aptitude)

Plan de référence : `plan-routeur-llm.md` (version 5, document du projet Claude « Fable-Agence-RM », absent du dépôt). Cette PR pose les **registres** et la **trace du coût** ; elle ne change **aucun comportement des agents** (le choix du modèle vient avec la PR 2).

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

- La disponibilité n'est lue qu'avec les clés **enregistrées par les propriétaires** (jamais une clé du serveur). OpenAI et Mistral restent `UNKNOWN` tant que le propriétaire n'a pas saisi la clé correspondante.
- L'identifiant figé `mistral-small-2603` est celui du fichier LiteLLM ; il n'est routable qu'une fois listé par Mistral avec une clé de propriétaire.
- La disponibilité d'un modèle est **globale** (déduite de toutes les clés enregistrées, 3 par fournisseur au plus) : un modèle n'est déclaré absent que si aucune clé ne le voit. L'accès propre à chaque propriétaire se vérifie, en PR 2, avec la liste personnelle de sa clé.
- Aucune redirection HTTP n'est suivie vers les fournisseurs ni vers le fichier de prix. `LLM_PRICES_URL` et les `*_API_BASE` sont fournis par l'exploitant : ils ne doivent pointer que vers des adresses de confiance.
- Après un échec de synchronisation, nouvel essai au bout d'une heure ; le droit de lancer une passe est pris par une insertion conditionnelle atomique (deux instances ne la lancent jamais en double).

---

## PR 2 : routeur, clés par fournisseur, aptitude

### Ce que fait le routeur
- **Plus aucune clé de modèle sur le serveur** : `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` et `OPENAI_MODEL` sont supprimées (code, `.env.example`, `docker-compose.yml`, CI). Chaque propriétaire saisit **sa** clé par fournisseur (Anthropic, OpenAI, Mistral ; chiffrées avec `APP_SECRET`). Ses données ne partent que vers un fournisseur pour lequel il a saisi sa clé ; sans clé : mode déterministe, message clair (Intégrations).
- **Choix de la cible** (fonction pure `route()`) : choix manuel de l'agent (prioritaire, une cible) → candidats = modèles routables (ni alias, ni retiré, ni sans prix), listés par la clé du propriétaire, du niveau de la tâche et **qualifiés** → coût estimé (jetons typiques × prix validé) → coût effectif (+ risque d'échec × coût de la montée de niveau) → tri (égalité : le plus fiable, puis le plus rapide) → au plus 3 cibles de niveaux croissants → plafond mensuel.
- **Profils** : Lina, Elias, Hugo, Noor = économique d'abord avec montée de niveau ; Victor (audit) = premium, jamais rétrogradé ; chat = économique, sans montée, Anthropic seulement (flux).
- **Démarrage sans régression** : aucun modèle qualifié pour la tâche → `ANTHROPIC_MODEL` avec la clé Anthropic du propriétaire. Sans clé Anthropic : mode déterministe (jamais un autre fournisseur à l'insu du propriétaire).
- **Trace** : chaque exécution écrit `trace.route` (raison, modèles retenus), le coût estimé avant l'appel et le coût réel ; le chat trace aussi son coût.
- **Plafond mensuel (€)** : vide par défaut. À 100 %, plus aucun appel de modèle jusqu'au 1er du mois suivant (repli déterministe tracé `BUDGET_CAP`, sans erreur). L'alerte à 80 % est calculée (`capState`) et s'affiche en PR 3. Conversion au taux `LLM_USD_EUR_RATE`.

### Aptitude (qualification)
- Statuts par (modèle, tâche) : non évalué (pas de ligne) → qualifié → suspendu. Table `llm_qualifications` (migration `0035`, idempotente ; la clé de `llm_credentials` devient `(tenant_id, provider)`).
- **Banc d'évaluation** (`bench.ts`) : lancé **à la demande uniquement** (bouton « Tester ce modèle », PR 3), jamais en CI ; cas **synthétiques** (logements de démonstration), clé de la personne qui clique, coût estimé affiché avant. Qualifié à partir de 95 % de cas valides (schéma + garde-fous). Une panne du fournisseur interrompt le banc sans rien écrire. Résultat partagé par tous les comptes.
- **Suspension automatique** : un modèle qualifié passe suspendu si sa réussite observée (réponses valides / invalides ; les pannes ne comptent pas) tombe sous 95 % sur 30 jours avec au moins 20 appels, comptés depuis sa dernière évaluation. Passe horaire, coupée avec `LLM_SYNC_INTERVAL_HOURS=0`.

### Variables d'environnement
- Supprimées : `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_MODEL` (à retirer dans Coolify).
- `ANTHROPIC_MODEL` : modèle de démarrage (défaut `claude-sonnet-5-5`). `OPENAI_API_BASE`, `ANTHROPIC_API_BASE`, `MISTRAL_API_BASE` : adresses des API (tests).
- `DEMO_ACCOUNT_LLM_KEY` (tests/CI uniquement) : clé factice enregistrée pour le compte de démo, acceptée seulement si `ANTHROPIC_API_BASE` est local.

### Avant déploiement
Saisir sa propre clé Anthropic sur chaque compte (staging, production), sinon ses agents passent en mode déterministe ; retirer les variables supprimées dans Coolify.

### Limites
- Le chat n'utilise que la clé Anthropic (flux non implémenté pour les autres). Sans clé Anthropic, le chat répond par règles.
- L'alerte à 80 %, l'écran des modèles, le bouton « Tester ce modèle » et le réglage du plafond arrivent en PR 3.
- Plafond : un modèle sans prix connu compte pour 0 (jamais une valeur inventée) et n'est donc pas plafonné ; deux revues ou chats simultanés peuvent dépasser le plafond d'un appel (dépassement borné, pas de verrou). La remise à zéro se fait le 1er du mois à 00h00 UTC (01h ou 02h à Paris).
- Une clé refusée (401) chez un fournisseur laisse la passerelle essayer les autres clés du même propriétaire : ses données ne vont jamais qu'à ses propres fournisseurs.
- Tant qu'aucun modèle n'est qualifié (le bouton « Tester ce modèle » arrive en PR 3), OpenAI et Mistral ne sont pas utilisés en automatique : seul le démarrage sans régression (Anthropic) s'applique, ou un choix manuel.
- Le banc écrit un verdict partagé par tous les comptes : son déclenchement sera réservé et son coût tracé en PR 3.

## PR 3 : écran « Modèles », plafond, coûts

Page `/modeles` (menu Paramètres, IA & modèles) :

- **Plafond mensuel en euros** : saisie vide = aucun plafond. Le taux appliqué (`LLM_USD_EUR_RATE`, défaut 0,92) est affiché à côté. Alerte à 80 % (aussi sur Paramètres › Compte & sécurité, Intégrations et la fiche agent) ; à 100 % les agents passent en mode déterministe jusqu'au 1er du mois suivant (UTC).
- **Coût du mois par agent** : mois en cours et mois précédent, en euros, avec la tendance nommée (croissante, stable, décroissante) : rythme journalier du mois comparé à celui du mois précédent, écart de moins de 15 % = stable. Les appels sans prix connu sont comptés à part, jamais chiffrés. Les tests de modèles ont leur propre ligne.
- **Modèles du catalogue** : état (qualifié, disponible, prix à vérifier, déprécié ou retiré, non disponible avec vos clés), prix validé, qualification par tâche. Un changement de prix détecté reste « à vérifier » : validation ou refus en un clic, sans effet sur les coûts avant validation.
- **« Tester ce modèle »** : banc sur cas synthétiques avec la clé du propriétaire. Le coût estimé est affiché avant le clic. Refusé si le prix est inconnu, si le plafond est atteint ou serait dépassé, au-delà d'un test par modèle toutes les 15 minutes ou de 6 tests par heure et par espace. Le coût réel est tracé dans `agent_runs` (agent `banc`) et compte dans le plafond.
- « Automatique » est le choix par défaut de chaque liste de modèle (Paramètres › Compte & sécurité et fiche agent) ; un choix manuel prime toujours.

**Réservé à l'exploitant** : valider un prix et lancer un test modifient des données partagées par tous les comptes ; seules les adresses de `LLM_ADMIN_EMAILS` (nouvelle variable, vide par défaut = personne) peuvent le faire. Le plafond est réservé aux rôles propriétaire et administrateur, avec mot de passe redemandé après « Rester connecté ». Un test en cours ou interrompu compte dans le plafond pour son estimation maximale (corrections comprises) ; contrôles et pose de la trace sont atomiques par espace. Un prix refusé n'est pas re-signalé tant que le fichier de prix ne change pas.

**Avant déploiement** : renseigner `LLM_ADMIN_EMAILS` dans Coolify (sinon aucun prix ne peut être validé ni aucun modèle testé). Aucune migration. Limites : la qualification issue d'un test est partagée par tous les espaces ; le test est synchrone (quelques minutes avec de vrais modèles) ; le plafond est contrôlé avant le lancement au pire cas, pas pendant ; la colonne « Appels » de la ligne « Tests de modèles » compte un test pour un appel et ses jetons n'entrent pas dans le budget journalier.
