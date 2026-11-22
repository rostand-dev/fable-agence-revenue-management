# Épic 5 — Metrics & Economics

Blueprint §3 (principes 5 et 7), §7.2–7.3 (signaux, fenêtres), §8.2 (formules), §8.3 (Economic Floor), §8.4 (Discount Stack Simulator), §13.1 (`GET /v1/properties/{id}/performance`), §17.1 (tests déterministes), §20.1 (Gate A : réconciliation ±1 %). Ce document est le plan d'implémentation et la référence fonctionnelle de l'épic ; chaque US le complète.

**Point de départ (fin d'épic 4).** Le moteur calcule déjà des KPI mensuels (`monthlyKpis`), des fenêtres d'occupation (`windowStats`), des planchers (`floorGrid`) et une cascade de remises (`simulateStack`), mais : les KPI partent des réservations et comptent une commission inconnue comme nulle (net surévalué) ; il n'existe ni pickup ni pacing historique ; les planchers n'ont pas de dimension saison ; le simulateur chiffre sans expliquer chaque étape ni comparer au plancher ; aucun test ne vérifie la réconciliation des chiffres à ±1 % sur un échantillon de référence. L'épic 5 formalise ces cinq briques en modules purs et testés, branchés sur les nuits (`reservation_nights`) de l'épic 3 et sur les snapshots de l'épic 4.

## Ordre d'implémentation et dépendances

| Ordre | US | Pourquoi à cette place |
|---|---|---|
| 1 | **US-050** KPI canoniques | Socle : tout le reste lit des KPI par nuit, avec la règle « inconnu ≠ zéro ». |
| 2 | **US-051** Pickup et pacing | Réutilise les nuits et les fenêtres de l'US-050 ; ajoute la dimension « date de réservation ». |
| 3 | **US-052** Economic Floor canal × LOS × saison | Indépendant des KPI mais nécessaire au simulateur : l'US-053 compare le net simulé au plancher de la bonne saison. |
| 4 | **US-053** Discount Stack Simulator explicable | Consomme les planchers saisonniers (US-052) et les règles de cumul (US-003). |
| 5 | **US-054** Réconciliation ±1 % | Dernière : vérifie de bout en bout les quatre US précédentes sur un échantillon de référence et verrouille la non-régression. |

## US-050 — KPI canoniques

**Ce qui change**
- **Module pur `src/lib/metrics/kpi.ts`** : `computeKpi(période, nuits vendues, nuits bloquées)` calcule occupation, ADR, Net ADR, RevPAN (brut) et Net RevPAN selon le blueprint §8.2. Période toujours explicite : nuits du `from` inclus au `to` exclu (jamais plus de 800 jours).
- **Calcul par nuit**, en centimes entiers additionnés sans arrondi ; l'arrondi n'intervient qu'à la dernière division. La somme de n'importe quelle découpe de période (mois, fenêtres) égale exactement le total.
- **Inconnu ≠ zéro** (blueprint §3, principe 7). Une commission inconnue exclut la nuit du NET (elle reste dans le brut et l'occupation) et le statut du net le dit : `COMPLETE`, `PARTIAL`, `UNKNOWN` ou `NONE` (aucune nuit vendue : le net est alors un vrai zéro). Le Net ADR est calculé sur les nuits dont la commission est connue (sans biais). Le **Net RevPAN est `null` tant que le net n'est pas complet** : un chiffre partiel serait sous-évalué.
- **Nuits bloquées** par le propriétaire : non disponibles à la vente. Une nuit à la fois vendue et bloquée compte comme vendue. Une double réservation est signalée (`overlappingNights`) et jamais corrigée en silence.
- **`monthlyKpis` délègue au module** (formes de sortie inchangées pour les écrans). **Changement de fond** : une commission inconnue n'est plus comptée comme nulle (ce qui surévaluait le revenu net) ; la nuit sort du net et le mois est signalé `netIncomplete`. La fiche du logement affiche alors « net connu pour X % des nuits » et un Net RevPAN « inconnu » ; le bilan mensuel affiche un bandeau « Revenu net partiel ».
- **Service `getPerformance`** et **API `GET /api/v1/properties/{id}/performance`** (lecture seule, session obligatoire, isolée par locataire, `Cache-Control: no-store`). Sans paramètre : les 12 derniers mois civils complets, le détail mensuel et les cinq fenêtres à venir (D+0–7, D+8–14, D+15–30, D+31–60, D+61–90). `?months=N` (1 à 24) ou `?from=AAAA-MM-JJ&to=AAAA-MM-JJ` (période libre). Les nuits bloquées sont lues dans les réservations de blocage et dans le calendrier lu.
- Dictionnaire des montants mis à jour (`docs/dictionnaire-montants.md` régénéré) : `grossRevpanCents` ajouté, réserves sur le net corrigées.
- **Staging (Coolify)** : aucune migration, aucune variable d'environnement nouvelle.

**Limites connues** : l'occupation à venir ne compare pas encore au marché (c'est le rôle des fenêtres de `windowStats`, US-051) ; un frais de paiement absent compte pour 0 sans signal (seule la commission décide si le net est connu, Airbnb n'ayant pas de frais de paiement) ; la taxe de séjour n'est pas retirée par ce module (le montant d'hébergement est pris tel que stocké, voir le dictionnaire).

**Tests** : unitaires (`kpi.test.ts` : cas calculé à la main, blocages, net partiel/inconnu/nul, double réservation, bornes, mois bissextile, répartition des centimes, 5 jeux aléatoires reproductibles qui vérifient l'additivité exacte et les bornes), base (`performance.db.test.ts` : 12 mois, période libre, blocages du calendrier, isolation locataire, bornes, validation des paramètres), E2E navigateur (API et fiche du logement, bureau, mobile 390 et 360 px, sans débordement).

## US-051 — Pickup et pacing par horizon

**Ce qui change**
- **Module pur `src/lib/metrics/pace.ts`** sur les cinq fenêtres canoniques (D+0–7, D+8–14, D+15–30, D+31–60, D+61–90).
- **Pickup 1, 3, 7 et 14 jours** : nuits de la fenêtre dont la réservation date des N derniers jours civils, aujourd'hui compris. Les **annulations** des mêmes jours sont données à part (`cancelled`), jamais retranchées en silence. Elles viennent de l'historique `reservation_changes` : une annulation compte tant que la réservation n'a pas été réactivée depuis.
- **Pacing** : occupation déjà réservée de la fenêtre, comparée à la même fenêtre 52 semaines plus tôt, au même délai avant le séjour (nuits réservées à la date de comparaison). Écart en points ; `AHEAD` / `ON_TRACK` / `BEHIND` au-delà de ±5 points. **Sans historique d'un an, le statut est `UNKNOWN`** avec sa raison (`NO_HISTORY`, `HISTORY_TOO_SHORT`, `NO_AVAILABILITY`) : jamais « dans la cible » par défaut.
- **API `GET /api/v1/properties/{id}/pace`** (lecture seule, session, isolée par locataire). **Fiche du logement** : deux colonnes ajoutées au tableau « Rythme de réservation » (Pickup 7 j, Face à l'an dernier).
- **Staging (Coolify)** : aucune migration, aucune variable d'environnement.

**Choix de conception** : une annulation est datée de son enregistrement chez nous (lecture), pas de la date indiquée par la source ; elle reste comptée tant que la réservation n'est pas remise en vigueur, même si un évènement ultérieur la modifie ; le pacing exige que l'historique couvre aussi les nuits comparées (première nuit connue au moins aussi ancienne que la fenêtre de l'an dernier). Écarts de 5 points arrondis avant comparaison.

**Limites connues** : les blocages du calendrier lu n'existent qu'à partir d'aujourd'hui, la disponibilité de l'an dernier peut donc être surévaluée ; une réservation annulée n'a plus de nuits, donc le « même jour l'an dernier » est sous-évalué des annulations tardives ; les annulations ne sont connues que depuis la mise en route de l'ingestion SuperHote ; sur un logement dont l'historique a moins d'un an, le pacing reste inconnu (pickup disponible).

**Tests** : unitaires (`pace.test.ts` : bornes du pickup, annulations, avance/cible/retard, réservation faite après la date de comparaison, historique court, blocages, fenêtres jointives), base (`pace.db.test.ts` : pickup par fenêtre, pacing, annulations avec réactivation, isolation locataire), E2E (API et tableau, bureau, mobile 390 et 360 px).
