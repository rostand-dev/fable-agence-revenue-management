# NuitSignal — agence de revenue management assistée par IA

Application web responsive pour les propriétaires de locations de courte durée (Airbnb, Booking.com) qui veulent un revenue management d'agence sans la prestation. Une équipe de huit agents IA surveille chaque jour le calendrier, explique ce qui se passe et instruit les décisions ; **PriceLabs reste le moteur de prix, le propriétaire garde la validation**.

Construit à partir du *Blueprint produit et technique V1* et du Design System NuitSignal (`design-system/`).

## Ce que fait cette version

- **Comptes multi-propriétaires** : inscription par e-mail, espace isolé par propriétaire.
- **Revue quotidienne** (J+0 à J+90) : signaux → diagnostic causal → options → simulation en revenu net → audit → file priorisée.
- **Playbooks** : PB-01 rythme faible, PB-02 rythme en avance, PB-03 trou de calendrier, PB-05 cumul de remises, PB-06 passage sous le plancher (veto), PB-07 événement, PB-10 donnée périmée.
- **Dossier de décision** : preuves sourcées, arbre de diagnostic, hypothèses alternatives, options comparées (dont l'inaction), cascade du prix publié à la contribution, verdict d'audit règle par règle.
- **Cycle d'action tracé** : approuver → exécuter → vérifier → mesurer, avec machine à états, retour arrière et journal d'audit en ajout seul.
- **Équipe IA** : huit postes avec fiche de poste, workflows, activité et conversation.
- **Onboarding d'un logement** : coûts et commissions → planchers par canal et par durée de séjour. Un champ vide reste *inconnu*, jamais zéro.

### Limites connues, assumées

| Sujet | État |
|---|---|
| Données | Deux logements de **démonstration** (données synthétiques). Les adaptateurs SuperHote et PriceLabs réels ne sont pas encore branchés : un logement ajouté par onboarding obtient ses planchers, mais pas de revue tant qu'il n'a pas de calendrier. |
| Écriture PriceLabs | **Simulée** sur les logements de démonstration. |
| Promotions Airbnb / Booking.com | Procédure manuelle guidée avec preuve. Aucune automatisation de navigateur. |
| Modèle de vente | Heuristique simple et affichée comme telle ; chaque montant est une simulation, pas une prévision. |
| LLM | Facultatif. Sans `ANTHROPIC_API_KEY`, synthèses et réponses sont composées par règles. Les calculs et garde-fous n'utilisent jamais de LLM. |

## L'agence

| Agent | Poste | Écriture |
|---|---|---|
| Lina | Directrice du revenue management | aucune |
| Inès | Chargée d'onboarding et des données | aucune |
| Noor | Analyste marché | aucune |
| Elias | Stratège tarifaire | PriceLabs, sur approbation |
| Hugo | Responsable distribution et promotions | manuelle guidée |
| Maya | Responsable qualité d'annonce | aucune |
| Victor | Auditeur des décisions (veto, indépendant) | aucune |
| Théo | Chargé du reporting propriétaire | aucune |

Définitions complètes : `src/lib/agents/registry.ts` (postes, responsabilités, limites, workflows).

## Architecture

Monolithe modulaire TypeScript : Next.js (App Router) + PostgreSQL + Drizzle ORM, un seul conteneur applicatif.

```
src/lib/engine/     moteur déterministe, sans E/S : économie, métriques, détection, audit, machine à états
src/lib/agents/     registre des postes, passerelle LLM
src/lib/services/   revue quotidienne, décisions, rédaction, conversation, démonstration
src/db/             schéma et accès PostgreSQL ; migrations SQL dans drizzle/
src/app/            écrans et actions serveur
```

Écarts par rapport au blueprint, pour tenir dans un seul service simple à exploiter : pas de NestJS, Redis ni BullMQ (la revue est planifiée dans le processus, toutes les 15 minutes, une fois par jour et par propriétaire après 06:00 Europe/Paris) ; Drizzle à la place de Prisma ; authentification par e-mail et mot de passe à la place d'OIDC/MFA ; isolation par propriétaire appliquée dans le code, sans Row Level Security.

## Développement

```bash
cp .env.example .env        # renseigner DATABASE_URL
npm install
npm run dev                 # les migrations s'appliquent au démarrage
npm test                    # tests du moteur (planchers, cumul, cas dorés, machine à états)
npm run db:generate         # après une modification de src/db/schema.ts
```

## Déploiement sur Coolify

1. **Projet → New Resource → Public/Private Repository**, choisir ce dépôt, branche `main`.
2. **Build Pack : Docker Compose**, fichier `docker-compose.yml` à la racine.
3. Coolify génère le mot de passe PostgreSQL (`SERVICE_PASSWORD_POSTGRES`) et l'URL du service `app`. Dans **Domains** du service `app`, saisir votre domaine (par exemple `https://rm.rosyops.io`) — le port interne est 3000.
4. Facultatif, dans **Environment Variables** : `ANTHROPIC_API_KEY` (active le raisonnement LLM) et `ANTHROPIC_MODEL`.
5. **Deploy**. Contrôle : `https://<domaine>/api/health` répond `{"status":"ok"}`.
6. Ouvrir le domaine, créer votre compte : les deux logements de démonstration s'installent et la première revue s'exécute.

Les données vivent dans le volume `nuitsignal-db` : pensez à activer une sauvegarde de ce volume dans Coolify.
