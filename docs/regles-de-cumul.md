# Règles de cumul des promotions

> Document généré par `npm run docs:stacking` depuis `src/lib/stacking/rules.ts`. Ne pas le modifier à la main : un test échoue s'il diverge du code.

US-003 · blueprint §10.4. Deux promotions d'un même canal, valables sur les mêmes nuits, se cumulent-elles ? Trois réponses : **Cumulables**, **Une seule s'applique**, **Inconnue**.

## Règles

- **Une règle inconnue n'est jamais devinée.** Toute option qui s'appuie sur un cumul inconnu reçoit le verdict `NEEDS_HUMAN` (règle d'audit `STACK_RULES`, `src/lib/engine/audit.ts`) : validation commentée obligatoire.
- **Sources** : seules les aides officielles des canaux établissent une règle. Les blogs et les channel managers n'ont pas valeur de preuve : sans source officielle, la règle reste inconnue.
- **Quelles options sont contrôlées** : celles qui ajoutent une remise ou baissent le prix, seules à pouvoir creuser la remise réelle sous celle qui a été simulée. Relever un prix, retirer une promotion, changer un séjour minimum ou ne rien faire ne sont pas critiques.
- **Qui est en jeu** : les promotions du registre du logement, sur le même canal, dont les dates de séjour recoupent les nuits visées par l'option, plus la promotion proposée. Une promotion sans date est permanente.
- **Un registre non vérifié depuis plus de 7 jours** rend aussi le contrôle incertain : l'option est soumise à validation. Un prix PriceLabs est contrôlé sur chaque canal du logement.
- **Un type de promotion absent du registre** rend la règle inconnue.
- **Le cumul déjà en place** n'est pas bloqué par ce contrôle : il est signalé par le playbook PB-05, et un registre périmé par `PROMO_FRESHNESS`.
- **Une règle exclusive** n'est pas un blocage : le simulateur retient le cumul, hypothèse prudente pour le plancher. La mention rappelle que l'effet réel de la seconde promotion peut être nul.
- **Un rejet l'emporte** : sous le plancher absolu ou au-delà du plafond de cumul, l'option reste rejetée, quelle que soit la règle de cumul.
- **Relecture des sources** : 2026-11-19. À refaire quand un canal change ses règles.

## Sources officielles

| Source | Adresse | Consultée le | Remarque |
|---|---|---|---|
| Aide Airbnb · Remises et promotions (logements) | https://www.airbnb.com/help/article/3421 | 2026-11-19 | La page ne porte pas de date de mise à jour. |
| Aide Airbnb · Ordre d'application des règles de tarification | https://www.airbnb.com/help/article/2061 | 2026-11-19 | La page ne porte pas de date de mise à jour. Son exemple applique la remise mensuelle plutôt que l'early-bird, sans énoncer de règle générale. |
| Booking.com · Demand API, remises | https://developers.booking.com/demand/docs/accommodations/discounts | 2026-11-19 | Décrit les tarifs de groupe fermé (CUG), Genius cité en exemple ; ne vise pas expressément l'extranet partenaire. Date de mise à jour affichée en relatif seulement. |

## Booking.com

Types de promotion connus : `GENIUS` (Genius (tarif réservé aux membres)), `MOBILE` (Tarif mobile), `COUNTRY` (Tarif par pays), `LIMITED` (Offre à durée limitée).

| Promotion A | Promotion B | Règle | Source | Détail |
|---|---|---|---|---|
| Genius (tarif réservé aux membres) | Genius (tarif réservé aux membres) | Inconnue | BOOKING_DISCOUNTS | Selon la documentation officielle de Booking.com (tarifs de groupe fermé, dont Genius est un exemple), un tarif réservé aux membres peut se cumuler avec d'autres remises à une condition : le « rate stacking » activé sur le compte partenaire. NuitSignal n'a aucun accès au compte Booking.com pour le vérifier. |
| Genius (tarif réservé aux membres) | Tarif mobile | Inconnue | BOOKING_DISCOUNTS | Selon la documentation officielle de Booking.com (tarifs de groupe fermé, dont Genius est un exemple), un tarif réservé aux membres peut se cumuler avec d'autres remises à une condition : le « rate stacking » activé sur le compte partenaire. NuitSignal n'a aucun accès au compte Booking.com pour le vérifier. |
| Genius (tarif réservé aux membres) | Tarif par pays | Inconnue | BOOKING_DISCOUNTS | Selon la documentation officielle de Booking.com (tarifs de groupe fermé, dont Genius est un exemple), un tarif réservé aux membres peut se cumuler avec d'autres remises à une condition : le « rate stacking » activé sur le compte partenaire. NuitSignal n'a aucun accès au compte Booking.com pour le vérifier. |
| Genius (tarif réservé aux membres) | Offre à durée limitée | Inconnue | BOOKING_DISCOUNTS | Selon la documentation officielle de Booking.com (tarifs de groupe fermé, dont Genius est un exemple), un tarif réservé aux membres peut se cumuler avec d'autres remises à une condition : le « rate stacking » activé sur le compte partenaire. NuitSignal n'a aucun accès au compte Booking.com pour le vérifier. |
| Tarif mobile | Tarif mobile | Inconnue | — | La documentation officielle ne dit pas si ces deux offres se cumulent. Les affirmations de blogs ou de channel managers ne sont pas retenues. |
| Tarif mobile | Tarif par pays | Inconnue | — | La documentation officielle ne dit pas si ces deux offres se cumulent. Les affirmations de blogs ou de channel managers ne sont pas retenues. |
| Tarif mobile | Offre à durée limitée | Inconnue | — | La documentation officielle ne dit pas si ces deux offres se cumulent. Les affirmations de blogs ou de channel managers ne sont pas retenues. |
| Tarif par pays | Tarif par pays | Inconnue | — | La documentation officielle ne dit pas si ces deux offres se cumulent. Les affirmations de blogs ou de channel managers ne sont pas retenues. |
| Tarif par pays | Offre à durée limitée | Inconnue | — | La documentation officielle ne dit pas si ces deux offres se cumulent. Les affirmations de blogs ou de channel managers ne sont pas retenues. |
| Offre à durée limitée | Offre à durée limitée | Inconnue | — | La documentation officielle ne dit pas si ces deux offres se cumulent. Les affirmations de blogs ou de channel managers ne sont pas retenues. |

## Airbnb

Types de promotion connus : `NEW_LISTING` (Promotion nouvelle annonce), `CUSTOM` (Promotion personnalisée), `LOS` (Remise de durée de séjour (hebdomadaire, mensuelle, personnalisée)), `EARLY_BIRD` (Remise early-bird), `LAST_MINUTE` (Remise dernière minute), `TOP_RATED` (Remise voyageur très bien noté).

| Promotion A | Promotion B | Règle | Source | Détail |
|---|---|---|---|---|
| Promotion nouvelle annonce | Promotion nouvelle annonce | Une seule s'applique | AIRBNB_DISCOUNTS | Une seule des remises principales s'applique à une réservation. Laquelle l'emporte n'est pas énoncé par l'aide officielle : le simulateur retient le cumul, hypothèse prudente pour le plancher, mais l'effet réel de la seconde promotion peut être nul. |
| Promotion nouvelle annonce | Promotion personnalisée | Une seule s'applique | AIRBNB_DISCOUNTS | Une seule des remises principales s'applique à une réservation. Laquelle l'emporte n'est pas énoncé par l'aide officielle : le simulateur retient le cumul, hypothèse prudente pour le plancher, mais l'effet réel de la seconde promotion peut être nul. |
| Promotion nouvelle annonce | Remise de durée de séjour (hebdomadaire, mensuelle, personnalisée) | Une seule s'applique | AIRBNB_DISCOUNTS | Une seule des remises principales s'applique à une réservation. Laquelle l'emporte n'est pas énoncé par l'aide officielle : le simulateur retient le cumul, hypothèse prudente pour le plancher, mais l'effet réel de la seconde promotion peut être nul. |
| Promotion nouvelle annonce | Remise early-bird | Une seule s'applique | AIRBNB_DISCOUNTS | Une seule des remises principales s'applique à une réservation. Laquelle l'emporte n'est pas énoncé par l'aide officielle : le simulateur retient le cumul, hypothèse prudente pour le plancher, mais l'effet réel de la seconde promotion peut être nul. |
| Promotion nouvelle annonce | Remise dernière minute | Une seule s'applique | AIRBNB_DISCOUNTS | Une seule des remises principales s'applique à une réservation. Laquelle l'emporte n'est pas énoncé par l'aide officielle : le simulateur retient le cumul, hypothèse prudente pour le plancher, mais l'effet réel de la seconde promotion peut être nul. |
| Promotion nouvelle annonce | Remise voyageur très bien noté | Cumulables | AIRBNB_DISCOUNTS | La remise voyageur très bien noté est la seule à se cumuler avec les autres remises principales. |
| Promotion personnalisée | Promotion personnalisée | Une seule s'applique | AIRBNB_DISCOUNTS | Une seule des remises principales s'applique à une réservation. Laquelle l'emporte n'est pas énoncé par l'aide officielle : le simulateur retient le cumul, hypothèse prudente pour le plancher, mais l'effet réel de la seconde promotion peut être nul. |
| Promotion personnalisée | Remise de durée de séjour (hebdomadaire, mensuelle, personnalisée) | Une seule s'applique | AIRBNB_DISCOUNTS | Une seule des remises principales s'applique à une réservation. Laquelle l'emporte n'est pas énoncé par l'aide officielle : le simulateur retient le cumul, hypothèse prudente pour le plancher, mais l'effet réel de la seconde promotion peut être nul. |
| Promotion personnalisée | Remise early-bird | Une seule s'applique | AIRBNB_DISCOUNTS | Une seule des remises principales s'applique à une réservation. Laquelle l'emporte n'est pas énoncé par l'aide officielle : le simulateur retient le cumul, hypothèse prudente pour le plancher, mais l'effet réel de la seconde promotion peut être nul. |
| Promotion personnalisée | Remise dernière minute | Une seule s'applique | AIRBNB_DISCOUNTS | Une seule des remises principales s'applique à une réservation. Laquelle l'emporte n'est pas énoncé par l'aide officielle : le simulateur retient le cumul, hypothèse prudente pour le plancher, mais l'effet réel de la seconde promotion peut être nul. |
| Promotion personnalisée | Remise voyageur très bien noté | Cumulables | AIRBNB_DISCOUNTS | La remise voyageur très bien noté est la seule à se cumuler avec les autres remises principales. |
| Remise de durée de séjour (hebdomadaire, mensuelle, personnalisée) | Remise de durée de séjour (hebdomadaire, mensuelle, personnalisée) | Une seule s'applique | AIRBNB_DISCOUNTS | Une seule des remises principales s'applique à une réservation. Laquelle l'emporte n'est pas énoncé par l'aide officielle : le simulateur retient le cumul, hypothèse prudente pour le plancher, mais l'effet réel de la seconde promotion peut être nul. |
| Remise de durée de séjour (hebdomadaire, mensuelle, personnalisée) | Remise early-bird | Une seule s'applique | AIRBNB_DISCOUNTS | Une seule des remises principales s'applique à une réservation. Laquelle l'emporte n'est pas énoncé par l'aide officielle : le simulateur retient le cumul, hypothèse prudente pour le plancher, mais l'effet réel de la seconde promotion peut être nul. |
| Remise de durée de séjour (hebdomadaire, mensuelle, personnalisée) | Remise dernière minute | Une seule s'applique | AIRBNB_DISCOUNTS | Une seule des remises principales s'applique à une réservation. Laquelle l'emporte n'est pas énoncé par l'aide officielle : le simulateur retient le cumul, hypothèse prudente pour le plancher, mais l'effet réel de la seconde promotion peut être nul. |
| Remise de durée de séjour (hebdomadaire, mensuelle, personnalisée) | Remise voyageur très bien noté | Cumulables | AIRBNB_DISCOUNTS | La remise voyageur très bien noté est la seule à se cumuler avec les autres remises principales. |
| Remise early-bird | Remise early-bird | Une seule s'applique | AIRBNB_DISCOUNTS | Une seule des remises principales s'applique à une réservation. Laquelle l'emporte n'est pas énoncé par l'aide officielle : le simulateur retient le cumul, hypothèse prudente pour le plancher, mais l'effet réel de la seconde promotion peut être nul. |
| Remise early-bird | Remise dernière minute | Une seule s'applique | AIRBNB_DISCOUNTS | Une seule des remises principales s'applique à une réservation. Laquelle l'emporte n'est pas énoncé par l'aide officielle : le simulateur retient le cumul, hypothèse prudente pour le plancher, mais l'effet réel de la seconde promotion peut être nul. |
| Remise early-bird | Remise voyageur très bien noté | Cumulables | AIRBNB_DISCOUNTS | La remise voyageur très bien noté est la seule à se cumuler avec les autres remises principales. |
| Remise dernière minute | Remise dernière minute | Une seule s'applique | AIRBNB_DISCOUNTS | Une seule des remises principales s'applique à une réservation. Laquelle l'emporte n'est pas énoncé par l'aide officielle : le simulateur retient le cumul, hypothèse prudente pour le plancher, mais l'effet réel de la seconde promotion peut être nul. |
| Remise dernière minute | Remise voyageur très bien noté | Cumulables | AIRBNB_DISCOUNTS | La remise voyageur très bien noté est la seule à se cumuler avec les autres remises principales. |
| Remise voyageur très bien noté | Remise voyageur très bien noté | Inconnue | — | L'aide officielle d'Airbnb ne traite pas cette combinaison. |
