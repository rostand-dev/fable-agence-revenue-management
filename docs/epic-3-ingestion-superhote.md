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
