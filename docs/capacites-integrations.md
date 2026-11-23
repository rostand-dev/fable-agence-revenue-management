# Capacités réelles des intégrations

> Document généré par `npm run docs:capabilities` depuis `src/lib/integrations/capabilities.ts`. Ne pas le modifier à la main : un test échoue s'il diverge du code.

US-002 · blueprint §4.2. Le catalogue décrit ce que le **code** sait faire aujourd'hui, pas ce qu'une configuration affirme. Une écriture non développée est impossible : refusée côté serveur (`execute()` dans `services/decisions.ts`), rejetée par l'auditeur (règle `CAPABILITY`), et bouton désactivé dans la fiche du dossier.

## Règles

- **Fermé par défaut** : le client de lecture PriceLabs ne contient aucune méthode d'écriture (un test le vérifie) ; l'écriture vit dans un module distinct (`pricelabs-write.ts`) que les agents n'importent pas (contrôle statique).
- **Verrou d'environnement** : l'écriture PriceLabs sur un logement réel n'est ouverte que si `PRICELABS_WRITE_ENABLED=true` est posée sur l'environnement. Absente, l'option reste proposée en procédure manuelle guidée.
- **Types écrits par API** : prix minimum, prix de base, prix datés. Le séjour minimum daté reste en procédure manuelle guidée (sémantique de l'API non confirmée).
- **Démonstration** : l'écriture PriceLabs est simulée sur les logements de démonstration, tous types d'action confondus.
- **Coupe-circuit** : uniquement pour les fournisseurs ayant une écriture automatique (PriceLabs). Il bloque l'écriture par API, immédiatement ; les lectures et les procédures manuelles guidées continuent.
- **Déduit des logements** : le statut d'un fournisseur et le nombre de logements branchés viennent des rattachements réels (`listingId` PriceLabs, `rentalId` SuperHote), jamais d'une ligne de configuration.

## États affichés

| État | Sens |
|---|---|
| Disponible | développée et branchée sur au moins un logement réel |
| Simulée (démonstration) | démonstration uniquement : rien n'est lu ni écrit chez le fournisseur |
| À connecter | développée, mais aucun logement réel n'est branché |
| Non développée | non développée dans cette version |
| Accès partenaire requis | non développée, et dépend d'un accès partenaire non obtenu |
| Exclue (conditions du canal) | exclue : les conditions du canal l'interdisent |
| Désactivée sur cet environnement | développée et branchée, mais fermée sur cet environnement tant que sa variable d'environnement n'est pas posée à « true » (écriture PriceLabs : PRICELABS_WRITE_ENABLED) |

## SuperHote

PMS et channel manager · source des réservations.

| Capacité | Identifiant | Nature | Développée | Raison |
|---|---|---|---|---|
| Lecture planifiée des réservations et du calendrier | `superhote.reconcile` | lecture | oui, sur logement réel | API v2 SuperHote en lecture seule (jeton par logement : rentals.read, calendar.read, reservations.read), relue selon la cadence du logement. |
| Réception des événements en temps réel (webhooks) | `superhote.webhooks` | lecture | oui, sur logement réel | Point d'entrée signé (HMAC-SHA256) et idempotent : SuperHote pousse les réservations créées, modifiées et annulées. L'abonnement se crée depuis la fiche du logement (jeton avec le scope public-api:webhooks.manage) et demande une adresse publique en https. La lecture planifiée reste le filet de sécurité. |

Suite : Les réservations sont reçues en temps réel par webhooks (à activer dans l'onglet SuperHote, adresse publique en https exigée) et relues par l'API selon la cadence du logement, qui sert de filet de sécurité. Connexion par logement : fiche du logement, onglet SuperHote.

## PriceLabs

Moteur de prix · grille, réglages et marché.

| Capacité | Identifiant | Nature | Développée | Raison |
|---|---|---|---|---|
| Lecture de la grille de prix, du marché et des réservations relayées | `pricelabs.read` | lecture | oui, sur logement réel | API client PriceLabs en lecture seule (clé API par logement) : annonces, prix, marché, réservations. |
| Écriture des prix minimum, de base et datés, après approbation | `pricelabs.write` | écriture | oui, sur logement réel | Écriture par l'API client PriceLabs (POST /listings pour le prix minimum et de base, /listings/{id}/overrides pour un prix daté), après approbation, avec relecture de confirmation. Fermée tant que la variable PRICELABS_WRITE_ENABLED n'est pas posée sur l'environnement ; le séjour minimum daté reste en procédure manuelle guidée. Simulée sur les logements de démonstration. |

Suite : La connexion se fait par logement : fiche du logement, onglet PriceLabs, clé API. L'écriture (prix minimum, prix de base, prix datés) n'est ouverte sur un environnement que par la variable PRICELABS_WRITE_ENABLED ; fermée, toute modification de prix passe par la procédure manuelle guidée.

## Booking.com

Canal · promotions et commissions.

| Capacité | Identifiant | Nature | Développée | Raison |
|---|---|---|---|---|
| Lecture des promotions | `booking.promotions.read` | lecture | non (accès partenaire non obtenu) | L'API Promotions de Booking.com exige un accès Connectivity Partner, non obtenu. Le registre des promotions se tient à la main. |
| Écriture des promotions | `booking.promotions.write` | écriture | non (accès partenaire non obtenu) | Même dépendance que la lecture : accès Connectivity Partner non obtenu. Procédure manuelle guidée, avec preuve. |

Suite : L'API Promotions exige un accès Connectivity Partner. D'ici là : procédure manuelle guidée, avec preuve.

## Airbnb

Canal · promotions et commissions.

| Capacité | Identifiant | Nature | Développée | Raison |
|---|---|---|---|---|
| Lecture des promotions | `airbnb.promotions.read` | lecture | non (exclue par les conditions du canal) | Aucune API branchée ; l'automatisation du navigateur est exclue (conditions d'Airbnb, ADR-006). Le registre des promotions se tient à la main. |
| Écriture des promotions | `airbnb.promotions.write` | écriture | non (exclue par les conditions du canal) | Aucune automatisation de navigateur : les conditions d'Airbnb l'interdisent. Procédure manuelle guidée, avec preuve. |

Suite : Aucune automatisation de navigateur : les conditions d'Airbnb l'interdisent. Procédure manuelle guidée, avec preuve.
