# Épic 11 — Experiments & Reporting

Blueprint E11 (P1) : US-110 (baseline et fenêtres de mesure), US-111 (résultat positif, neutre, négatif ou non concluant), US-112 (rapport mensuel certifié par les métriques), US-113 (export CSV/PDF et historique). Ce document est le plan d'implémentation et la référence fonctionnelle de l'épic ; chaque US le complète au fur et à mesure de sa livraison.

**Point de départ (fin d'épic 10).** Une action exécutée puis vérifiée passait à « en mesure », et le planificateur la refermait au bout de la fenêtre avec une mesure **sommaire** : il comptait les nuits réservées sur les séjours visés avant et après, sans fenêtre de référence, sans rythme et sans garde-fou de données (`measureDueActions`, résultat positif ou neutre ou non concluant, jamais négatif). Le bilan mensuel (`/bilan`) restait une page de lecture, non figée, sans certification. L'épic 11 en fait une **boucle de mesure honnête** : figer ce qui précède l'action → comparer à ce qui suit → dire ce que l'on sait et ce que l'on ignore → rapporter, sans chiffre qui ne vienne des métriques.

## Principes de l'épic

1. **Une référence figée avant l'effet** (blueprint §12.4 : les snapshots sont immuables). La baseline est calculée AVANT d'écrire l'action, dans les mêmes données que la mesure, puis protégée en base par un déclencheur : elle ne se corrige pas après coup.
2. **Une donnée absente n'est jamais un zéro** (principe déjà appliqué au net partiel et au pacing). Sans historique suffisant, la baseline est « insuffisante » et la mesure est **non concluante** ; une action antérieure à l'épic n'a pas de référence et ne s'en voit pas inventer une.
3. **Corrélation n'est pas causalité.** Aucune période témoin n'existe : l'effet incrémental reste « inconnu » ; un résultat « positif » veut dire « le rythme de réservation s'est accéléré après l'action », jamais « l'action a rapporté X € ».
4. **Aucun chiffre de rapport hors métriques certifiées** (blueprint §6.5) : les chiffres d'un rapport viennent d'un instantané figé des métriques ; le texte ne peut citer aucun nombre absent de cet instantané ; une personne habilitée certifie.
5. **Isolation par propriétaire d'espace** (filtres applicatifs + RLS sur chaque nouvelle table), journal d'audit pour chaque geste, nouveaux droits dans la matrice de rôles.
6. **Aucune régression** : golden cases inchangés, E2E complet sur trois largeurs (bureau, 390 et 360 px), migrations rejouables deux fois, CI verte avant chaque fusion.

## Ordre d'implémentation et dépendances

| Ordre | US | Pourquoi à cette place |
|---|---|---|
| 1 | **US-110** Baseline et fenêtres de mesure | Fondation : table `experiments` (une par action exécutée), baseline figée, fenêtres de séjours / référence / observation. La mesure et le rapport lisent ce qu'elle fige. |
| 2 | **US-111** Résultat de l'expérience | Consomme la baseline et la fenêtre d'observation pour classer le résultat ; produit la table `experiment_measurements`, que le rapport cite. |
| 3 | **US-112** Rapport mensuel certifié | Assemble les métriques du mois et les résultats mesurés (US-111) ; ne se conçoit qu'une fois les résultats classés. |
| 4 | **US-113** Export CSV/PDF et historique | Dernier : exporte et archive ce que les trois autres produisent (rapports certifiés, mesures). |

Chaque US est livrée par sa propre PR, fusionnée seulement quand la CI est verte, après relecture de code par un agent indépendant.

## US-110 — Baseline et fenêtres de mesure

**Ce qui change.** Chaque action exécutée a une **expérience** (blueprint §12.1 « RevenueAction 0─1 Experiment »). Au moment de l'exécution, la baseline est figée ; à la vérification, la fenêtre d'observation est fixée.

- **Trois fenêtres** (jours civils Europe/Paris, début inclus, fin exclue ; module pur `src/lib/experiments/windows.ts`) :
  - **séjours visés** : nuits du dossier encore à vendre le jour de l'entrée en vigueur (une nuit déjà passée ne peut ni servir de référence ni mesurer un effet) ;
  - **référence** : les 14 jours de réservation qui précèdent l'entrée en vigueur ;
  - **observation** : de l'entrée en vigueur au jour de la mesure (exclu), fixée à la vérification.
- **Entrée en vigueur** : la date déclarée par l'opérateur pour une procédure manuelle (jamais dans le futur ; jamais avant l'approbation, règle de l'US-103), sinon le jour de l'exécution.
- **Contenu de la baseline** (`src/lib/experiments/baseline.ts`, module pur) : état des séjours visés (réservées, bloquées, disponibles, occupation) ; **rythme de référence** (nuits des séjours visés réservées pendant les 14 jours précédents, brut et net connu) ; **comparable de l'an passé** (même fenêtre décalée de 52 semaines, pour garder les jours de semaine) quand l'historique remonte assez loin.
- **Baseline insuffisante** (`sufficient: false`, raison dite) : toutes les nuits visées déjà passées, aucune réservation connue, historique qui ne remonte pas jusqu'à la fenêtre de référence. Le net ne somme que les nuits dont la commission est connue et dit combien (jamais complété par un zéro).
- **Immuabilité** : déclencheur `ns_experiment_freeze` — la baseline, les fenêtres de référence et de séjours, la date d'entrée en vigueur, l'action et la date de capture ne se modifient plus. L'état et la fenêtre d'observation, eux, évoluent.
- **Cycle** : `AWAITING_VERIFICATION` (baseline figée, action pas encore vérifiée) → `OBSERVING` (fenêtre fixée à la vérification) → `MEASURED` (US-111) ; `CANCELLED` si un retour arrière annule l'action avant la mesure. Une seule expérience par action (index unique) ; créée dans la transaction d'exécution : une action exécutée a toujours son expérience.
- **Actions déjà exécutées avant l'épic** : la migration crée une expérience « héritée » (`legacy`, version 0) sans fenêtre de référence ni rythme. Leur mesure sera non concluante : une baseline qui n'a pas été figée ne s'invente pas.
- **Affichage** : bloc « Expérience » dans l'étape « Résultat observé » du dossier (état, entrée en vigueur, séjours visés, fenêtre de référence, rythme, net par nuit, occupation, an passé, observation, limites), une colonne sur mobile ; terme « Référence avant action » au glossaire.
- **Droits** : lecture pour tous ceux qui voient le dossier ; aucune écriture directe (l'expérience naît de l'exécution et évolue avec la vérification).
- **Migration `0031_us_110_experiments`** (idempotente : `IF NOT EXISTS`, contraintes gardées, `CREATE OR REPLACE`, insertion des expériences héritées gardée par `NOT EXISTS`) ; RLS sur la nouvelle table (lecture, ajout, mise à jour ; jamais de suppression). **Aucune variable d'environnement.**

**Tests** : fenêtres (`windows.test.ts`) ; baseline — insuffisances, net partiel, annulations, an passé (`baseline.test.ts`) ; service sur base réelle — baseline figée dans la transaction d'exécution, date déclarée, unicité, immuabilité, observation à la vérification, annulation par retour arrière, isolation entre espaces, cascade (`experiments.db.test.ts`) ; E2E navigateur sur trois largeurs (`experiments-baseline.spec.ts`).

## US-111 — Résultat positif, neutre, négatif ou non concluant

*Plan.*
1. **Classification pure** (`src/lib/experiments/outcome.ts`) : compare le rythme de réservation observé (mêmes séjours visés, nuits réservées pendant la fenêtre d'observation) au rythme de référence figé.
   - **Non concluant** (jamais deviné) : baseline héritée ou insuffisante, séjours déjà passés, observation de moins de 3 jours, **réservations non synchronisées récemment** (une absence de réservation ne prouve rien si la source est en retard), **autre action mêlée** (même logement, séjours et observation qui se recoupent : effets non séparables, blueprint §6.4).
   - **Positif** : au moins 2 nuits de plus que ce que la référence laissait attendre ET +25 % ou plus ; **négatif** : au moins 2 nuits de moins ET −25 % ou moins ; sinon **neutre**.
   - **Dilution** : un résultat positif en volume dont le net par nuit baisse de plus de 15 % (net connu des deux côtés) passe à **neutre** — le gain en volume n'est pas démontré en revenu.
2. **Table `experiment_measurements`** (migration `0032`, idempotente) : une mesure finale par expérience, **immuable** (déclencheur : ni modification ni suppression), résultat, motifs, chiffres comparés, fenêtres. Les actions déjà refermées avant l'épic reçoivent une mesure « héritée ».
3. **Planificateur** : `measureDueActions` s'appuie sur l'expérience (fenêtre d'observation figée à la vérification) et écrit la mesure dans la même transaction que la fermeture de l'action ; `revenue_actions.measurement` reste alimenté pour les écrans existants. Événement d'audit `experiment.measured` enrichi.
4. **Affichage** : résultat et motifs dans le dossier, l'historique et le bilan ; glossaire.
5. Tests unitaires de la classification (bornes exactes), base de données (mesure, immuabilité, chevauchement, fraîcheur), E2E sur trois largeurs.

## US-112 — Rapport mensuel certifié par les métriques

*Plan.*
1. **Instantané certifiable** : les métriques d'un logement pour un mois (revenu net, prix moyen net, revenu net par nuit disponible, occupation, canaux, écart au marché quand il est connu, actions menées et résultats mesurés, décisions ouvertes) sont figées dans un rapport versionné ; une valeur inconnue reste « inconnue ».
2. **Texte** assemblé par règles à partir de l'instantané (aucun modèle de langage), modifiable par une personne habilitée ; **garde-fou** : tout nombre du texte doit exister dans l'instantané, sinon la certification est refusée avec la liste des nombres en cause.
3. **Certification** (nouveau droit `report.certify`, revenue manager, administrateur et propriétaire du compte) : le rapport certifié est figé (déclencheur) ; régénérer crée une nouvelle version, l'ancienne reste dans l'historique. Audit de chaque geste.
4. Pages `/rapports` et `/rapports/[id]`, lien depuis le bilan mensuel ; migration `0033` idempotente avec RLS.
5. Tests unitaires (garde-fou de nombres, instantané), base de données (versions, certification, droits, isolation), E2E sur trois largeurs.

## US-113 — Export CSV/PDF et historique

*Plan.*
1. **CSV** (`;` et BOM UTF-8 pour Excel en français, cellules protégées contre l'injection de formules) du rapport certifié et de l'historique des mesures ; **PDF** du rapport généré sans dépendance (module pur).
2. **Historique** : liste des rapports par logement et par mois (toutes les versions) et des mesures d'expériences, filtres, depuis `/rapports`.
3. Les exports sont des lectures authentifiées, isolées par propriétaire d'espace, tracées au journal d'audit (`report.exported`) ; un brouillon ne s'exporte pas comme certifié.
4. Tests unitaires (CSV, PDF), base de données, E2E sur trois largeurs (téléchargements compris).

## Déploiement (staging Coolify)

Renseigné à la fin de chaque US : migrations à jouer, variables d'environnement (aucune ajoutée pour l'instant), points à vérifier.
