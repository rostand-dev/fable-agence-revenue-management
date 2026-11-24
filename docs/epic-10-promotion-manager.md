# Épic 10 — Promotion Manager manuel

Blueprint E10 (P1) : US-100 (registre des promotions actives), US-101 (compilateur de promotions Booking/Airbnb), US-102 (runbook pas-à-pas par action), US-103 (confirmation opérateur et preuve), US-104 (vérification, période de repos, expiration). Ce document est le plan d'implémentation et la référence fonctionnelle de l'épic ; chaque US le complète.

**Point de départ (fin d'épic 9).** Les promotions Airbnb et Booking.com n'ont aucune API accessible : elles passent par une **procédure manuelle guidée** (blueprint §11, niveau A1). Le code avait déjà une table `promotions` (alimentée par la démonstration et par l'exécution d'une action `CHANNEL_PROMO` / `PROMO_REMOVAL`), un registre des règles de cumul (US-003), un simulateur de cascade (US-053), une liste d'étapes statique sur la fiche du dossier, et une déclaration d'exécution (portée, date, preuve libre). L'épic 10 en fait une **boucle complète** : exprimer une intention → la traduire par canal → appliquer à la main avec un guide → prouver → vérifier plus tard → laisser reposer.

## Principes de l'épic

1. **Aucune automatisation d'extranet.** Jamais de navigateur piloté sur Airbnb ou Booking.com : le registre reflète ce que l'opérateur a relevé lui-même (règle déjà publiée dans « Méthode »).
2. **Une règle inconnue n'est jamais devinée.** Type de promotion absent du registre de cumul, règle de cumul inconnue, éligibilité non établie : `NEEDS_HUMAN` ou `NO_SAFE_EQUIVALENT`, jamais une valeur supposée (US-003, blueprint §10.2 et §10.4).
3. **Jamais sous le plancher.** Toute promotion compilée passe par le simulateur de cascade ; sous le plancher absolu, le compilateur ne propose rien.
4. **Le registre est la mémoire.** Chaque geste (déclarer, modifier, terminer, vérifier, confirmer, expirer) est un événement du journal d'audit (ajout seul), visible dans la chronologie du logement.
5. **Isolation par propriétaire d'espace** (filtres applicatifs + RLS déjà en place sur `promotions`), droit dédié `promotion.manage`.
6. **Aucune régression des décisions** : golden cases inchangés, E2E complet sur trois largeurs (bureau, 390 et 360 px), migrations rejouables deux fois.

## Ordre d'implémentation et dépendances

| Ordre | US | Pourquoi à cette place |
|---|---|---|
| 1 | **US-100** Registre des promotions actives | Fondation : modèle de données complet (annonce, fenêtres, séjour minimal, audience, référence), service, droit, audit, écran. Toutes les autres US lisent ou écrivent ce registre. |
| 2 | **US-101** Promotion Compiler | Lit le registre (promotions actives, cumul) et le simulateur ; produit ce que les étapes suivantes appliquent. |
| 3 | **US-102** Runbook pas-à-pas | Guide l'application d'une promotion compilée ou d'une action approuvée ; ne se conçoit qu'une fois la forme d'une promotion compilée connue. |
| 4 | **US-103** Confirmation et preuve | Clôt le runbook : références, preuve, date d'effet ; écrit dans le registre. |
| 5 | **US-104** Vérification, repos, expiration | Dernier : observe ce que les quatre autres ont produit (promotions confirmées, dates, preuves) pour les relire, les laisser reposer et les expirer. |

## US-100 — Registre des promotions actives

**Ce qui change.** Chaque logement a un registre complet, tenu à la main, dans l'onglet « Canaux et promotions » de sa fiche. Une promotion porte : canal, type (liste des types connus du registre de cumul), nom dans l'extranet, remise, **séjours** (début, fin exclue, ou permanente), **fenêtre de réservation**, **séjour minimal**, **audience** (déduite du type), **annonce visée** (ou toutes), **identifiant relevé dans l'extranet**, état, dates de déclaration et de dernière vérification, auteur.

- **Déclarer** : active et vérifiée à l'instant (la personne vient de la lire dans l'extranet). Refus : saisie invalide (remise hors 1–80 %, dates par paire et dans l'ordre, séjours déjà passés, séjour minimal hors 1–365, identifiant avec caractères interdits), **doublon** (même canal, même type, même annonce — ou l'une vise toutes — et séjours qui se recoupent), annonce d'un autre logement ou d'un autre canal.
- **Modifier** : canal et type ne changent jamais (c'est une autre promotion). Toute modification **remet la vérification à zéro** ; les changements champ par champ sont dans l'événement d'audit.
- **Terminer** : motif facultatif conservé ; une promotion terminée n'est plus modifiable, et un doublon redevient possible.
- **Marquer vérifiée** : relecture dans l'extranet, valable 7 jours (même seuil que la fraîcheur des données de revue, `MAX_AGE_HOURS.PROMOTIONS`).
- **Affichage** : cartes (une colonne sur mobile), états Active / Planifiée / Séjours passés / Terminée, « À re-vérifier » au-delà de 7 jours, « Jamais vérifiée », avertissement **cumul inconnu** entre promotions actives qui se recoupent (US-003). Une promotion dont les séjours sont passés s'affiche « Séjours passés » sans attendre le balayage de l'US-104.
- **Droits** : `promotion.manage` (propriétaire du compte, administrateur, revenue manager, opérateur OTA) pour déclarer, modifier, terminer ; `action.verify` (existant) pour marquer vérifiée. Lecture seule (analyste, auditeur, propriétaire du bien) : le registre est lisible, aucun bouton. Un refus est consigné (`access.denied`).
- **Audit** : `promotion.declared`, `promotion.updated`, `promotion.ended` (Réglages), `promotion.verified` (Exécutions) — entité « Property », donc dans la chronologie du logement.
- **Migration `0028`** (idempotente) : onze colonnes ajoutées à `promotions` (`listing_id`, `book_from`, `book_to`, `min_los`, `audience`, `external_ref`, `created_by`, `verified_by`, `ended_at`, `end_reason`, `updated_at`). Les lignes existantes (démonstration, promotions déclarées par action) restent valides : toutes les nouvelles colonnes sont facultatives ou ont une valeur par défaut. Aucune variable d'environnement.

**Tests** : validation, doublons, états, fraîcheur et cumul inconnu (`registry.test.ts`) ; service sur base réelle — déclaration, doublon, annonce, isolation entre espaces, droits (y compris refus consigné), modification, fin, vérification, classement (`promotion-registry.db.test.ts`) ; matrice des droits (`rbac.test.ts`) ; rejeu double des migrations ; E2E navigateur sur trois largeurs (`promotions-registre.spec.ts`) : déclarer / doublon refusé / saisie invalide / modifier / vérifier / terminer / chronologie, cumul inconnu, rôle en lecture seule et opérateur OTA.

## US-101 — Promotion Compiler Booking/Airbnb

**Ce qui change.** Une page « Compilateur de promotions » (lien depuis le registre, onglet « Canaux et promotions ») transforme une **intention commerciale** en une promotion par canal, ou en un refus expliqué. Lecture seule : rien n'est enregistré, rien n'est envoyé à un canal.

- **Intentions** (blueprint §10.1) : demande proche, longs séjours, très anticipé, marché cible. Saisie : fenêtre de séjours, remise maximale acceptée (1–80 %), canaux et prix publié par nuit sur chacun, séjour minimal et délai avant l'arrivée facultatifs (7 nuits par défaut pour un long séjour, 2 à 90 ; délai avant l'arrivée : de 1 à 60 jours au plus pour la demande proche, 7 par défaut ; de 30 à 365 jours au moins pour le très anticipé, 60 par défaut ; ignoré ailleurs ; un début de fenêtre passé est ramené à aujourd'hui).
- **Traduction par canal** (blueprint §10.2, uniquement des types du registre de cumul) : demande proche → Booking.com « Tarif mobile », Airbnb « Dernière minute » ; longs séjours → Airbnb « Durée de séjour » ; très anticipé → Airbnb « Early-bird » ; marché cible → Booking.com « Tarif par pays ». Tout le reste = `NO_SAFE_EQUIVALENT` (aucun type équivalent n'est inventé). PriceLabs : une note d'information, jamais de compilation.
- **Jamais sous le plancher** : la remise proposée est la plus grande, par pas de 0,5 point et ≤ remise maximale, pour laquelle le simulateur (US-053) respecte le plancher absolu, le plancher stratégique et le plafond de cumul. Aucune ne convient → `NO_SAFE_EQUIVALENT` (`FLOOR`). Séjour de référence : **1 nuit** (le ménage y pèse le plus), ou le séjour minimal donné ; le plancher retenu est le plus exigeant de **toutes les saisons** que la fenêtre traverse (le simulateur seul ne regarde que les premières nuits). Une remise maximale ne s'exprime qu'à une décimale ; la recherche part du plus grand demi-point qui ne la dépasse pas. Plafond de cumul trop bas → `STACK_CAP`.
- **Registre et cumul** (blueprint §10.4) : promotions actives ou planifiées qui recoupent la fenêtre. Même type déjà actif → `ALREADY_ACTIVE` ; promotion Airbnb exclusive déjà active → `EXCLUSIVE_WITH_ACTIVE` ; règle de cumul inconnue, registre non relu depuis plus de 7 jours (promotions actives ou planifiées) **ou registre vide sur ce canal** (il est tenu à la main : son silence ne prouve pas qu'il n'y a rien dans l'extranet) → `NEEDS_HUMAN`. Une promotion Airbnb exclusive déjà active est refusée (le simulateur, lui, cumule par prudence). La fenêtre de réservation et l'annonce visée des promotions en place ne sont pas comparées : choix prudent, le refus le signale (la proposition est montrée, avec ce qu'il faut confirmer dans l'extranet).
- **Données manquantes** : modèle économique incomplet, plafond de cumul inconnu → `MISSING_DATA`. Fenêtre plus courte que le séjour minimal → `WINDOW_TOO_SHORT`.
- **Sortie** : réglages à saisir dans l'extranet (type, remise, séjours, séjour minimal, fenêtre de réservation, audience) ; c'est la forme que le guide pas-à-pas (US-102) consommera. Aucune migration, aucune variable d'environnement.

**Tests** : saisie, traduction par canal, planchers (dont une propriété sur 4 intentions × prix × remises : jamais sous un plancher), registre et cumul, données manquantes (`compiler.test.ts`) ; service sur base réelle (`promotion-compiler.db.test.ts`) ; E2E navigateur sur trois largeurs (`promotions-compilateur.spec.ts`).

## US-102 — Runbook pas-à-pas par action

**Ce qui change.** Sur la fiche d'un dossier dont l'action approuvée s'applique **à la main** (promotion de canal, retrait de promotion, vérification du registre, audit d'annonce, réglage PriceLabs manuel), l'ancienne liste statique devient un **guide cochable** (blueprint Annexe B).

- **Étapes propres à l'action et au canal** (`promotions/runbook.ts`, module pur) : « Ouvrir l'extranet Booking.com » ou « votre compte hôte Airbnb » ; pour une promotion, la fiche à saisir reprend le type (libellé du registre de cumul), la remise, les séjours (départ exclu), le séjour minimal et l'audience ; le prix attendu vient de la simulation approuvée. Un type absent du registre de cumul met en tête une consigne « ne rien poser ». La consigne « si l'état réel diffère, s'arrêter » est lue mais ne se coche pas. Remise absente ou type inconnu : une consigne d'arrêt **bloque** le guide, qui n'est alors jamais « terminé » (rien n'est supposé). Les étapes qui renvoient au formulaire de déclaration ne se cochent pas (pas de cercle).
- **Avancement enregistré** : table `runbook_steps` (migration `0029`, idempotente, isolation par la base comme les autres tables : lecture, ajout et suppression). Cocher/décocher est un formulaire (sans JavaScript requis) ; chaque changement réel est au journal d'audit (`runbook.step_checked` / `runbook.step_unchecked`), entité « RevenueAction ». Cocher deux fois ne crée qu'une ligne et un événement.
- **Droits** : le droit d'exécuter l'action (`action.execute.manual` pour une procédure manuelle) ; un refus est consigné (`access.denied`). Les autres rôles lisent l'avancement (« Faite » / « À faire »), sous la bannière « Exécution réservée » ou « Exécution impossible ». Le geste prend un verrou sur l'action : cocher en même temps que « Déclarer la réalisation » ne laisse jamais une étape cochée sur une action déjà partie. Le guide ne se coche que tant que l'action est « approuvée » : après la déclaration, il se ferme.
- **Choix** : l'avancement n'empêche pas la déclaration de réalisation (le blocage éventuel relève de la confirmation de l'US-103) ; il affiche « guide terminé » quand toutes les étapes cochables le sont.
- **Affichage** : une colonne sur mobile (texte puis bouton pleine largeur de 44 px), deux colonnes à partir de 720 px, barre d'avancement, aucun débordement à 360 px.
- Aucune variable d'environnement. La table `runbook_steps` est ajoutée à la liste des tables protégées par RLS (`src/db/tenant.ts`).

**Tests** : étapes par type et par canal, avancement (`runbook.test.ts`) ; service sur base réelle : cocher, rejeu, décocher, audit, droits, étape inconnue ou non cochable, autre espace, action déclarée (`runbook.db.test.ts`) ; couverture d'audit ; isolation RLS de la nouvelle table ; E2E navigateur sur trois largeurs : cocher, rechargement, décocher, consigne non cochable (`promotions-guide.spec.ts`).

## US-103 — Confirmation de l'opérateur

**Objectif** : après avoir appliqué l'action dans l'extranet, l'opérateur confirme ce qu'il a réellement fait ; l'application n'en croit pas un simple clic.

- **Règles de confirmation** : une portée réellement appliquée, une date d'entrée en vigueur (jamais dans le futur), et un identifiant de l'extranet **ou** une preuve. La date ne peut pas précéder l'approbation de l'action ; une portée ou une preuve trop longue est refusée (jamais tronquée). La preuve est conservée comme texte, jamais comme lien suivi par l'application. L'avancement du guide pas-à-pas est enregistré mais ne bloque pas la confirmation.
- **Écart constaté** : le formulaire « Signaler un écart » arrête l'action (elle reste approuvée), ouvre un incident `PROMO_MISMATCH` (gravité WARNING) et écrit l'événement d'audit `action.mismatch_reported`. Une confirmation réussie ultérieure referme l'incident.
- **Registre** : la promotion créée porte désormais `actionId`, `effectiveOn`, `proof` et `externalRef`; elles s'affichent dans le registre du logement (« En vigueur depuis », « Preuve », « Origine »).
- **Retrait d'une promotion** : la cible doit exister et être active avant tout changement d'état (sinon refus, l'action reste approuvée) ; elle garde la date réelle, la preuve et l'identifiant.
- **Migration** : `0030_us_103_confirmation_operateur` (idempotente, rejouée deux fois en CI) ; index unique sur `promotions.action_id` : une action ne crée qu'une promotion.
- **Reste à traiter (existant avant l'US)** : le contrôle de doublon du registre n'est pas appliqué à la promotion créée par une action `CHANNEL_PROMO`.
- **Tests** : unitaires (`confirmation.test.ts`), base de données (`confirmation.db.test.ts`), e2e sur trois largeurs (`promotions-confirmation.spec.ts`), fixture partagée `e2e/helpers/dossier.ts`.
- **Variables d'environnement** : aucune ajoutée.

## US-104 — Vérification, période de repos, expiration

**Plan.**
1. **Seconde relecture** (blueprint Annexe B, étape 7) : une action manuelle exécutée ne passe à « vérifiée » que si la vérification vient d'**une autre personne que celle qui l'a confirmée**, ou d'**une relecture faite au moins 24 h après** la confirmation. Sinon refus, l'action reste « exécutée ». La personne qui confirme est conservée dans l'exécution (`declaredBy`) ; sans trace (anciennes actions), seul le délai de 24 h s'applique.
2. **Période de repos** (blueprint §11.3, « cooldown après action ») : après qu'une promotion a été **terminée à la main** sur un canal, une promotion du même type (même canal, même annonce ou annonce non précisée) n'est ni compilée ni approuvée pendant **7 jours**. Une promotion qui s'éteint d'elle-même (séjours passés) ne déclenche pas de repos. Déclarer au registre une promotion déjà en ligne dans l'extranet n'est jamais refusé : le registre reflète la réalité.
3. **Expiration** : au passage du planificateur (toutes les 15 min), toute promotion active ou planifiée dont les séjours sont passés est terminée avec le motif « Expirée : séjours terminés », événement d'audit `promotion.expired` (acteur système, chronologie du logement).
4. Module pur `src/lib/promotions/lifecycle.ts`, service `src/lib/services/promotion-lifecycle.ts`, aucun nouveau champ en base (donc pas de migration), aucune variable d'environnement.
5. Tests : unitaires, base de données (balayage, repos, seconde relecture), e2e sur trois largeurs (expiration visible au registre, refus du compilateur pendant le repos), relecture de code, CI verte avant fusion.

**Livré.**
- Registre : une promotion terminée à la main affiche « Période de repos jusqu'au … » ; le compilateur refuse (`COOLDOWN`) et l'approbation d'une promotion de canal est refusée pendant ce repos.
- Dossier : la règle de relecture est dite avant le clic (« Vous avez confirmé cette action : la relecture revient à une autre personne, ou à vous au moins 24 h après »).
- Planificateur : `expirePromotions` s'exécute à chaque passage, événement d'audit `promotion.expired` (acteur système).
- Tests : `lifecycle.test.ts`, `promotion-lifecycle.db.test.ts`, `promotions-cycle-de-vie.spec.ts` (3 largeurs) ; tests existants adaptés (`rbac.db.test.ts` : la vérification vient d'une autre personne ; `promotion-compiler.db.test.ts` : fin ancienne).
- **Portée de la seconde relecture** : toute action confirmée à la main (promotion, retrait, investigation), conformément à l'Annexe B ; un exploitant seul vérifie donc 24 h après sa confirmation, et la mesure part de la vérification.
- **Repos** : mesuré au logement et au couple canal + type (l'annonce n'est pas distinguée à l'approbation ni à la compilation). Ne comptent pas : l'expiration naturelle (y compris « Terminer » cliqué après la fin des séjours) et le retour arrière d'une action.
- **Déploiement** : aucune migration, aucune variable d'environnement.
