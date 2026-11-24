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

**Livré et précisions issues de la relecture.**
- L'état des séjours (réservées, occupation) est lu **à la date d'entrée en vigueur** : une procédure déclarée avec une date passée ne mêle pas les réservations postérieures. Les nuits bloquées et les annulations ne se reconstituent pas pour une date passée : la baseline porte alors `capturedLate` et l'écran le dit.
- Le déclencheur fige aussi l'identité de l'expérience (espace, logement, dossier) et la fenêtre d'observation une fois fixée ; une contrainte refuse une fenêtre inversée. Une mesure prévue au plus tard le jour d'entrée en vigueur ne fixe aucune fenêtre (mesure non concluante, US-111).
- La clôture de la mesure marque l'expérience « mesurée » ; la migration lit les dates déclarées de façon tolérante (une date inexistante ne fait pas échouer la migration).
- Limite assumée : l'historique « connu » ne compte que les réservations confirmées ; si les plus anciennes ont été annulées, la baseline peut être jugée insuffisante à tort (choix prudent).

## US-111 — Résultat positif, neutre, négatif ou non concluant

*Plan.*
1. **Classification pure** (`src/lib/experiments/outcome.ts`) : compare le rythme de réservation observé (mêmes séjours visés, nuits réservées pendant la fenêtre d'observation) au rythme de référence figé.
   - **Non concluant** (jamais deviné) : baseline héritée ou insuffisante, séjours déjà passés, observation de moins de 3 jours, **réservations non synchronisées récemment** (une absence de réservation ne prouve rien si la source est en retard), **autre action mêlée** (même logement, séjours et observation qui se recoupent : effets non séparables, blueprint §6.4).
   - **Positif** : au moins 2 nuits de plus que ce que la référence laissait attendre ET +25 % ou plus ; **négatif** : au moins 2 nuits de moins ET −25 % ou moins ; sinon **neutre**.
   - **Dilution** : un résultat positif en volume dont le net par nuit baisse de plus de 15 % (net connu des deux côtés) passe à **neutre** — le gain en volume n'est pas démontré en revenu.
2. **Table `experiment_measurements`** (migration `0032`, idempotente) : une mesure finale par expérience, **immuable** (déclencheur contre toute modification ; pas de suppression autre que la cascade avec le logement ou l'action : le rôle applicatif n'a pas le droit de supprimer), résultat, motifs, chiffres comparés, fenêtres. Les actions déjà refermées avant l'épic reçoivent une mesure « héritée ».
3. **Planificateur** : `measureDueActions` s'appuie sur l'expérience (fenêtre d'observation figée à la vérification) et écrit la mesure dans la même transaction que la fermeture de l'action ; `revenue_actions.measurement` reste alimenté pour les écrans existants. Événement d'audit `experiment.measured` enrichi.
4. **Affichage** : résultat et motifs dans le dossier, l'historique et le bilan ; glossaire.
5. Tests unitaires de la classification (bornes exactes), base de données (mesure, immuabilité, chevauchement, fraîcheur), E2E sur trois largeurs.

**Livré et précisions issues de la relecture.**
- Mesure : `measureExperiment` (service) lit les nuits vendues des séjours visés, la fraîcheur des réservations et les chevauchements, appelle `classifyOutcome` (module pur) et écrit la mesure dans la transaction de clôture. `revenue_actions.measurement` (JSON) reste alimenté pour les écrans existants : **source de vérité des chiffres = `experiment_measurements`**, le JSON en est la copie pour l'affichage (à lire dans la table pour les rapports).
- Fraîcheur des réservations : SuperHote fait foi ; à défaut PriceLabs ; démonstration toujours fraîche ; un logement sans aucune source reliée (saisie manuelle) n'a pas de date de synchronisation : rien n'est opposé, limite dite dans « Méthode ».
- Chevauchement : une expérience pas encore mesurée compte tant qu'elle est ouverte ; une expérience héritée déjà mesurée, sans fin d'observation, s'arrête à son entrée en vigueur ; annulées exclues. Les séjours comparés sont ceux du dossier (choix prudent).
- Mesures héritées : `legacy = true` (migration, démonstration et mesure d'une action sans référence figée).
- Seuils : 2 nuits et 25 % d'écart, 3 jours d'observation, dilution à −15 % de net par nuit ; avec très peu de nuits attendues (2 nuits d'écart), le résultat reste de confiance « faible » et dit qu'il s'agit d'une corrélation.
- **Déploiement** : migration `0032_us_111_mesures` (idempotente, rétro-remplissage des actions déjà refermées), aucune variable d'environnement.

## US-112 — Rapport mensuel certifié par les métriques

**Ce qui change.** Un rapport par logement et par mois terminé (24 derniers mois), préparé, relu, retouché si besoin, puis **certifié** par une personne habilitée. Écrans : `/rapports` (liste, préparation) et `/rapports/[id]` (rapport) ; lien depuis le bilan mensuel ; terme « Rapport certifié » au glossaire.

- **Instantané** (`src/lib/reports/monthly.ts`, module pur ; lecture en base dans `src/lib/services/reports.ts`) : revenu net, occupation, prix moyen net, revenu net par nuit disponible (mois et mois précédent), canaux, occupation du marché et écart (seulement si le marché est connu sur la moitié du mois), actions dont la mesure tombe dans le mois (résultat US-111 repris tel quel), décisions du mois, situations ouvertes. Une valeur inconnue reste « inconnue » : net partiel → net par nuit disponible et tendances nettes inconnus ; aucune commission connue → net inconnu (jamais 0) ; sans nuit vendue le mois précédent → tendances inconnues. Contribution et objectif sont dits inconnus (non suivis).
- **Texte** assemblé par règles (aucun modèle de langage) : faits marquants et **tendance nommée** (croissante / stable / décroissante, ±3 % comme le bilan), pas tous les chiffres.
- **Garde-fou** (durci après relecture) : le texte est normalisé (chiffres pleine chasse, espaces Unicode, apostrophes) ; un montant suivi de « € » doit venir d'un montant de l'instantané (centimes ÷ 100), un pourcentage d'un ratio × 100 (le facteur 100 n'est plus toléré) ; les chiffres non latins et les nombres écrits en lettres (douze, mille, moitié…) sont refusés ; le texte doit garder les mentions « Contribution non calculée », « Écart à l'objectif inconnu » et, selon le cas, celles du net partiel et de l'absence d'effet attribué ; un vocabulaire causal (« grâce à », « a permis », « a généré »…) est refusé. Tout nombre du texte doit figurer dans l'instantané (valeurs, centimes, pourcentages, arrondis usuels, nombres des résumés certifiés, mois et année de lecture). Sinon l'enregistrement et la certification sont refusés, avec la liste des nombres en cause. Texte vide ou de plus de 6 000 caractères refusé (jamais tronqué).
- **Cohérence** : préparer, retoucher et certifier un même mois passent l'un après l'autre (verrou consultatif + relecture sous verrou) ; « Certifier » envoie le texte affiché dans le même formulaire que « Enregistrer », avec une case de relecture obligatoire ; un instantané de plus de 7 jours ne se certifie pas sans actualisation. Un mois sans nuit vendue affiche « inconnu », jamais 0.
- **Cycle** : `DRAFT` (texte retouchable, chiffres actualisables ; un texte retouché n'est écrasé que sur confirmation) → `CERTIFIED` (texte revérifié, empreinte SHA-256 de l'instantané et du texte, signataire, date). Un seul brouillon par mois (index unique partiel) ; corriger un mois certifié ouvre la version suivante, la certifiée reste intacte et lisible.
- **Immuabilité** : déclencheurs `ns_report_freeze` (aucune modification) et `ns_report_no_delete` (aucune suppression directe, seule la cascade avec le logement ou l'espace passe) — un rapport certifié ne se modifie plus, même par accès direct à la base ; logement, mois et version d'un rapport ne changent jamais. Contraintes CHECK (statut, format du mois, signataire obligatoire quand certifié).
- **Droits** : `report.certify` (propriétaire du compte, administrateur, revenue manager) pour préparer, retoucher, certifier ; lecture pour tous les rôles connectés ; refus journalisé (`access.denied`).
- **Audit** : `report.drafted`, `report.edited`, `report.certified`, `report.reopened`, chacun écrit dans la transaction du geste.
- **Migration `0033_us_112_rapports`** (idempotente) : table `monthly_reports`, contraintes, déclencheur, RLS (lecture, ajout, mise à jour ; jamais de suppression). **Aucune variable d'environnement.**
- **Tests** : unitaires du module pur (22, dont les contournements du garde-fou), droits, base (13 : droits, nombre inventé, figeage, versions, concurrence, isolation), navigateur sur bureau / 390 / 360 px (parcours complet, lecture seule, glossaire).

## US-113 — Export CSV/PDF et historique

**Ce qui change.** Un rapport certifié s'exporte en **PDF** et en **CSV** ; l'écran `/rapports` devient un **historique** filtrable des rapports (toutes les versions) et des mesures d'expériences, exportable en CSV.

- **CSV** (`src/lib/reports/csv.ts`, module pur) : séparateur « ; », fins de ligne CRLF, BOM UTF-8 (ouverture directe dans Excel en français), nombres à virgule décimale. Toute cellule commençant par `=`, `+`, `-`, `@` ou une tabulation est préfixée d'une apostrophe (pas d'injection de formule) ; les retours à la ligne sont remplacés ; une valeur inconnue s'exporte « inconnu », jamais 0.
- **PDF** (`src/lib/reports/pdf.ts` et `document.ts`) : généré sans dépendance (Helvetica, A4, accents et €, pagination automatique, pied de page). Mêmes chiffres que l'écran, rien de recalculé ; contrôlé avec `qpdf --check` et rendu visuel.
- **Routes** (lectures authentifiées, espace pris dans la session, jamais dans un paramètre ; `Cache-Control: no-store`) :
  - `GET /api/rapports/[id]/export?format=csv|pdf` — rapport **certifié** uniquement (brouillon : 409, format inconnu : 400, introuvable ou d'un autre espace : 404, sans session : 401) ;
  - `GET /api/rapports/historique?logement=<id>&type=rapports|mesures` avec les filtres de l'écran.
- **Filtres** (`src/lib/reports/filters.ts`) : `etat` (certifiés / brouillons), `annee`, `resultat` (positif, neutre, négatif, non concluant) ; une valeur invalide est ignorée sans erreur ; compteur « n rapports sur N », réinitialisation, exports avec les mêmes filtres.
- **Droits** : lecture pour tous les rôles connectés (un export ne modifie rien) ; chaque export est tracé au journal (`report.exported`, entité, format, nombre de lignes).
- **Mesures** : l'historique des mesures reprend les résultats de l'US-111 tels quels (les mesures antérieures à l'épic sont signalées).
- **Migration** : aucune. **Aucune variable d'environnement.**
- **Tests** : unitaires (CSV, PDF, filtres : 34 avec ceux de l'US-112), base de données (export, historique, isolation), navigateur sur bureau / 390 / 360 px (téléchargements réels, 401/400/404/409, filtres, absence de débordement).

## Déploiement (staging Coolify)

Renseigné à la fin de chaque US : migrations à jouer, variables d'environnement (aucune ajoutée pour l'instant), points à vérifier.
