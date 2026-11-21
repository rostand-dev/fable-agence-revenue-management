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
