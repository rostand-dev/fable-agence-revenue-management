# Épic 8 — Interface de décision

Blueprint E8 : US-080 (tableau de bord portefeuille), US-081 (espace logement à 90 jours), US-082 (boîte d'opportunités classée par priorité), US-083 (revue d'action : cascade, plancher, audit), US-084 (approbation et rejet selon les rôles), US-085 (chronologie et journal d'audit). Ce document est le plan d'implémentation et la référence fonctionnelle de l'épic ; chaque US le complète.

**Point de départ (fin d'épic 7).** Le cockpit sait déjà classer les dossiers (`/`), instruire un dossier (`/dossier/[code]`), suivre une action de l'approbation à la mesure, afficher l'historique et le journal d'audit (`/historique`) et présenter un logement en onglets (`/logements/[id]`). L'épic 8 ne reconstruit pas ces écrans : il comble l'écart entre eux et les critères du blueprint (§15) et ajoute ce qui manquait (droits par rôle, tableau de bord, filtres, chronologie unifiée).

## Principes de l'épic

1. **Le serveur décide, l'écran suit.** Un droit est vérifié par le service (et donc par l'API) ; l'écran ne propose que ce que le serveur accepterait.
2. **Aucun chiffre sans source.** Un indicateur inconnu garde son qualificatif (« inconnu », « non chiffrable »), jamais un zéro.
3. **Aucune régression des décisions** : les golden cases (`review-golden.test.ts`) et la suite E2E complète sur trois largeurs (bureau, 390 et 360 px) restent verts à chaque étape.
4. **Mobile d'abord** : chaque écran est vérifié sans débordement horizontal à 390 et 360 px.

## Ordre d'implémentation et dépendances

| Ordre | US | Pourquoi à cette place |
|---|---|---|
| 1 | **US-084** Approbation/rejet selon les rôles | Fondation : les boutons de la boîte d'opportunités (US-082) et de la revue d'action (US-083) dépendent des droits. Les introduire d'abord évite de retoucher ces écrans. |
| 2 | **US-083** Revue d'action | Écran de décision, appelé depuis la boîte et le tableau de bord. Il fixe les composants de présentation (cascade, plancher, règles d'audit). |
| 3 | **US-082** Boîte d'opportunités | Filtres et cartes ; ses filtres (« à approuver », « urgent »…) sont les cibles des liens du tableau de bord. |
| 4 | **US-085** Chronologie et journal d'audit | Le journal sert de chronologie aux fiches action et logement (US-081). |
| 5 | **US-081** Espace logement à 90 jours | Réutilise la chronologie (onglet Historique) et les liens vers dossiers et snapshots. |
| 6 | **US-080** Tableau de bord portefeuille | Dernier : il agrège et relie tout le reste (opportunités, actions en attente, santé des intégrations, KPI). |

**Garde-fous de non-régression** : `review-golden.test.ts` inchangé, suites unitaires et base de données complètes, E2E complet sur trois largeurs, couverture d'audit (`coverage.test.ts`).

## Décisions prises pendant l'épic (à relire)

- **Rôles** : ceux du blueprint (§16.1) — administrateur, revenue manager, analyste, opérateur OTA, propriétaire du bien (lecture), auditeur — plus **« propriétaire du compte » (`OWNER`)**, rôle historique de tous les comptes existants, qui garde **tous** les droits : aucun compte existant ne perd quoi que ce soit.
- **Rôle inconnu = lecture seule** : une valeur absente de la liste en base ne donne jamais de droit.
- **Pas d'écran de gestion des rôles dans cet épic** : le rôle est une colonne de `users`. Sur Staging, un rôle se change en base (voir US-084). Une gestion d'équipe (invitations) est une US à part.
- **Périmètre des droits** : le circuit de décision et la lecture du journal. Les réglages (clés, coûts, intégrations) ne sont pas encore soumis aux rôles.

## US-084 — Approbation et rejet selon les rôles

**Ce qui change**
- **Matrice des droits `src/lib/rbac.ts`** (module pur, testé) : six droits — décider (approuver, rejeter, différer, rouvrir), exécuter par écriture PriceLabs ou tâche interne, appliquer une procédure manuelle, vérifier, revenir en arrière, lire le journal d'audit.

  | Rôle | Décider | Exécuter API/interne | Procédure manuelle | Vérifier | Retour arrière | Journal |
  |---|:-:|:-:|:-:|:-:|:-:|:-:|
  | Propriétaire du compte, Administrateur, Revenue manager | oui | oui | oui | oui | oui | oui |
  | Opérateur OTA | non | non | oui | oui | non | non |
  | Analyste, Propriétaire du bien | non | non | non | non | non | non |
  | Auditeur | non | non | non | non | non | oui |

  (Le journal est lisible par le propriétaire du compte, l'administrateur, le revenue manager et l'auditeur.)
- **Application côté serveur** : `approve`, `reject`, `defer`, `reopen`, `execute`, `verify`, `rollback` (`services/decisions.ts`) refusent avant tout changement d'état (`ForbiddenError`). L'API REST et les actions serveur passent par ces mêmes services.
- **Refus tracé** : un refus écrit un événement `access.denied` (famille « Accès » du journal) avec le rôle et le droit demandé, jamais le contenu de la demande (commentaire).
- **Écrans** : boîte d'opportunités, fiche dossier et historique n'offrent que ce que le rôle permet ; à la place, un bandeau « Lecture seule » nomme le rôle et dit à qui revient la décision. Réglages affiche « Vos droits ».
- **API REST** (blueprint §13.1) : `POST /api/v1/opportunities/{id}/approve` (`{ candidate, comment }`) et `POST /api/v1/opportunities/{id}/reject` (`{ comment }`). Codes : 200, 400 saisie invalide, 401, 403 droits insuffisants ou origine étrangère, 404, 409 dossier plus ouvert. Mêmes règles que l'écran : option rejetée par l'auditeur impossible, commentaire exigé pour une option à risque élevé ou à valider. `GET /api/audit-events` répond 403 aux rôles sans droit de lecture.
- **Erreurs typées** : `DecisionError` porte un `kind` (`CONFLICT`, `VALIDATION`, `NOT_FOUND`, `FORBIDDEN`) ; les messages affichés ne changent pas.
- **Staging (Coolify)** : **aucune migration, aucune variable d'environnement.** Tous les comptes existants ont déjà le rôle `OWNER` (valeur par défaut de la colonne `users.role`) et gardent tous leurs droits. Pour tester un autre rôle : `update users set role = 'ANALYST' where email = '…';` (valeurs : `TENANT_ADMIN`, `REVENUE_MANAGER`, `ANALYST`, `OTA_OPERATOR`, `OWNER_VIEWER`, `AUDITOR`), puis se reconnecter est inutile : le rôle est relu à chaque requête.

**Limites connues** : pas d'écran de gestion des rôles ni d'invitation d'utilisateurs ; « Relancer la revue » reste ouvert à tous les rôles (il ne décide rien) ; les réglages ne sont pas encore soumis aux rôles.

**Tests** : unitaires (`rbac.test.ts` : matrice, rôle inconnu, messages), base de données (`rbac.db.test.ts` : refus par rôle sans changement d'état, refus consigné sans fuite du commentaire, opérateur OTA manuel seulement, revenue manager et propriétaire du compte inchangés, API 401/400/403/404/409/200, origine étrangère, journal 403), E2E navigateur (`e2e/droits-roles.spec.ts`, bureau/390/360 : analyste en lecture seule sur la boîte, le dossier, l'historique et Réglages, refus 403 de l'API, auditeur lecteur du journal, revenue manager inchangé), non-régression (suites complètes, golden inchangé).

**Après relecture** : la revue manuelle et la réinstallation de la démonstration exigent aussi le droit de décider (la seconde supprime des dossiers) ; le droit est contrôlé avant la validation du corps de requête (403 quel que soit le corps) ; l'identifiant écrit dans un refus est tronqué à 64 caractères. L'opérateur OTA peut vérifier toute action exécutée (relecture indépendante, RACI §2.2).

## US-083 — Action Review : cascade, planchers, promotions empilées, audit

**Point de départ** : la fiche dossier avait déjà la cascade chiffrée en tableau (actuel / proposé / écart), les bornes, les règles d'audit par option, les jauges de confiance et de risque, le plan de retour arrière, le commentaire obligatoire pour une option à risque élevé ou à valider, et les boutons Approuver / Rejeter. Manquaient la cascade en barres (« waterfall »), la position du prix face aux planchers, la lecture des promotions empilées et la trace d'audit du dossier.

**Ce qui change**
- **Cascade du revenu net en barres** (`components/Waterfall.tsx`, géométrie pure et testée dans `engine/waterfall.ts`) : une ligne par étape, du prix publié à la contribution, pour la situation actuelle et pour l'option. Le montant est toujours écrit en toutes lettres ; la barre est décorative (le sens ne dépend pas de la couleur). Une cascade qui ne se referme pas sur la contribution est signalée.
- **Jauge des planchers** : prix vendu par nuit, actuel et proposé, sur un même axe avec le plancher absolu et le plancher stratégique, et une phrase (« sous le plancher absolu », « entre les deux », « au-dessus »).
- **Promotions empilées** : ordre d'application, montant retiré à chaque étape, remise cumulée face au plafond de la stratégie.
- **Traçabilité** : événements du journal d'audit du dossier et de son action, du plus ancien au plus récent, avec lien vers le journal complet ; réservée aux rôles qui lisent le journal (US-084).
- **Staging (Coolify)** : aucune migration, aucune variable d'environnement.

**Tests** : unitaires (`waterfall.test.ts` : géométrie, fermeture, contribution négative, jauge), E2E navigateur (`e2e/revue-action.spec.ts`, bureau/390/360 : cascade, planchers, promotions, barres dans leur piste, traçabilité, sans débordement), non-régression (suites complètes, golden inchangé).
