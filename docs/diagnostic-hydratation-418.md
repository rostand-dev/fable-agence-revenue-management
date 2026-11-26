# Erreur React #418 intermittente (hydratation) — diagnostic et correction

Symptôme : « Minified React error #418 … args[]=HTML » au chargement, au hasard (/, /methode, /modeles, /modeles/cles, /parametres, /dossier, fiches logement), bureau et mobile. Corrigé en passant de Next 15.5.29 à Next 16.4.6 (novembre 2026).

## Cause

Next 15.5.29 embarque pour l'App Router `react-dom 19.2.0-canary-0bdb9206-20250818`. Dans cette version, quand un élément HTML est hydraté pendant que la page arrive encore en streaming, ses enfants (référence RSC « lazy » pas encore reçue) peuvent suspendre. React rejoue alors l'élément (`replayBeginWork`, cas HostComponent) **sans rembobiner le curseur d'hydratation**. Le curseur pointe déjà sur le premier enfant de l'élément ; React tente de réclamer l'élément une seconde fois, ne le trouve pas et lève #418.

- Correction en amont : facebook/react, commit c18662405c (issue #35210). Elle est absente de la canary de Next 15.5.29 et présente dans celle de Next 16.4.6 (`19.3.0-canary-278794d7-20261002`).
- Le code de NuitSignal n'est pas en cause. Aucun premier rendu client n'est non déterministe. Les frontières Suspense du menu n'y sont pour rien (les mesures montrent des décalages dans tout le contenu de page).
- La plupart de ces décalages sont rattrapés en silence par React, qui refait le rendu côté client. Seuls quelques-uns remontent en `pageerror`, ce qui explique la rareté des échecs de test.

## Méthode de mesure

1. Build de production, base PostgreSQL locale, variables identiques à la CI (`.github/workflows/ci.yml`).
2. Instrumentation **locale et non commitée** de `throwOnHydrationMismatch` dans `node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.production.js`. Chaque appel écrit en console une ligne `HYDDIAG` : chaîne des fibres, nœud DOM attendu, parent d'hydratation. Le timing n'est pas modifié (build de production conservé).
3. Lancement de Chrome avec `--enable-logging --log-file=…`, puis comptage des lignes `HYDDIAG` du journal sur une suite E2E complète (`npx playwright test --workers=2`, environ 470 tests).
4. Contrôle positif : une altération volontaire d'un texte du HTML serveur produit bien une ligne `HYDDIAG` et un `pageerror #418`.

## Résultats (même machine, même protocole)

| Version | Passages complets | Décalages d'hydratation (`HYDDIAG`) | `pageerror #418` |
|---|---|---|---|
| Next 15.5.29 (main, e1ff146) | 6 | **100** (12, 11, 20, 18, 15, 24) | 4 |
| Next 16.4.6 | 4 (dont 1 sans instrumentation, base neuve) | **0** | 0 |

Avec une moyenne d'environ 16 décalages par passage avant correction, la probabilité d'observer 0 sur 3 passages instrumentés par simple hasard est de l'ordre de e^-50.

## Ruptures Next 16 traitées

- `src/middleware.ts` devient `src/proxy.ts` (fonction `proxy`). Il est exécuté par Node.js et non plus par Edge ; le comportement est vérifié (401 de preview, `/api/health` public, 403 en démo lecture seule).
- `tsconfig.json` : `jsx: react-jsx` et l'inclusion de `.next/dev/types/**/*.ts` sont imposés par Next 16.
- `engines.node` passe à `>=20.9.0`.
- Turbopack devient le bundler par défaut ; aucune configuration webpack n'existait.
- Le reste ne nécessitait rien : `params`/`searchParams` déjà asynchrones, ni `next/image`, ni routes parallèles, ni `next lint`.
