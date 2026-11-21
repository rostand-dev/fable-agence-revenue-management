# Épic 4 — PriceLabs : lecture et snapshots

Blueprint §19 (E4), §7.4 (fraîcheur et lineage), §8.1 (payload brut immuable), §12.4 (historisation), §13.2 (événements `pricing.snapshot.created`, `market.snapshot.created`), §13.3 (contrat d'adaptateur), §14 (adaptateurs fake/replay), §17.1 (tests de contrat). Ce document est le plan d'implémentation et la référence fonctionnelle de l'épic ; chaque US le complète.

**Point de départ (fin d'épic 3).** La lecture PriceLabs existe déjà (clé par logement, rattachement confirmé, grille D+0 à D+90, marché, réservations relayées) mais elle écrase à chaque passage `calendar_days` et `market_days` : aucune trace de ce que PriceLabs disait hier, aucun moyen de savoir quand une valeur a été observée, et aucun test du service de lecture. L'épic 4 garde le fonctionnement observable et y ajoute l'historique, la fraîcheur et la traçabilité.

## Ordre d'implémentation et dépendances

| Ordre | US | Pourquoi à cette place |
|---|---|---|
| 1 | **US-044** Adaptateur replay/fake | Socle de test : sans faux PriceLabs, aucune des suivantes n'est testable sans réseau ni clé réelle. Fige aussi le comportement actuel par des tests de caractérisation. |
| 2 | **US-040** Connexion, listing et mapping | Rend la connexion robuste (reprises, test de connexion, capacités détectées) et sert de socle aux imports : on ne lit que ce qu'on a vérifié pouvoir lire. |
| 3 | **US-043** Snapshot immuable, freshness et lineage | Crée le magasin de snapshots (tables en ajout seul, empreinte, fraîcheur, lineage) que les deux imports alimentent. |
| 4 | **US-041** Import configuration et prix futurs | Premier producteur de snapshots : configuration PriceLabs et grille de prix. |
| 5 | **US-042** Import marché/compset selon capacités | Second producteur : marché, compset, avec ses limites de disponibilité. |

## US-044 — Adaptateur replay/fake

- **Port de lecture** `PriceLabsPort` (`src/lib/integrations/pricelabs-port.ts`) : quatre lectures (annonces, grille, marché, réservations) et **aucune méthode d'écriture**. Le service de lecture ne parle plus qu'à ce port (`priceLabsFor(clé)`).
- **Trois adaptateurs** : `HttpPriceLabs` (API réelle, seul adaptateur en production), `FakePriceLabs` (jeu de données synthétique en mémoire, pannes simulables) et `ReplayPriceLabs` (rejoue une fixture JSON enregistrée). Ils passent par les mêmes fonctions de lecture de réponse (`unwrapListings`, `unwrapPriceItem`, `errorForStatus`) : messages d'erreur et formes de données identiques.
- **Scénarios** (`pricelabs-scenarios.ts`, déterministes) : `nominal`, `toggle-off`, `market-down`, `market-sparse`, `unauthorized`, `forbidden`, `rate-limited`, `partial-grid`, `min-above-base`, `two-listings`, `flaky`.
- **Faux serveur HTTP** (`npm run fake:pricelabs`) : mêmes chemins et mêmes formes que l'API réelle. Le scénario est choisi par la **clé saisie** (`fake-<scénario>-<suffixe>`) : aucun état partagé entre tests, identifiants d'annonce uniques par clé. Toute écriture (méthode ou chemin inconnu) est refusée et consignée ; `/__calls` permet aux tests de prouver qu'aucune n'a eu lieu.
- **Enregistreur** (`scripts/pricelabs-record.ts`) : à lancer sur un poste ayant accès à PriceLabs, il lit une annonce, rend les réponses anonymes (noms, groupes, étiquettes, notes, identifiants) et écrit une fixture rejouable. La fixture `src/test/fixtures/pricelabs/nominal-2026-11-21.json` est un jeu fictif (`npm run fixtures:pricelabs`), pas un enregistrement réel.
- **Tests** : contrat commun aux trois adaptateurs (50 vérifications), pagination et erreurs réseau de l'adaptateur HTTP, anonymisation ; 11 tests d'intégration du service de lecture sur base réelle (connexion, rattachement, relecture idempotente, échec qui conserve les données, annonce déjà prise, isolation entre propriétaires, détachement, marché en panne, grille partielle) ; 3 parcours E2E navigateur (bureau, mobile 390 et 360 px).
- **Garde-fous** : `usePriceLabsAdapter()` est refusé en production. `PRICELABS_API_BASE` n'accepte que l'API officielle ou une adresse locale (127.0.0.1, localhost) ; toute autre valeur est ignorée avec un avertissement, pour qu'une variable mal posée ne puisse pas envoyer les clés des propriétaires ailleurs. L'anonymiseur de l'enregistreur fonctionne par liste blanche de champs.
- **Staging (Coolify)** : aucune variable ni migration nouvelle à poser. En CI, `PRICELABS_API_BASE` pointe vers le faux serveur local lancé par Playwright.

## US-040 — Connexion, annonce et mapping

**Ce qui change**
- Le port PriceLabs HTTP **retente** les pannes passagères (429, 502, 503, 504 et coupures réseau) jusqu'à 2 fois, avec une attente croissante (0,4 s, 1,2 s…, plafonnée à 5 s) qui respecte `Retry-After`. Jamais de nouvelle tentative sur 401, 403, 404, 500 ni sur un délai dépassé : une erreur de configuration doit se voir tout de suite.
- Bouton **« Tester la connexion »** (onglet PriceLabs du logement) : lit un petit échantillon (annonces, 7 jours de prix, marché, 60 jours de réservations) et affiche une ligne par lecture (disponible / à vérifier / en échec / non vérifié, toujours en toutes lettres). Le test ne modifie ni la grille, ni le marché, ni les réservations ; seul son résultat est mémorisé dans `properties.pricelabs.lastCheck` (jamais la clé). Les « capacités » constatées (annonces, prix, marché, réservations) serviront aux imports US-041 et US-042.
- Marché et réservations sont **non bloquants** pour le test (SuperHote fait foi pour les réservations) ; clé refusée, annonce disparue ou grille illisible rendent le test en échec.
- **Changement chez PriceLabs** : à chaque lecture, nom, ville et chambres de l'annonce rattachée sont comparés à la lecture précédente. Un écart est journalisé (`integration.pricelabs_listing_changed`) et signalé par un bandeau « Annonce modifiée chez PriceLabs » dans l'onglet (`lastSync.listingChanges`, jusqu'à la lecture suivante) ; il n'est jamais silencieux. Le rattachement n'est pas défait : l'utilisateur revérifie la correspondance.
- Le résultat mémorisé est écrit de façon ciblée et conditionnelle : si la clé est supprimée ou remplacée pendant le test, rien n'est mémorisé ni ressuscité. Sans annonce rattachée, le résultat dit « clé valide, annonce à rattacher » (ni échec, ni alarme).
- Limites connues : pas de budget de durée global sur une lecture (chaque appel est borné à 45 s, reprises comprises) ; un `Retry-After` au format date n'est pas interprété (attente de base de 0,4 s).
- Nouveaux évènements d'audit : `integration.pricelabs_tested`, `integration.pricelabs_listing_changed`.
- Aucune migration de base, aucune nouvelle variable d'environnement.

**Tests** : unitaires (`pricelabs-check.test.ts` : 8 cas de test de connexion, 2 de dérive, 7 de reprise sur panne), base (`pricelabs-sync.db.test.ts` : 7 cas, dont non-écriture, isolation locataire, absence de clé dans le résultat), E2E faux serveur sur bureau, mobile 390 et 360 sans débordement horizontal.

## US-043 — Snapshot immuable, fraîcheur et lineage

**Ce qui change**
- **Table `source_snapshots`** (migration `0021_source_snapshots`, idempotente) : à chaque lecture PriceLabs réussie, la réponse brute est conservée telle quelle — un snapshot `PRICING` (grille) et, si le marché est lisible, un snapshot `MARKET`. Chacun porte la source, l'**adaptateur** (HTTP, FAKE ou REPLAY : jamais d'ambiguïté réel/simulé), l'horodatage d'observation, la fenêtre de validité, un score de qualité (0 à 100), l'empreinte SHA-256 du contenu et son lineage (annonce, PMS, plage).
- **Immuable** : un déclencheur refuse tout `UPDATE`/`DELETE` direct, même pour le propriétaire de la table (la suppression en cascade d'un logement ou d'un locataire passe) ; le rôle applicatif n'a de plus que `SELECT` et `INSERT` ; isolation par locataire (RLS `tenant_isolation`, table ajoutée à `TENANT_TABLES`). Seule la suppression du logement les emporte (cascade).
- **Déduplication** : l'empreinte ignore les champs que PriceLabs change à chaque lecture sans que les données changent (`last_refreshed_at`…). Une lecture identique à la précédente n'est pas dupliquée. Elle crée une ligne légère sans payload qui pointe la première (`unchanged_of`) et fait avancer la fraîcheur.
- **Lineage** : `calendar_days.snapshot_id` et `market_days.snapshot_id` désignent le snapshot d'où vient chaque ligne. Pour les prix, c'est la grille PriceLabs ; le `lineage` du snapshot précise `priceSource`, `pricesFromSuperhote` et `blockedNights` quand SuperHote complète ou remplace une partie des prix. La date d'observation est prise sous le verrou du logement : deux lectures concurrentes s'écrivent dans l'ordre réel. Le dernier snapshot de chaque nature est cherché à part de l'historique, qui n'est jamais chargé avec ses payloads.
- **Fraîcheur** (`src/lib/freshness.ts`, seuils du blueprint §7.4) : réservations 24 h, disponibilité 6 h, prix 24 h, marché 48 h, promotions 7 jours. L'onglet PriceLabs affiche, pour les prix et le marché, « à jour / périmé / jamais lu » en toutes lettres, la date de lecture, l'origine et la qualité. Le moteur de décision s'appuiera sur ces seuils (épic 6).
- **API** : `GET /api/v1/properties/{id}/snapshots` (dernier snapshot par nature, fraîcheur, historique, sans payload) et `GET /api/v1/snapshots/{snapshotId}` (réponse brute, 404 hors du locataire).
- Une lecture en échec n'écrit aucun snapshot ; un marché illisible ne produit pas de snapshot de marché.
- **Staging (Coolify)** : une migration à appliquer (`0021_source_snapshots`, rejouable sans risque ; elle crée aussi le déclencheur d'immuabilité), aucune variable d'environnement nouvelle. Le rôle `nuitsignal_app` reçoit ses droits via la migration si le rôle existe.
- Limites connues : les événements `pricing.snapshot.created` / `market.snapshot.created` du blueprint §13.2 ne sont pas émis (l'outbox transactionnel n'existe pas encore) ; pas de purge des snapshots (règle de rétention à définir, US-123).

**Tests** : unitaires (fraîcheur, empreinte canonique), base (`snapshots.db.test.ts` : création, déduplication, changement, lineage, marché absent, lecture en échec, fraîcheur dans le temps, métadonnées sans payload, isolation locataire, immuabilité par le rôle applicatif, cascade), E2E faux serveur (bureau, mobile 390 et 360, sans débordement) incluant l'API.

Limite supplémentaire : la fraîcheur affichée pour les prix est celle de la lecture PriceLabs ; quand SuperHote fournit le prix, sa propre fraîcheur (dernière lecture SuperHote) s'applique aussi.
