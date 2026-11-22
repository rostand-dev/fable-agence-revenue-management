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
- **Catalogue `src/lib/engine/playbooks.ts`** : les 13 playbooks du blueprint (PB-01 à PB-13) avec seuils nommés, données requises, période de repos, candidats, exclusions, règles de veto, approbateur, vérification et horizon de mesure. Seuls PB-01 à PB-06, PB-07, PB-10 et PB-13 sont codés ; les autres sont décrits et marqués « pas encore actif ».
- **Signaux `src/lib/engine/signals.ts`** : la détection est séparée de la construction de l'action. Chaque signal porte son playbook, son déclencheur, sa clé de déduplication, ses dates et ses mesures (observé face au seuil). L'ordre de priorité des playbooks est explicite (`SIGNAL_ORDER`).
- **Nouveau PB-04 (écart par canal)** : un canal en retard sur son poids historique alors que le logement tient son rythme global. Il ne se déclenche qu'avec au moins deux canaux, 12 séjours confirmés sur 12 mois, au plus 20 % de canal inconnu et 10 nuits déjà réservées ; sinon il se tait (inconnu ≠ zéro). Il ne se déclenche pas sur les logements de démo.
- **Dossier d'opportunité** : encart « Signal » avec le tableau Mesure / Observé / Seuil et la source (playbook, fenêtre). Les mesures sont stockées dans le champ JSON `signals` existant.
- **Page Méthode** : section « Les playbooks de l'agence », un bloc dépliable par playbook (seuils, données, repos, approbation), lisible sur mobile.
- **Staging (Coolify)** : aucune migration, aucune variable d'environnement nouvelle.

**Limites connues** : PB-08, PB-09, PB-11 et PB-12 ne sont que décrits ; le seuil de PB-04 sera recalibré avec les premières données réelles.

**Tests** : unitaires (`signals.test.ts`, 36 cas : un seuil franchi / un seuil juste en dessous par playbook, données manquantes, ordre), non-régression (`review-golden.test.ts`), E2E navigateur (`e2e/playbooks.spec.ts` : page Méthode et dossier, bureau, mobile 390 et 360 px, sans débordement horizontal).
