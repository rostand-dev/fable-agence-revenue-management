# Épic 3 — Ingestion SuperHote (webhooks, normalisation, réconciliation)

Blueprint §19 (E3), §6.2 (boucle événementielle), §13.2 (événements), §16.2–16.5 (secrets, RGPD, résilience). Ce document est le plan d'implémentation et la référence fonctionnelle de l'épic. Il est mis à jour par chaque US.

**Décision : pas de Make.** Les réservations arrivent par les **webhooks sortants de l'API publique SuperHote v2** (`reservation.created`, `reservation.updated`, `reservation.canceled`), enregistrés par NuitSignal lui-même avec `POST /webhooks`, et sont complétées par une réconciliation périodique (`GET /reservations?updated_since=…`).
Documentation : <https://docs.superhote.com/api-v2/> (section « Webhooks sortants »).

## Ordre d'implémentation et dépendances

| Ordre | US | Pourquoi à cette place |
|---|---|---|
| 1 | **US-034** Masquage PII dans les journaux et les envois aux agents | Socle : tout ce qui suit journalise et stocke des charges utiles ; la minimisation et le masquage doivent exister avant la première ligne d'ingestion. |
| 2 | **US-031** Normalisation `Reservation` / `ReservationNight` | Modèle canonique et écriture unitaire idempotente : le webhook (US-030) et la réconciliation (US-032) écrivent par là, jamais directement. |
| 3 | **US-030** Endpoint webhook idempotent | S'appuie sur US-031 pour appliquer chaque événement ; apporte la boîte de réception (`webhook_deliveries`) et ses états. |
| 4 | **US-032** Réconciliation planifiée | Filet de sécurité des webhooks (perte, annulation par l'API, retard) ; réutilise l'écriture unitaire d'US-031 et la détection de changement. |
| 5 | **US-033** DLQ, rejeu et écran d'erreurs | Rend visibles et rejouables les échecs produits par US-030 et US-032. |

## US-034 — Masquage des données personnelles

Le revenu n'a pas besoin de l'identité du voyageur. Trois barrières (`src/lib/privacy/pii.ts`, module pur et testé) :

1. **Minimisation à l'entrée** : une charge utile SuperHote ne garde que les champs d'une **liste blanche** (`pickAllowed`) ; nom, e-mail, téléphone, notes privées et messages du voyageur ne sont jamais stockés. Un nouveau champ de l'API reste exclu tant qu'on ne l'a pas choisi. (Appliquée par US-031 et US-030.)
2. **Passerelle LLM** : `callLlm` et `streamLlm` masquent le système et les messages avant l'appel (`maskLlmInput`). Aucun agent ne reçoit d'e-mail, de téléphone, d'IBAN, de carte ni de secret.
3. **Journaux** : `console.log/info/warn/error/debug` sont enveloppés au démarrage du serveur (`installLogMasking`, `src/instrumentation-node.ts`). Les erreurs gardent leur classe et leur pile, mais leur message, leur détail et leur cause sont nettoyés (une erreur PostgreSQL peut citer une valeur).

Le **journal d'audit** retire en plus les clés d'identité d'un voyageur (`guest*`, `first_name`, `private_notes`…) ; il garde à dessein l'e-mail d'un propriétaire, consigné pour l'auditeur.

Ce qui est masqué : e-mails, téléphones (formats international et français), IBAN (clé modulo 97), cartes bancaires (clé de Luhn), secrets (`whsec_…`, `sk-…`, `Bearer …`, jeton dans l'adresse du webhook, `clé = valeur`). Ce qui ne l'est **pas** : dates, montants, identifiants, horodatages (tests de non-faux-positifs). Un téléphone écrit sans `+` ni zéro initial français n'est pas reconnu : la barrière 1 (liste blanche) est la protection de fond, les deux autres sont des filets.

Variable : `LOG_PII_MASKING` (`on` par défaut ; `off` désactive le masquage des journaux, pour un débogage local seulement).

## US-031 — Normalisation `Reservation` / `ReservationNight`

- **Nuits** (`reservation_nights`) : une ligne par nuit (départ exclu) pour les réservations `CONFIRMED` ou `BLOCKED` de 1 à 400 nuits. Montant d'hébergement, commission et frais de paiement sont répartis en centimes entiers, le reste d'un centime allant aux premières nuits : la somme des nuits égale exactement la réservation. Une annulation ou un doublon ne produit aucune nuit (dates rouvertes).
- **Historique** (`reservation_changes`, en ajout seul) : création, modification, annulation, réactivation, avec ce qui a changé (libellés français), la source (`WEBHOOK` ou `RECONCILE`) et l'identifiant de livraison SuperHote.
- **Écriture unitaire** (`applyReservation`, `src/lib/services/reservation-ingest.ts`) : seul chemin d'écriture pour US-030 et US-032. Idempotente (même état rejoué = aucune écriture), protégée contre l'ordre d'arrivée (un `updated_at` plus ancien que l'état connu est ignoré, `STALE`) et transactionnelle (réservation, nuits, historique ensemble). Les chevauchements sont réévalués par la règle commune `dedupeConfirmed` (la plus récemment réservée l'emporte) ; une réservation redevenue seule redevient confirmée.
- **Migration `0019`** : tables, colonnes, RLS (nuits en CRUD, historique en SELECT/INSERT) et reprise des nuits des réservations existantes ; rejouable.
- **Déploiement Staging** : aucune variable d'environnement nouvelle ; la migration est appliquée au démarrage comme les précédentes.

## US-030 — Endpoint webhook idempotent

- **Route** `POST /api/webhooks/superhote/<identifiant opaque>` : sans session, authentifiée par la signature `X-Superhote-Signature` (HMAC-SHA256 du corps brut, comparaison à temps constant). 401 signature invalide, 404 point inconnu, 400 enveloppe invalide, 413 corps > 256 Ko, 200 sinon (y compris livraison déjà vue ou événement ignoré), 503 si la base est indisponible (SuperHote réessaie à 1 puis 5 minutes).
- **Un webhook par jeton** (table `superhote_webhooks`) et non par logement : un compte SuperHote est limité à 10 webhooks. Le logement est retrouvé par le `rental_id` de la réservation et par l'empreinte du jeton. Le secret `whsec_…` (renvoyé une seule fois) est chiffré.
- **Boîte de réception** `webhook_deliveries` : inscrite AVANT traitement, clé d'idempotence `(endpoint, X-Superhote-Delivery)`. Statuts RECEIVED / PROCESSED / IGNORED / FAILED. Réclamation par `UPDATE … status='PROCESSING'` (pas de double traitement, réclamation abandonnée après 1 min). Panne transitoire : 500, SuperHote réessaie et la livraison FAILED est reprise (3 tentatives) ; au-delà, 200 et FAILED visible (rejeu : US-033 ; rattrapage : US-032). Message d'erreur stocké générique (jamais de SQL).
- **Traitement** : `applyReservation` (US-031) puis ajustement du calendrier déjà lu (nuits vendues ; jamais de libération sans confirmation de SuperHote, la réconciliation corrige). Annulation par l'API = `reservation.updated` avec `status_label` CANCELED.
- **Activation** : onglet SuperHote de la fiche logement (« Activer / Désactiver les webhooks »), audit `integration.superhote_webhook_registered|removed`. Supprimer le dernier jeton d'un compte retire son webhook.
- **Migration `0020`** : tables, RLS (livraisons : SELECT/INSERT/UPDATE), rejouable.

### À prévoir sur Staging (Coolify) pour les webhooks
1. L'application doit être joignable en **https public** : `APP_URL` (ou `SUPERHOTE_WEBHOOK_BASE_URL`, nouvelle variable facultative, vide = `APP_URL`). Sans cela, « Activer les webhooks » est refusé avec un message explicite. Une Preview protégée par mot de passe ne peut pas recevoir de webhooks.
2. Ne pas poser `PREVIEW_BASIC_AUTH_*` sur Staging (le mot de passe bloquerait SuperHote).
3. Le jeton API SuperHote doit porter le scope **`public-api:webhooks.manage`** (en plus des scopes de lecture).
4. `APP_SECRET` chiffre les secrets de webhook et dérive l'empreinte des jetons : le changer invalide les webhooks déjà créés (les désactiver puis réactiver).
5. `TENANT_RLS` : sans effet particulier ; la route traite chaque livraison sous l'isolation du propriétaire.
