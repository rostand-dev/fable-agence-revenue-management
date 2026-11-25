# Épic 6 — Decision Engine

Blueprint E6 : US-060 (règles de signaux PB-01 à PB-06), US-061 (déduplication, regroupement, repos), US-062 (scoring d'opportunité configurable), US-063 (actions candidates typées), US-064 (policy engine et codes de veto), US-065 (machine à états `RevenueAction`). Ce document est le plan d'implémentation et la référence fonctionnelle de l'épic ; chaque US le complète.

**Point de départ (fin d'épic 5).** `reviewProperty` détecte déjà des opportunités, mais la détection, le regroupement et la construction de l'action sont mêlés dans `detect.ts` ; les seuils sont des constantes dispersées ; aucun playbook n'est nommé ; le score est figé ; les vetos sont implicites ; le cycle de vie d'une action n'est pas verrouillé. L'épic 6 sépare ces briques en modules purs et testés, sans changer le comportement sur les logements de démo.

## Ordre d'implémentation et dépendances

| Ordre | US | Pourquoi à cette place |
|---|---|---|
| 1 | **US-060** Règles de signaux | Socle : les signaux et le catalogue de playbooks sont lus par toutes les autres US. |
| 2 | **US-061** Déduplication, regroupement, repos | Consomme les signaux (clé de déduplication, période de repos par playbook). |
| 3 | **US-062** Scoring configurable | Note les opportunités dédupliquées. |
| 4 | **US-063** Actions candidates typées | Construit les candidats à partir des opportunités notées. |
| 5 | **US-064** Policy engine et vetos | Filtre les candidats par des codes de veto explicites. |
| 6 | **US-065** Machine à états | Dernière : verrouille le cycle de vie des actions issues du moteur. |

**Garde-fou de non-régression** : `review-golden.test.ts` fige (fichiers `__golden__/`) la sortie de `reviewProperty` sur les logements de démo à la date du 12/11/2026. Elle a été générée avant le refactor et doit rester inchangée, sauf évolution voulue (`npx vitest run -u`).

## US-060 — Règles de signaux PB-01 à PB-06

**Ce qui change**
- **Catalogue `src/lib/engine/playbooks.ts`** : les 13 playbooks du blueprint (PB-01 à PB-13) avec seuils nommés, données requises, période de repos, candidats, exclusions, règles de veto, approbateur, vérification et horizon de mesure. Les 13 playbooks sont codés.
- **Signaux `src/lib/engine/signals.ts`** : la détection est séparée de la construction de l'action. Chaque signal porte son playbook, son déclencheur, sa clé de déduplication, ses dates et ses mesures (observé face au seuil). L'ordre de priorité des playbooks est explicite (`SIGNAL_ORDER`).
- **Nouveau PB-04 (écart par canal)** : un canal en retard sur son poids historique alors que le logement tient son rythme global. Il ne se déclenche qu'avec au moins deux canaux, 12 séjours confirmés sur 12 mois, au plus 20 % de canal inconnu et 10 nuits déjà réservées ; sinon il se tait (inconnu ≠ zéro). Il ne se déclenche pas sur les logements de démo.
- **Dossier d'opportunité** : encart « Signal » avec le tableau Mesure / Observé / Seuil et la source (playbook, fenêtre). Les mesures sont stockées dans le champ JSON `signals` existant.
- **Page Méthode** : section « Les playbooks de l'agence », un bloc dépliable par playbook (seuils, données, repos, approbation), lisible sur mobile.
- **Staging (Coolify)** : aucune migration, aucune variable d'environnement nouvelle.

**Limites connues** : les seuils de PB-04, PB-08, PB-09, PB-11 et PB-12 sont des hypothèses de départ, à recalibrer avec les premières données réelles.

**Tests** : unitaires (`signals.test.ts`, 36 cas : un seuil franchi / un seuil juste en dessous par playbook, données manquantes, ordre), non-régression (`review-golden.test.ts`), E2E navigateur (`e2e/playbooks.spec.ts` : page Méthode et dossier, bureau, mobile 390 et 360 px, sans débordement horizontal).

## US-061 — Déduplication, regroupement et période de repos

**Ce qui change**
- **Module pur `src/lib/engine/lifecycle.ts`** : `openingDecision` (créer, rafraîchir ou laisser fermé), `dedupeOpportunities`, `groupKeys`.
- **Déduplication** : un même signal (logement, playbook, clé) ne produit qu'un dossier, d'une revue à l'autre (le dossier ouvert est rafraîchi) et au sein d'une revue (le plus prioritaire est gardé ; avant, deux signaux de même clé pouvaient créer deux dossiers).
- **Période de repos par playbook** : après une décision humaine, le même signal ne rouvre pas de dossier pendant la durée `cooldownDays` du playbook (14 jours pour PB-01, voir la page Méthode), **comptée depuis la décision** (avant : 21 jours pour tous, comptés depuis l'ouverture du dossier). Un dossier différé reste fermé jusqu'à son échéance. Rouvrir un dossier à la main reste possible et remet la date de décision à zéro.
- **Regroupement** : les dossiers ouverts d'un même logement dont les nuits se touchent ou se chevauchent partagent une clé ; le dossier affiche les « Dossiers liés ». Un dossier tranché affiche sa période de repos (« jusqu'au … »).
- La revue journalise le nombre de dossiers « en période de repos ou différés ».
- **Staging (Coolify)** : migration **0022** (colonnes `decided_at` et `group_key`, index `opps_group`, rattrapage de `decided_at` pour les dossiers déjà tranchés). Elle est idempotente (`IF NOT EXISTS`, `UPDATE` ciblé) et s'applique au démarrage comme les précédentes. Aucune variable d'environnement.

**Limites connues** : le regroupement est affiché sur le dossier seulement (pas encore sur la liste d'accueil) ; les clés de groupe suivent la première nuit du groupe et peuvent donc changer quand les fenêtres glissent.

**Tests** : unitaires (`lifecycle.test.ts`), base (`lifecycle.db.test.ts` : rejouer la revue sans doublon, repos puis réouverture, date remise à zéro ; test de migrations existant rejoué deux fois), non-régression (golden), E2E (`e2e/cycle-dossiers.spec.ts`, 3 viewports).

## US-062 — Scoring d'opportunité configurable

**Ce qui change**
- **Module pur `src/lib/engine/scoring.ts`**, formule du blueprint §9.2 : `priorité = gain net attendu × confiance × urgence × poids du playbook − coût d'exécution − pénalité de risque`. `priorityScore` (moteur) délègue au module avec le réglage par défaut : **les scores existants sont inchangés** (snapshot de non-régression).
- **Réglable par espace** (Réglages → « Priorisation des dossiers ») : poids par playbook (0 à 5, 1 = neutre), pénalité par niveau de risque (0 à 1000 points ; défaut 0 / 4 / 10 / 25), coût d'exécution par mode (euros, 0 à 1000 ; défaut 0). Rétablir les valeurs par défaut en un bouton. Une saisie hors bornes est refusée avec le champ nommé ; une valeur enregistrée illisible retombe sur le défaut (jamais sur zéro). Seuls les écarts au défaut sont enregistrés. Chaque changement est inscrit au journal d'audit (`settings.scoring_updated`).
- **Le score ne contourne jamais un veto** : un dossier sous veto remonte pour être traité, mais n'ouvre aucune action.
- **Dossier** : encart « Pourquoi cette priorité » avec la décomposition du score. Les changements s'appliquent à la prochaine revue des logements.
- La déduplication (US-061) départage maintenant avec le score réglé de l'espace.
- **Staging (Coolify)** : aucune migration (réglage stocké dans les paramètres existants de l'espace), aucune variable d'environnement.

**Limites connues** : le coût d'exécution ne dépend que du mode d'exécution ; le poids stratégique est par playbook (pas encore par logement) ; le facteur d'urgence reste calculé par le moteur.

**Tests** : unitaires (`scoring.test.ts`, 10 cas dont la formule calculée à la main, bornes, virgule française, veto), base (`scoring.db.test.ts` : le réglage change la priorité à la revue puis se rétablit, configuration illisible), non-régression (golden inchangé), E2E (`e2e/priorisation.spec.ts`, 3 viewports).

## US-063 — Génération d'actions candidates typées

**Ce qui change**
- **Contrat par type d'action `src/lib/engine/candidates.ts`** (10 types : prix daté, séjour minimum daté, exclusion de règle, prix de base, prix minimum, promotion de canal, retrait de promotion, audit d'annonce, vérification manuelle, ne rien faire) : systèmes cibles permis, modes d'exécution permis (une action PriceLabs sans capacité d'écriture reste proposée en procédure manuelle), paramètres obligatoires avec leurs bornes (dates ISO, entiers, remise de promotion de 1 à 40 %, séjour minimum de 1 à 30 nuits…), nuits touchées, plan de retour arrière et fenêtre de mesure pour toute action exécutable.
- **Conformité au playbook** : une candidate dont le type n'est pas permis par son playbook (catalogue de la page Méthode) est refusée.
- **Garde-fou dans le moteur** : toute candidate non conforme est **retirée avant d'être proposée** (jamais affichée, jamais approuvable) ; si l'option retenue est retirée, « ne rien faire » est retenu ; sans candidate conforme, le dossier n'est pas ouvert. La revue journalise chaque candidate retirée et son écart (`CANDIDATE_CONFORMITY`). Sur les données de démonstration et les scénarios testés, aucune candidate n'est retirée : les dossiers existants sont inchangés (snapshot de non-régression).
- **Staging (Coolify)** : aucune migration, aucune variable d'environnement.

**Limites connues** : le contrat vérifie la forme et les bornes de chaque candidate, pas la pertinence économique (rôle de l'auditeur, US-064) ; les limites de variation de prix par action et par semaine relèvent du policy engine.

**Tests** : unitaires (`candidates.test.ts` : contrat de chaque type, bornes, refus, retrait et re-sélection, et 12 scénarios réels vérifiant que le moteur ne produit que des candidates conformes), non-régression (golden inchangé), suites existantes (markups, PB-13).

## US-064 — Policy engine et codes de veto

**Ce qui change**
- **Registre unique `src/lib/engine/policy.ts`** des règles de l'auditeur (12 au départ, 13 avec INDEPENDENT_REVIEW depuis l'US-073, 15 avec STRUCTURAL_LOCK et MAX_VARIATION_7D), chacune avec son code stable : ce qu'elle contrôle, ce que produit un **échec** (veto : l'option est rejetée) ou une **alerte** (validation humaine avec commentaire), l'origine de son seuil et sa référence au blueprint. Codes : `HARD_FLOOR`, `STRATEGY_FLOOR`, `DISCOUNT_STACK`, `STACK_RULES`, `MAX_VARIATION`, `MAX_VARIATION_7D`, `STRUCTURAL_LOCK`, `SCOPE`, `STRUCTURAL`, `MIN_PRICE_DOWN`, `PROMO_FRESHNESS`, `CONFLICT`, `ROLLBACK`, `CAPABILITY`.
- **Verdict** : `verdictOf` (un échec rejette, une alerte demande un humain, sinon conforme) est la seule définition ; chaque verdict enregistre maintenant ses `vetoCodes` et `humanCodes`. `explainVerdict` en donne une phrase lisible.
- **Nouvelle règle `MIN_PRICE_DOWN`** : toute baisse du prix minimum PriceLabs est signalée à valider avec commentaire, l'approbation du propriétaire ou du mandat restant portée par l'approbateur du playbook (blueprint §11.2, risque critique) ; elle se lit dans les paramètres de l'option, pas seulement dans le pourcentage. Aucune option actuelle du moteur ne baisse le prix minimum ; la règle verrouille ce cas avant qu'il n'existe.
- **Cohérence contrôlée** : un test échoue si le moteur émet une règle absente du registre, un résultat qu'elle ne déclare pas (par exemple un veto sur une règle d'alerte), ou si un playbook cite une règle de veto inconnue.
- **Page Méthode** : section « Les règles de l'auditeur » (une fiche dépliable par code) et, dans chaque playbook, « Règles qui peuvent rejeter une option ».
- Les décisions du moteur sont inchangées (snapshot de non-régression) ; les verdicts déjà enregistrés restent lisibles (champs de codes facultatifs).
- **Staging (Coolify)** : aucune migration, aucune variable d'environnement.

**Limites connues** : la limite de variation par période de sept jours et les permissions par rôle (RBAC, épic 8) ne sont pas encore des règles ; la fraîcheur des sources autres que le registre de promotions est contrôlée à la collecte (épic 4), pas ici.

**Tests** : unitaires (`policy.test.ts` : verdicts, registre, chaque veto nommé, bornes de variation, règle MIN_PRICE_DOWN, cohérence sur 12 scénarios de revue), non-régression (golden), E2E (`e2e/playbooks.spec.ts`, 3 viewports).

## US-065 — Machine à états `RevenueAction`

**Ce qui change**
- **Le cycle de vie est verrouillé par la base elle-même.** La migration `0023_us_065_action_transitions.sql` ajoute un déclencheur `ns_action_check_transition` : une action ne naît qu'à l'état `DRAFT`, et tout changement d'état doit suivre le graphe de `src/lib/engine/stateMachine.ts` (pas de saut, pas de retour, états terminaux sans sortie). Une écriture qui ne change pas l'état reste neutre.
- **Historique des transitions** : la table `action_transitions` (isolée par locataire, lecture et ajout seuls pour le rôle applicatif) reçoit une ligne à chaque changement d'état, écrite par un second déclencheur, donc impossible à oublier. Les actions déjà existantes reçoivent une ligne de départ (rattrapage rejouable) ; leur statut n'est pas revalidé par la migration.
- **Dossier** : section « Historique des transitions » (lisible sur mobile) sous le suivi d'application.
- **Helpers** `nextStates`, `isTerminal`, `TERMINAL_STATES`, `allTransitions` ; un test compare la base au graphe applicatif sur toutes les paires d'états.
- **Démo** : l'historique de démonstration rejoue la chaîne complète jusqu'à `CLOSED` au lieu d'insérer directement un état avancé.
- **Staging (Coolify)** : la migration 0023 est idempotente et s'applique au démarrage ; aucune variable d'environnement nouvelle.

**Limites connues** : le motif d'une transition n'est pas stocké dans l'historique (il reste au journal d'audit) ; les statuts hors graphe ne sont plus insérables, y compris pour d'éventuels scripts externes.

## Approbation renforcée (playbooks à validation du propriétaire)

`src/lib/engine/approval.ts` est la source unique de l'exigence de commentaire à l'approbation. Un commentaire d'au moins 8 caractères est obligatoire si l'option est à risque élevé ou critique, si l'auditeur demande une validation humaine, ou si le playbook a pour approbateur « responsable et propriétaire » (`REVENUE_MANAGER_AND_OWNER`) et que l'option est exécutable (hors inaction, audit d'annonce et vérification manuelle). Le serveur applique la règle (`decisions.ts`), l'écran n'est qu'un reflet. Un seul compte suffit : le commentaire tient lieu de trace de la validation du propriétaire. Aucune migration, aucune variable d'environnement. Les playbooks à approbateur « opérateur et responsable » n'exigent rien de plus.

## Historique de réservations pour les playbooks de demande (PB-08, PB-09, PB-11, PB-12)

`src/lib/engine/history.ts` (module pur) expose `cancellationStats` (annulations d'une fenêtre : nombre, nuits, taux, canaux, nuits rouvertes à venir) et `paceComparison` (prises de réservation, durée médiane de séjour et mix de canaux : fenêtre récente contre fenêtre de référence). L'entrée du moteur porte `cancellations`, `cancellationTracking` (début de l'historique) et `firstBookingDate`, chargés par `loadEngineInput` depuis `reservation_changes` (120 derniers jours, par locataire). La détection d'annulation est partagée avec le pacing (`reservations/cancellations.ts`). Principe : l'historique SuperHote ne remonte qu'à sa première lecture ; une fenêtre qui commence avant ce jour est « inconnue », jamais « zéro annulation ». Aucune migration, aucune variable d'environnement.
Limites assumées : l'historique est connu à partir du lendemain de la première lecture ; une interruption des webhooks au milieu de l'historique n'est pas détectée ; profondeur maximale de 120 jours (`MAX_HISTORY_DAYS`), au-delà la réponse est « inconnu ».

## PB-08 · dates rouvertes par une annulation

Signal : une annulation enregistrée depuis au plus 3 jours rouvre au moins 2 nuits à venir (horizon 60 jours) encore libres au calendrier. Silencieux tant que l'historique des annulations est inconnu ou plus court que la fenêtre. Un dossier par séjour annulé (clé canal + dates), option « relire le calendrier et les promotions » (aucune écriture, aucune remise), inaction retenue quand les nuits sont à plus de 45 jours. Le taux d'annulation sur 14 jours est un indicateur (inconnu sous 4 réservations) qui relève l'urgence, pas l'option. PB-08 ne marque aucune nuit et ne déclenche pas de repos de groupe.
La relecture porte `subject: "CALENDAR"` : sa confirmation n'horodate pas les promotions du canal (réservé à la vérification du registre, PB-10), et son guide opérateur est propre. PB-08 est une relecture sans hypothèse structurante : elle peut coexister avec un dossier de prix (PB-01, PB-03) sur les mêmes dates, l'arbitrage restant à la gestionnaire. La fenêtre de recherche (3 jours) ne doit pas dépasser la période de repos (3 jours), sans quoi un dossier décidé pourrait se rouvrir pour la même annulation (test d'invariant).

## PB-09 · séjours longs en basse saison

Signal : au moins 7 nuits libres consécutives, entre J+8 et J+90, sur des nuits dont l'occupation moyenne du marché est au plus de 40 % (basse saison **définie par la donnée**, jamais par un libellé : une nuit sans donnée de marché écarte tout le trou). Les fenêtres où le logement est déjà en retard sur son marché relèvent de PB-01 et sont écartées. Le trou est ciblé sur 28 nuits au plus, deux trous au plus par revue. Options : remise de durée de séjour Airbnb 7 nuits (10 %), 14 nuits (12 %), 28 nuits (18 %) selon la longueur du trou ; sur Booking, aucun type équivalent au registre de cumul : seule une vérification manuelle est proposée (aucune remise inventée). Une offre dont le prix vendu passe sous un plancher, ou qui dépasse le plafond de cumul, est rejetée par l'auditeur ; une offre de durée de séjour déjà active écarte une seconde remise du même type. Une remise de durée de séjour au-delà de 15 % exige un commentaire d'approbation (`approval.ts`, §11.2). L'offre prend la forme d'une promotion de canal manuelle : confirmation et suivi par le registre des promotions.
Limites assumées de PB-09 : la clé de dédoublonnage est la fin du trou réel (stable d'un jour à l'autre) ; le gain attendu est celui d'une baisse de prix équivalente sur toutes les nuits du trou (surestimé pour une offre qui ne vaut que pour les séjours longs, le classement des paliers est donc indicatif, signalé dans l'hypothèse) ; la durée de séjour demandée par le marché n'est pas mesurée.

## PB-11 · prix de base trop bas (lu dans le logement lui-même)

Signal : le délai médian de réservation des 28 derniers jours dépasse d'au moins 50 % (et 14 jours) celui des 56 jours précédents, avec au moins 6 réservations dans chaque fenêtre, un rythme de prises récent au moins égal à la référence (à longueur égale) et un mix de canaux stable (déplacement de part ≤ 25 points). Il se compare au logement lui-même : aucune donnée de marché n'est requise (le gain n'est alors pas chiffré, et le dit). Silencieux si l'historique ne couvre pas la référence (première réservation connue) ; PB-02 (avance sur le marché) est prioritaire. Option : un palier de +4 % du prix de base sur les nuits libres de J+14 à J+90, sous le verrou structurant, le plafond de 15 % sur 7 jours et l'approbation du propriétaire (commentaire obligatoire) ; PB-02, PB-11 et PB-12 partagent un repos de groupe. Limite : le délai de réservation peut aussi s'allonger pour une saison ou une durée de séjour différente (dit dans la confiance).

Précisions après relecture : les 6 réservations minimales comptent les délais valides (arrivée non antérieure à la réservation) ; des parts de canal non comparables rendent PB-11 silencieux ; le gain n'est chiffré que si **toutes** les nuits visées ont une donnée de marché, et à demande constante (le délai motive la hausse sans être converti en demande) ; PB-11 prime sur PB-01, PB-04, PB-08 et PB-09 pour les nuits J+14 à J+90 (hausse et baisse ne se superposent pas) ; les réservations annulées sont exclues des fenêtres, ce qui peut gonfler l'allongement. Tests : `pb11.test.ts` (bornes exactes, canal inconnu, délais incohérents, priorité sur PB-01).

## PB-12 · prix de base trop haut (retard qui dure)

Signal : mêmes fenêtres en retard que PB-01 (écart d'occupation au marché ≤ −20 points, J+8 et au-delà), mais le retard est **suivi depuis au moins 21 jours** : le moteur lit l'ancienneté du plus ancien dossier de rythme encore vivant du logement (PB-01 à sa création, PB-12 via `lagSince` qu'il porte, car il remplace PB-01 sans effacer l'ancienneté). Chaque fenêtre retenue a un prix au moins au 70e percentile du marché, un marché occupé à 35 % ou plus, un séjour minimum non restrictif, aucune promotion active et aucune action en observation ; au moins 6 nuits libres au total. Les autres causes de l'arbre de diagnostic restent à PB-01. PB-02 et PB-11 (hausse) sont prioritaires : un seul sens à la fois.

Décision : la visibilité et la conversion de l'annonce ne sont pas lisibles sans accès partenaire (« inconnu »), donc « contenu/visibilité non exclus » : l'**audit de l'annonce est l'option retenue**. La baisse du prix de base (−4 %) est proposée et chiffrée à demande constante, mais jamais présélectionnée ; elle passe par le verrou structurant, le plafond de 15 % sur 7 jours, le plancher et l'approbation du propriétaire (commentaire obligatoire). Observation : 14 jours ; repos de groupe avec PB-02 et PB-11.

Ancienneté du retard : chaque dossier PB-01 (cause de prix, `PACE_BELOW_MARKET`) et PB-12 porte `signals.lagSince`, la date de première détection, que le dossier suivant reprend. Le moteur lit le plus ancien `lagSince` parmi les dossiers suivis : refraîchis, ou interrompus depuis moins de 14 jours (tolérance `lagGapToleranceDays`, qui absorbe un repos de groupe ou une revue manquée). Un dossier tranché ou expiré depuis plus longtemps ne prolonge pas un retard résolu : le compteur repart de zéro. Approuver un audit (ou une inaction) ne met pas PB-02/PB-11/PB-12 au repos de groupe : seul un prix de base approuvé le fait. Une promotion sur une seule nuit d'une fenêtre écarte cette fenêtre.

Historique daté (table `market_gap_history`, migration 0035) : chaque revue écrit, par logement, jour et fenêtre (même pour un logement bloqué par le modèle économique : le marché n'en dépend pas), l'écart d'occupation au marché ; la dernière revue du jour fait foi, purge au-delà de 120 jours, une erreur d'écriture est journalisée sans interrompre la revue. Un marché inconnu s'enregistre `null`, jamais zéro. `lagRunStart` (module pur `history.ts`) en tire le début du retard en cours : un jour est « en retard » si une fenêtre (hors J+0 à J+7) passe le seuil de PB-12, « normal » sinon, « ignoré » si aucun écart n'est connu ; un jour normal coupe la série, une collecte interrompue plus de 14 jours aussi, et une série compte au moins 3 jours en retard observés (deux relevés isolés ne font pas un retard qui dure). Arbitrage entre les deux preuves : si le dernier jour connu de l'historique (dans la tolérance) est normal, le retard est **résolu** et aucun vieux dossier ne le prolonge ; sinon le moteur garde la plus ancienne des deux preuves (historique daté, dossiers de rythme). Le seuil de l'historique est celui de PB-12 (−0,20), plus strict que PB-01 (−0,18), qui alimente les dossiers : un retard entre les deux n'est vu que des dossiers. L'observation du jour n'est écrite qu'après le chargement : elle n'entre dans la lecture qu'à la revue suivante. La collecte démarre au déploiement : PB-12 ne peut s'appuyer sur l'historique qu'après 21 jours d'observation, les dossiers de rythme servant d'appui d'ici là.

Limites : tant que l'historique daté est jeune, la durée vient aussi des dossiers de rythme du moteur ; sans historique ni dossier suivi, la durée est inconnue et PB-12 se tait ; un retard interrompu plus de 14 jours remet le compteur à zéro ; un délai de réservation inconnu laisse la fenêtre ouverte (même convention que PB-01) ; la période de repos de 21 jours de PB-12 retarde d'autant la baisse après approbation de l'audit. Tests : `pb12.test.ts`.
