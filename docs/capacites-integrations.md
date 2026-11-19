# Capacités réelles des intégrations

> Document généré par `npm run docs:capabilities` depuis `src/lib/integrations/capabilities.ts`. Ne pas le modifier à la main : un test échoue s'il diverge du code.

US-002 · blueprint §4.2. Le catalogue décrit ce que le **code** sait faire aujourd'hui, pas ce qu'une configuration affirme. Une écriture non développée est impossible : refusée côté serveur (`execute()` dans `services/decisions.ts`), rejetée par l'auditeur (règle `CAPABILITY`), et bouton désactivé dans la fiche du dossier.

## Règles

- **Lecture seule par défaut** : aucun client du code n'écrit chez un fournisseur. Un test le vérifie (aucune méthode PUT, PATCH, DELETE ; le seul POST de PriceLabs lit la grille).
- **Démonstration** : l'écriture PriceLabs est simulée sur les logements de démonstration. Sur un logement réel, l'option est proposée en procédure manuelle guidée.
- **Coupe-circuit** : par fournisseur ; bloque toute exécution vers lui, immédiatement. Les lectures continuent.
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

## SuperHote

PMS et channel manager · source des réservations.

| Capacité | Identifiant | Nature | Développée | Raison |
|---|---|---|---|---|
| Lecture planifiée des réservations et du calendrier | `superhote.reconcile` | lecture | oui, sur logement réel | API v2 SuperHote en lecture seule (jeton par logement : rentals.read, calendar.read, reservations.read), relue selon la cadence du logement. |
| Réception des événements en temps réel (webhooks) | `superhote.webhooks` | lecture | non | Aucun point d'entrée n'existe dans cette version : les réservations sont relues par l'API, pas poussées par SuperHote. |

Suite : Les webhooks (création, modification) ne sont pas développés : les réservations sont relues par l'API selon la cadence du logement. Connexion par logement : fiche du logement, onglet SuperHote.

## PriceLabs

Moteur de prix · grille, réglages et marché.

| Capacité | Identifiant | Nature | Développée | Raison |
|---|---|---|---|---|
| Lecture de la grille de prix, du marché et des réservations relayées | `pricelabs.read` | lecture | oui, sur logement réel | API client PriceLabs en lecture seule (clé API par logement) : annonces, prix, marché, réservations. |
| Écriture des prix et restrictions, après approbation | `pricelabs.write` | écriture | simulée sur la démonstration seulement | Le client PriceLabs ne sait que lire. L'écriture n'est simulée que sur les logements de démonstration ; sur un logement réel, seule la procédure manuelle guidée s'applique. L'accès en écriture de l'API client reste à confirmer auprès de PriceLabs. |

Suite : La connexion se fait par logement : fiche du logement, onglet PriceLabs, clé API. Lecture seule dans cette version : toute modification de prix passe par la procédure manuelle guidée.

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
