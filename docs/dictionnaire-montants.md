# Dictionnaire canonique des montants

> Document généré par `npm run docs:money` depuis `src/lib/money/dictionary.ts`. Ne pas le modifier à la main : un test échoue s'il diverge du code.

US-001 · blueprint §8.1. SuperHote fait foi pour les réservations et leurs montants ; PriceLabs pour les prix, le marché et les réglages.

## Règles communes

- **Unité** : centimes (1 € = 100), entiers sauf mention contraire dans la fiche du montant. Une valeur absente est `null` (inconnue), jamais zéro.
- **Devise** : EUR, non stockée. Tous les montants sont en euros, implicitement : aucune colonne devise n'existe. SuperHote (`Rental.currency`) et PriceLabs (`currency`) renvoient une devise, qui n'est ni stockée ni contrôlée. Relevé le 19/11/2026 via le connecteur PriceLabs (`get_listing_prices`, annonce du logement de Châtillon) : EUR. À traiter avant d'accueillir un logement hors zone euro.
- **Signe** : en base, tout montant retiré ou payé (commission, frais, coût) est stocké en valeur positive ; le signe n'est porté que par les écarts, les contributions et les étapes de la cascade de prix.
- **Colonnes d'inclusion** : *inclus* = le poste est dans le montant ; *exclu* = il n'y est pas ; *—* = sans objet ; **inconnu** = non établi (voir « À confirmer »). Pour commission et frais de paiement, *inclus* signifie « pas encore déduits » (brut), *exclu* « déjà déduits » (net).

## Réservations stockées

| Montant | Noms dans le code | Source | Nature | Taxe de séjour | TVA | Ménage | Commission | Frais de paiement | Signe | Statut |
|---|---|---|---|---|---|---|---|---|---|---|
| Hébergement brut d'une réservation | `grossRoomCents`, `gross_room_cents` | SuperHote / PriceLabs / Démo | calculé | exclu | **inconnu** | exclu | inclus | inclus | ≥ 0 | à confirmer |
| Frais de ménage facturés au voyageur (réservation) | `cleaningCents`, `cleaning_cents` | SuperHote / PriceLabs | lu | exclu | **inconnu** | inclus | — | — | ≥ 0 | à confirmer |
| Commission de plateforme (réservation) | `commissionCents`, `commission_cents` | SuperHote / PriceLabs / Propriétaire / Démo | lu, sinon estimé | — | inclus | — | — | — | ≥ 0 | établi |
| Frais de paiement (réservation) | `paymentFeeCents`, `payment_fee_cents` | SuperHote / Propriétaire / Démo | lu, sinon estimé | — | **inconnu** | — | — | — | ≥ 0 | à confirmer |

### Hébergement brut d'une réservation

`reservation.gross_room` · reservations.gross_room_cents · type Resa / PlReservation

Revenu d'hébergement après remise, avant commission et frais de paiement. SuperHote : total payé par le voyageur − taxe de séjour − ménage.

Signe : Plancher à 0 si ménage + taxe dépassent le total.

- Réserve : Taxe et ménage ne sont exclus que si SuperHote fournit la ligne `city_tax` / `cleaning_fee` : une ligne absente est comptée 0, et le brut les contient alors (superhote-reservations.ts, `?? 0`).
- Réserve : Chemin de repli PriceLabs : `rental_revenue` sinon `total_cost`, dont la taxe de séjour n'est retirée que si le propriétaire a déclaré une part (`touristTaxPct`, entre 0 et 50 % exclus) ; le ménage n'y est pas retiré, et PriceLabs arrondit à l'euro.
- Réserve : L'écran du logement affiche « hors ménage et taxes de séjour » pour la démo mais « montant total des réservations, net de commissions » pour les données réelles : le second libellé ne correspond pas à la définition ci-dessus.

### Frais de ménage facturés au voyageur (réservation)

`reservation.cleaning` · reservations.cleaning_cents

Somme des lignes `cleaning_fee` de `price_details`. Montant payé par le voyageur, hors hébergement.

`null` = inconnu.

- Réserve : null = ligne absente de la réponse, pas « ménage gratuit ».

### Commission de plateforme (réservation)

`reservation.commission` · reservations.commission_cents

Total retenu à l'hôte par la plateforme, TVA hôte comprise (ligne `host_platform_commission` seule si elle existe, sinon somme des lignes `host_fees`). Absente chez SuperHote : estimée au taux déclaré du canal ; réservation directe : 0.

Signe : Stockée en valeur positive et soustraite du brut.

`null` = inconnu.

- Réserve : SuperHote renvoie ces lignes en positif sur l'API réelle (16/11/2026, superhote-map.ts) ; la page https://docs.superhote.com/api-v2 consultée le 19/11/2026 les dit « généralement négatives » : le code prend la valeur absolue.
- Réserve : Une valeur estimée n'est pas distinguée d'une valeur observée en base (seul l'objet en mémoire porte `commissionEstimated`).
- Réserve : Repli PriceLabs : `ota_commission` quand il est > 0 (souvent 0 chez PriceLabs, donc estimée).
- Réserve : Base : le taux observé se calcule sur total − taxe de séjour (ménage compris), le taux déclaré s'applique au brut hors ménage.

### Frais de paiement (réservation)

`reservation.payment_fee` · reservations.payment_fee_cents

Booking.com : écart de versement (total − taxe de séjour − commission − versement hôte) s'il est plausible (0 à 5 % de la base) ; sinon estimé au taux déclaré. Airbnb : taux de frais de paiement posé à 0 % par défaut dans `costs.ts`, jamais saisi. Direct : 0 par règle, pas par lecture.

`null` = inconnu.

- Réserve : Inféré d'un écart, pas lu dans une ligne dédiée ; le versement Booking retire aussi d'autres montants (environ 1 %).
- Réserve : Un champ « frais de paiement Booking » laissé vide devient 0 % dans `costs.ts` (`?? 0`) au lieu d'inconnu.
- Réserve : Même réserve de base que la commission (taux observé sur total − taxe, appliqué au brut hors ménage).

## Montants bruts SuperHote (lecture)

| Montant | Noms dans le code | Source | Nature | Taxe de séjour | TVA | Ménage | Commission | Frais de paiement | Signe | Statut |
|---|---|---|---|---|---|---|---|---|---|---|
| Total payé par le voyageur (`total_price`) | `totalCents` | SuperHote | lu | inclus | **inconnu** | inclus | inclus | inclus | ≥ 0 | à confirmer |
| Versement net à l'hôte (`host_payout`) | `hostPayoutCents` | SuperHote | lu | **inconnu** | **inconnu** | **inconnu** | exclu | **inconnu** | ≥ 0 | à confirmer |
| Taxe de séjour (réservation) | `cityTaxCents` | SuperHote | lu | inclus | — | — | — | — | ≥ 0 | établi |
| Retenues à l'hôte (`host_fees`) | `hostFeesCents` | SuperHote | lu | — | inclus | — | — | — | ≥ 0 | établi |
| Prix de calendrier SuperHote (`price`) | `fetchPublishedPriceCents`, `DEFAULT_TOLERANCE_CENTS` | SuperHote | lu | **inconnu** | **inconnu** | **inconnu** | inclus | inclus | ≥ 0 | à confirmer |
| Ligne de retenue à l'hôte | `ShFeeLine.cents` | SuperHote | lu | — | **inconnu** | — | — | — | signé | à confirmer |

### Total payé par le voyageur (`total_price`)

`superhote.total_price` · ShReservation.totalCents (non stocké)

Montant payé par le voyageur : hébergement, ménage et taxe de séjour, avant toute retenue de la plateforme.

`null` = inconnu.

- Réserve : Les inclusions de taxe de séjour et de ménage sont déduites du calcul validé sur l'API réelle (16/11/2026), la documentation les laissant implicites. Un total à 0 € confirmé = blocage propriétaire.

### Versement net à l'hôte (`host_payout`)

`superhote.host_payout` · ShReservation.hostPayoutCents (non stocké)

Net versé à l'hôte, après retenues de la plateforme.

`null` = inconnu.

- Réserve : Circularité : les frais de paiement sont DÉDUITS de l'écart entre ce versement et le total ; on ne peut donc pas s'en servir pour les établir. L'exclusion de la commission vient de la documentation SuperHote, pas d'une lecture.
- Réserve : Sur Booking, retire environ 1 % de plus que total − taxe − commission : ce n'est pas un contrôle de la commission.

### Taxe de séjour (réservation)

`superhote.city_tax` · ShReservation.cityTaxCents (non stocké)

Somme des lignes de taxe de séjour de `price_details` (`city_tax`, ou type `guest_exclusive_tax_*` pour Airbnb). Collectée pour la commune : jamais un revenu.

`null` = inconnu.

- Réserve : null = aucune ligne de taxe trouvée (inconnue, pas forcément nulle).

### Retenues à l'hôte (`host_fees`)

`superhote.host_fees` · ShReservation.hostFeesCents (non stocké)

Total des lignes `host_fees` : frais de plateforme et TVA hôte, sans double compte (le total TTC est repris seul quand il existe).

Signe : Valeur absolue, quel que soit le signe renvoyé.

`null` = inconnu.

- Réserve : Alimente `commissionCents` ; null = lignes absentes de la réponse.

### Prix de calendrier SuperHote (`price`)

`superhote.calendar_price` · ShNight.priceCents (superhote-map.ts) · fetchPublishedPriceCents (interface non branchée)

Prix de la nuitée dans le calendrier SuperHote, converti d'unités majeures en centimes. Doit permettre de contrôler le prix publié estimé.

Signe : D'après https://docs.superhote.com/api-v2 (consultée le 19/11/2026), la valeur doit être ≥ 0 à l'écriture.

`null` = inconnu.

- Réserve : `fetchPublishedPriceCents` appartient à une interface de vérification NON BRANCHÉE (superhote-check.ts) : seul `ShNight.priceCents` est lu aujourd'hui.
- Réserve : La documentation relie la devise au logement (`Rental.currency`), pas au prix.
- Réserve : Une comparaison avec le prix recommandé `price` de PriceLabs (écart ≤ 1 €) indique si ce prix est avant ou après majoration de canal ; relevé réel : identique, donc avant majoration.

### Ligne de retenue à l'hôte

`superhote.fee_line` · ShFeeLine.cents (non stocké)

Montant d'une ligne de `host_fees` (frais de plateforme, TVA hôte), avec son taux de TVA propre (`vat_rate`).

Signe : Signe non fixé par SuperHote : positif observé, négatif d'après la doc ; le code prend la valeur absolue pour le total.

## Prix et calendrier

| Montant | Noms dans le code | Source | Nature | Taxe de séjour | TVA | Ménage | Commission | Frais de paiement | Signe | Statut |
|---|---|---|---|---|---|---|---|---|---|---|
| Prix retenu par le moteur (nuit) | `priceCents`, `price_cents` | PriceLabs / SuperHote / Démo | calculé | **inconnu** | **inconnu** | **inconnu** | inclus | inclus | ≥ 0 | à confirmer |
| Prix recommandé PriceLabs (`price`) | `recommendedPriceCents`, `recommended_price_cents`, `recommendedCents` | PriceLabs | lu | **inconnu** | **inconnu** | **inconnu** | inclus | inclus | ≥ 0 | à confirmer |
| Prix envoyé à SuperHote (`user_price`) | `sentPriceCents`, `sent_price_cents`, `sentCents` | PriceLabs | lu | **inconnu** | **inconnu** | **inconnu** | inclus | inclus | ≥ 0 | à confirmer |
| Prix publié estimé (canal) | `exactCents`, `estimatedCents` | Calcul | estimé | **inconnu** | **inconnu** | **inconnu** | inclus | inclus | ≥ 0 | à confirmer |
| Prix affiché dans le calendrier du logement | `shownCents` | PriceLabs / Calcul | calculé | **inconnu** | **inconnu** | **inconnu** | inclus | inclus | ≥ 0 | à confirmer |
| Prix publié constaté chez SuperHote | `actualCents` | SuperHote | lu | **inconnu** | **inconnu** | **inconnu** | inclus | inclus | ≥ 0 | à confirmer |
| Prix de nuit d'une action simulée | `nightlyCents` | Calcul | calculé | **inconnu** | **inconnu** | **inconnu** | inclus | inclus | ≥ 0 | à confirmer |
| Prix publié estimé arrondi à l'euro | `displayEuros` | Calcul | estimé | **inconnu** | **inconnu** | **inconnu** | inclus | inclus | ≥ 0 | à confirmer |

### Prix retenu par le moteur (nuit)

`price.engine` · calendar_days.price_cents · type Day · CalendarPatch.priceCents (`ShNight.priceCents` est le prix de calendrier SuperHote : voir superhote.calendar_price)

Prix par nuit utilisé par les calculs, AVANT majoration de canal. SuperHote fait foi : prix de calendrier SuperHote quand il est rattaché et lisible ; sinon `price` (prix recommandé) PriceLabs si la nuit est libre. `user_price` n'est jamais retenu (relevé réel : 127 € contre 77 € affichés par SuperHote). Le prix vendu d'un canal = ce prix × (1 + majoration du canal), puis remises, commission, coûts. Entre deux lectures, le calendrier est complété par `priceCents ?? recommendedPriceCents` quand SuperHote libère une nuit. Démo : posé égal au prix envoyé.

Signe : −1 chez PriceLabs = indisponible → null.

`null` = inconnu.

- Réserve : Une nuit réservée peut garder un prix conservé lors d'un recalage SuperHote.
- Réserve : Prix catalogue : jamais net de commission, jamais après majoration de canal SuperHote.

### Prix recommandé PriceLabs (`price`)

`price.recommended` · calendar_days.recommended_price_cents

Prix recommandé par PriceLabs pour la nuit. Base du prix publié estimé.

`null` = inconnu.

- Réserve : Peut différer de `user_price` (écarts relevés le 19/11/2026 via le connecteur PriceLabs sur une même nuit) : ne jamais les confondre.

### Prix envoyé à SuperHote (`user_price`)

`price.sent` · calendar_days.sent_price_cents

Prix que PriceLabs pousse vers SuperHote pour la nuit. Conservé pour comparer avec le prix de calendrier SuperHote.

Signe : −1 = nuit réservée ou bloquée → null.

`null` = inconnu.

### Prix publié estimé (canal)

`price.published_estimate` · PublishedEstimate.exactCents · comparePublishedPrice

prix recommandé × (1 + majoration du canal ÷ 100), valeur exacte en centimes décimaux conservée, arrondie à l'euro à l'affichage seulement. La majoration est saisie par le propriétaire, en pourcentage ; inconnue = pas d'estimation.

Unité : centimes non arrondis.

`null` = inconnu.

- Réserve : Estimation d'affichage : SuperHote ne communique pas ses majorations par canal.

### Prix affiché dans le calendrier du logement

`price.shown_in_calendar` · page du logement (calendrier D+90)

Prix d'une nuit libre montré à l'écran : le prix publié estimé du canal choisi (arrondi à l'euro ; inconnu si la majoration l'est), ou, sans canal choisi, le prix du calendrier (SuperHote, avant majoration).

`null` = inconnu.

### Prix publié constaté chez SuperHote

`price.published_actual` · comparePublishedPrice(estimé, constaté)

Prix lu chez SuperHote, comparé au prix publié estimé. Chemin NON BRANCHÉ aujourd'hui (superhote-check.ts) ; la comparaison active est `comparePriceSeries` (prix de calendrier SuperHote contre `user_price`).

`null` = inconnu.

### Prix de nuit d'une action simulée

`price.night_in_action` · RevenueAction.parameters.nightlyCents

Prix par nuit porté par une action. Appliqué sur la nuit comme prix retenu seulement pour le rétablissement d'un plancher et l'exclusion de règle ; pour un changement en pourcentage, il est informatif et l'exécution applique le pourcentage, arrondi à l'euro.

### Prix publié estimé arrondi à l'euro

`price.display_euros` · PublishedEstimate.displayEuros

Valeur d'affichage de `price.published_estimate`, en euros entiers (et non en centimes) ; multipliée par 100 pour l'écran du logement.

Unité : euros (pas des centimes).

## Réglages de prix du logement

| Montant | Noms dans le code | Source | Nature | Taxe de séjour | TVA | Ménage | Commission | Frais de paiement | Signe | Statut |
|---|---|---|---|---|---|---|---|---|---|---|
| Prix de base | `basePriceCents`, `baseCents`, `previousBasePriceCents` | PriceLabs | lu | **inconnu** | **inconnu** | **inconnu** | inclus | inclus | ≥ 0 | à confirmer |
| Prix minimum | `minPriceCents`, `minCents`, `previousMinPriceCents`, `proposedMinCents` | PriceLabs / Calcul | lu | **inconnu** | **inconnu** | **inconnu** | inclus | inclus | ≥ 0 | à confirmer |
| Prix maximum | `maxPriceCents`, `maxCents` | PriceLabs | lu | **inconnu** | **inconnu** | **inconnu** | inclus | inclus | ≥ 0 | à confirmer |

### Prix de base

`strategy.base_price` · properties.strategy.basePriceCents · PlListing.baseCents (`parameters.basePriceCents` d'une action est une valeur PROPOSÉE, calculée, voir sim.expected_delta)

Base Price PriceLabs du logement. `previousBasePriceCents` conserve l'ancienne valeur pour le retour arrière.

`null` = inconnu.

- Réserve : PriceLabs renvoie un prix calculé quand aucun n'est fixé explicitement (changelog https://developers.pricelabs.co/customer-api/changelog/changelog/2024/7/9).

### Prix minimum

`strategy.min_price` · properties.strategy.minPriceCents · PlListing.minCents · paramètres de l'option PB-13 (previousMinPriceCents, proposedMinCents)

Min Price PriceLabs : prix catalogue plancher, avant majoration de canal et avant commission. Ne dit rien du net : le plancher économique est un autre montant. PB-13 compare ce minimum × (1 + majoration du canal) au plancher absolu et propose, si besoin, le plus petit minimum entier qui le respecte (previousMinPriceCents = minimum actuel, proposedMinCents = minimum proposé).

`null` = inconnu.

### Prix maximum

`strategy.max_price` · properties.strategy.maxPriceCents · PlListing.maxCents

Max Price PriceLabs : prix catalogue plafond, avant commission.

`null` = inconnu.

## Marché

| Montant | Noms dans le code | Source | Nature | Taxe de séjour | TVA | Ménage | Commission | Frais de paiement | Signe | Statut |
|---|---|---|---|---|---|---|---|---|---|---|
| Prix moyen du marché | `marketAdrCents`, `market_adr_cents` | PriceLabs | lu | **inconnu** | **inconnu** | **inconnu** | inclus | inclus | ≥ 0 | à confirmer |

### Prix moyen du marché

`market.adr` · market_days.market_adr_cents · type Day

Prix médian réservé du voisinage PriceLabs (`Median Booked Price`), sinon 50e centile des prix affichés.

`null` = inconnu.

- Réserve : Mélange possible de prix réservés et de prix affichés selon les séries disponibles.

## Modèle économique (saisi par le propriétaire)

| Montant | Noms dans le code | Source | Nature | Taxe de séjour | TVA | Ménage | Commission | Frais de paiement | Signe | Statut |
|---|---|---|---|---|---|---|---|---|---|---|
| Frais de ménage facturés (réglage) | `cleaningFeeChargedCents` | Propriétaire | déclaré | — | **inconnu** | inclus | — | — | ≥ 0 | à confirmer |
| Coût du ménage | `cleaningCostCents` | Propriétaire | déclaré | — | **inconnu** | — | — | — | ≥ 0 | à confirmer |
| Coût du linge | `linenCostCents` | Propriétaire | déclaré | — | **inconnu** | — | — | — | ≥ 0 | à confirmer |
| Coûts variables par nuit occupée | `nightlyVariableCostCents` | Propriétaire | déclaré | — | **inconnu** | — | — | — | ≥ 0 | à confirmer |
| Seuil de dérangement par nuit | `hardContributionPerNightCents` | Propriétaire | déclaré | — | **inconnu** | — | — | — | ≥ 0 | à confirmer |
| Charges fixes à couvrir par nuit vendue | `strategyContributionPerNightCents` | Propriétaire / Calcul | calculé | — | **inconnu** | — | — | — | ≥ 0 | à confirmer |
| Contribution visée par nuit vendue | `targetContributionPerNightCents` | Propriétaire / Calcul | calculé | — | **inconnu** | — | — | — | ≥ 0 | à confirmer |
| Réponses brutes du parcours « Coûts et seuils » | `CostAnswers` | Propriétaire | déclaré | — | **inconnu** | — | — | — | ≥ 0 | à confirmer |
| Part de taxe de séjour dans le total des réservations | `touristTaxPct` | Propriétaire | déclaré | inclus | — | — | — | — | ≥ 0 | établi |
| Charges fixes du mois (seuil de rentabilité) | `fixedMonthlyCents`, `fixedCents` | Propriétaire / Calcul | calculé | — | **inconnu** | — | — | — | ≥ 0 | à confirmer |

### Frais de ménage facturés (réglage)

`economics.cleaning_fee_charged` · properties.economics.cleaningFeeChargedCents

Ménage que le propriétaire facture au voyageur par séjour.

`null` = inconnu.

- Réserve : Le calcul du plancher en retire la commission : on suppose donc que la plateforme prélève sa commission sur le ménage, ce que rien ne confirme.

### Coût du ménage

`economics.cleaning_cost` · properties.economics.cleaningCostCents

Ce que coûte le ménage d'un séjour au propriétaire.

`null` = inconnu.

### Coût du linge

`economics.linen_cost` · properties.economics.linenCostCents

Coût du linge par séjour. 0 si le linge est compris dans le ménage.

`null` = inconnu.

### Coûts variables par nuit occupée

`economics.nightly_variable_cost` · properties.economics.nightlyVariableCostCents

Énergie, eau et consommables rapportés à une nuit occupée.

`null` = inconnu.

### Seuil de dérangement par nuit

`economics.hard_contribution` · properties.economics.hardContributionPerNightCents

Contribution minimale absolue par nuit : sous ce seuil, l'auditeur oppose un veto.

`null` = inconnu.

### Charges fixes à couvrir par nuit vendue

`economics.strategy_contribution` · properties.economics.strategyContributionPerNightCents

« Contribution de sécurité » par nuit : charges fixes mensuelles ÷ nuits vendues par mois, jamais en dessous du seuil de dérangement. Sert au plancher stratégique.

`null` = inconnu.

### Contribution visée par nuit vendue

`economics.target_contribution` · properties.economics.targetContributionPerNightCents

(charges fixes + revenu mensuel visé) ÷ nuits vendues par mois, jamais en dessous du plancher stratégique.

`null` = inconnu.

### Réponses brutes du parcours « Coûts et seuils »

`economics.answers` · properties.economics.answers (chaînes) · fixedMonthly() · variablePerNight()

Montants saisis en euros, sous forme de texte (loyer, copropriété, assurance, abonnements, taxes, autres charges, revenu mensuel visé, énergie et eau annuelles, consommables, taxe de séjour annuelle, brut annuel, coûts par nuit, seuil, ménage, linge). Convertis en centimes par `modelFromAnswers`, qui produit les montants `economics.*`.

Unité : euros (pas des centimes).

`null` = inconnu.

- Réserve : Seul endroit où des montants sont en euros et non en centimes ; une valeur vide est inconnue (null), 0 n'est retenu que s'il est écrit.

### Part de taxe de séjour dans le total des réservations

`economics.tourist_tax_pct` · properties.economics.touristTaxPct (pourcentage, pas un montant)

Pourcentage retiré du total des réservations PriceLabs pour obtenir l'hébergement brut. Sans objet pour SuperHote, qui fournit la taxe par réservation.

`null` = inconnu.

- Réserve : Appliqué seulement entre 0 et 50 % exclus.

### Charges fixes du mois (seuil de rentabilité)

`economics.fixed_monthly` · paramètre des fonctions de seuil de rentabilité (economics.ts), calculé depuis les réponses du parcours « Charges fixes » (properties.economics.answers, en euros)

Somme des charges mensuelles saisies : loyer ou mensualité de crédit (comptée seulement si le propriétaire ne l'a pas décochée), copropriété, assurance, abonnements, taxes, autres. Sert uniquement au seuil de rentabilité du mois, jamais à baisser un prix.

`null` = inconnu.

## Planchers et simulation

| Montant | Noms dans le code | Source | Nature | Taxe de séjour | TVA | Ménage | Commission | Frais de paiement | Signe | Statut |
|---|---|---|---|---|---|---|---|---|---|---|
| Coût de séjour non récupéré | `unrecoveredStayCostCents` | Calcul | calculé | — | **inconnu** | inclus | exclu | exclu | signé | à confirmer |
| Plancher brut par nuit (dur, stratégique) | `floorGrossNightlyCents`, `hardFloorCents`, `strategyFloorCents`, `hardCents`, `strategyCents` | Calcul | calculé | exclu | **inconnu** | exclu | inclus | inclus | ≥ 0 | à confirmer |
| Prix minimal du seuil de rentabilité (prix brut par nuit) | `breakEvenPriceCents`, `grossNightlyCents` | Calcul | calculé | exclu | **inconnu** | exclu | inclus | inclus | ≥ 0 | à confirmer |
| Prix vendu par nuit (simulation) | `soldNightlyCents`, `publishedNightlyCents`, `soldAtMinCents` | PriceLabs / Calcul | calculé | **inconnu** | **inconnu** | **inconnu** | inclus | inclus | ≥ 0 | à confirmer |
| Revenu net d'hébergement (simulation) | `netRoomCents` | Calcul | calculé | exclu | **inconnu** | exclu | exclu | exclu | ≥ 0 | à confirmer |
| Contribution (simulation) | `contributionCents`, `contributionPerNightCents` | Calcul | calculé | exclu | **inconnu** | inclus | exclu | exclu | signé | à confirmer |
| Étape de la cascade de prix | `WaterfallStep.cents` | Calcul | calculé | **inconnu** | **inconnu** | **inconnu** | **inconnu** | **inconnu** | signé | à confirmer |
| Écart de contribution attendu / impact net | `expectedDeltaCents`, `impactCents`, `impact_cents` | Calcul | estimé | exclu | **inconnu** | inclus | exclu | exclu | signé | à confirmer |
| Effet incrémental mesuré | `incrementalCents` | Calcul | non calculé | exclu | **inconnu** | inclus | exclu | exclu | signé | à confirmer |

### Coût de séjour non récupéré

`floor.unrecovered_stay_cost` · fonction unrecoveredStayCostCents

Ménage + linge − frais de ménage facturés nets de commission et de frais de paiement.

Signe : Négatif = le ménage dégage une marge.

### Plancher brut par nuit (dur, stratégique)

`floor.gross_nightly` · fonctions de economics.ts · floorGrid

Prix de vente minimal par nuit (hébergement, avant commission) pour atteindre la contribution visée sur un séjour de n nuits, formule du blueprint §8.3. Arrondi à l'unité supérieure.

- Réserve : Comparable à un prix d'hébergement brut, pas au prix catalogue PriceLabs tant que ses inclusions restent inconnues.

### Prix minimal du seuil de rentabilité (prix brut par nuit)

`floor.break_even` · fonctions breakEvenPriceCents · breakEvenNights · contributionPerNightCents (economics.ts)

Prix brut par nuit (hébergement, avant commission) qui, multiplié par le nombre de nuits vendues dans le mois, couvre les charges fixes du mois. Entrée du calcul inverse : prix brut saisi pour obtenir le nombre de nuits à vendre. Objectif de pilotage mensuel, pas un plancher.

- Réserve : Comparable à un prix d'hébergement brut, pas au prix catalogue PriceLabs tant que ses inclusions restent inconnues.

### Prix vendu par nuit (simulation)

`sim.sold_nightly` · StackResult.soldNightlyCents · StackInput.publishedNightlyCents

Prix publié par nuit en entrée de la cascade ; prix vendu par nuit après remises en sortie, avant commission.

### Revenu net d'hébergement (simulation)

`sim.net_room` · StackResult.netRoomCents · StackResult.grossRoomCents (hébergement vendu après remises, sans lien avec une réservation)

Hébergement vendu − commission − frais de paiement, avant coûts. Ordre canonique : prix publié → durée → promotions → commission → paiement → coûts.

### Contribution (simulation)

`sim.contribution` · StackResult.contributionCents · contributionPerNightCents

Revenu net d'hébergement − coût de séjour non récupéré − coûts variables, par séjour et par nuit.

Signe : Négatif = séjour déficitaire.

### Étape de la cascade de prix

`sim.waterfall_step` · type WaterfallStep.cents

Montant d'une ligne de la cascade : le prix de départ et les sous-totaux sont positifs, les remises, commissions et coûts sont négatifs.

Signe : Seul endroit où commission et coûts sont portés en négatif ; en base ils sont positifs.

- Réserve : Les inclusions varient d'une ligne à l'autre ; chacune se lit dans son libellé et sa source.

### Écart de contribution attendu / impact net

`sim.expected_delta` · Candidate.expectedDeltaCents · opportunities.impact_cents

Variation de contribution simulée d'une option, hypothèse comprise. Une simulation, pas une prévision.

Signe : Positif = gain, négatif = perte.

`null` = inconnu.

- Réserve : null = non chiffrable ; 0 est écrit pour NO_ACTION (review.ts).

### Effet incrémental mesuré

`sim.incremental` · RevenueAction.measurement.incrementalCents

Gain ou perte attribué à une action après sa fenêtre d'observation. JAMAIS CALCULÉ aujourd'hui : toujours null (decisions.ts, seed.ts), faute de période témoin comparable.

`null` = inconnu.

## Indicateurs

| Montant | Noms dans le code | Source | Nature | Taxe de séjour | TVA | Ménage | Commission | Frais de paiement | Signe | Statut |
|---|---|---|---|---|---|---|---|---|---|---|
| Revenu brut d'hébergement (période) | `grossCents` | Calcul | calculé | exclu | **inconnu** | exclu | inclus | inclus | ≥ 0 | à confirmer |
| ADR (prix moyen par nuit occupée) | `adrCents` | Calcul | calculé | exclu | **inconnu** | exclu | inclus | inclus | ≥ 0 | à confirmer |
| RevPAN brut (revenu brut par nuit disponible) | `grossRevpanCents` | Calcul | calculé | exclu | **inconnu** | exclu | inclus | inclus | ≥ 0 | à confirmer |
| Revenu net d'hébergement (période) | `netCents` | Calcul | calculé | exclu | **inconnu** | exclu | exclu | exclu | signé | à confirmer |
| Net ADR et Net RevPAN | `netAdrCents`, `netRevpanCents` | Calcul | calculé | exclu | **inconnu** | exclu | exclu | exclu | signé | à confirmer |
| Net par canal (période) | `MonthKpi.byChannel` | Calcul | calculé | exclu | **inconnu** | exclu | exclu | exclu | signé | à confirmer |
| Prix moyen des nuits libres (fenêtre) | `avgFreePriceCents` | Calcul | calculé | **inconnu** | **inconnu** | **inconnu** | inclus | inclus | ≥ 0 | à confirmer |

### Revenu brut d'hébergement (période)

`kpi.gross` · MonthKpi.grossCents · Kpi.grossRoomCents (metrics/kpi.ts)

Somme des hébergements bruts répartis par nuit (centimes entiers, somme exacte) sur la période de séjour.

- Réserve : Hérite des réserves de `reservation.gross_room`, notamment le chemin de repli PriceLabs.

### ADR (prix moyen par nuit occupée)

`kpi.adr` · MonthKpi.adrCents · Kpi.adrCents (metrics/kpi.ts)

Brut ÷ nuits vendues de la période.

`null` = inconnu.

- Réserve : null = aucune nuit occupée.

### RevPAN brut (revenu brut par nuit disponible)

`kpi.gross_revpan` · Kpi.grossRevpanCents (metrics/kpi.ts)

Brut ÷ nuits disponibles (nuits de la période moins les nuits bloquées par le propriétaire).

`null` = inconnu.

- Réserve : null = aucune nuit disponible sur la période.

### Revenu net d'hébergement (période)

`kpi.net` · MonthKpi.netCents · Kpi.netRoomCents (metrics/kpi.ts)

Brut − commissions − frais de paiement, par nuit de séjour, sur les nuits dont la commission est connue.

Signe : Négatif si les retenues dépassent le brut (brut plancher à 0).

`null` = inconnu.

- Réserve : Une commission inconnue n'est jamais comptée pour 0 (US-050) : la nuit sort du net, `netIncomplete` (mensuel) ou `netStatus` PARTIAL/UNKNOWN (KPI canonique) le signale. `Kpi.netRoomCents` vaut null si aucune commission n'est connue.
- Réserve : Un frais de paiement absent compte pour 0, sans signal : seule la commission décide si le net est connu (Airbnb n'a pas de frais de paiement).

### Net ADR et Net RevPAN

`kpi.net_adr` · MonthKpi.netAdrCents · netRevpanCents · Kpi.netAdrCents · netRevpanCents (metrics/kpi.ts)

Net ADR = net ÷ nuits vendues dont la commission est connue (null sans nuit connue) ; Net RevPAN = net ÷ nuits disponibles.

`null` = inconnu.

- Réserve : `Kpi.netRevpanCents` est null tant que le net n'est pas connu pour TOUTES les nuits vendues (statut COMPLETE) : un Net RevPAN partiel serait sous-évalué. La vue mensuelle `MonthKpi.netRevpanCents` reste un nombre (net connu ÷ disponibles) et doit se lire avec `netIncomplete`.

### Net par canal (période)

`kpi.net_by_channel` · MonthKpi.byChannel

Net cumulé par canal sur le mois, en centimes non arrondis.

Unité : centimes non arrondis.

### Prix moyen des nuits libres (fenêtre)

`kpi.avg_free_price` · WindowStat.avgFreePriceCents

Moyenne du prix retenu sur les nuits libres d'une fenêtre canonique (J+0–7, 8–14, 15–30, 31–60, 61–90).

`null` = inconnu.

## Contrôles d'écart

| Montant | Noms dans le code | Source | Nature | Taxe de séjour | TVA | Ménage | Commission | Frais de paiement | Signe | Statut |
|---|---|---|---|---|---|---|---|---|---|---|
| Montant comparé entre sources | `shCents`, `plCents` | SuperHote / PriceLabs | lu | **inconnu** | **inconnu** | **inconnu** | inclus | inclus | ≥ 0 | à confirmer |
| Écart entre deux montants | `gapCents`, `maxGapCents`, `medianGapCents` | Calcul | calculé | — | — | — | — | — | signé | établi |
| Tolérance de comparaison | `toleranceCents` | Calcul | calculé | — | — | — | — | — | ≥ 0 | établi |

### Montant comparé entre sources

`check.compared_amount` · ReservationGap · PriceCheckSummary.samples

Total de réservation (`total_price` SuperHote contre `total_cost` PriceLabs) ou prix de nuit (calendrier SuperHote), selon le contrôle. Rapprochés, jamais corrigés.

`null` = inconnu.

- Réserve : Les deux côtés doivent avoir la même composition pour que l'écart ait un sens ; PriceLabs arrondit à l'euro.

### Écart entre deux montants

`check.gap` · PriceCheck.gapCents · PriceCheckSummary

Différence (constaté − estimé, ou SuperHote − envoyé) entre deux prix de nuit ; maximum et médiane sur une série.

Signe : Positif = le montant de gauche dépasse celui de droite.

`null` = inconnu.

- Réserve : `maxGapCents` est une valeur absolue ; `medianGapCents` est la médiane haute (élément n/2 du tri).

### Tolérance de comparaison

`check.tolerance` · paramètre des fonctions de comparaison (100 par défaut)

Écart toléré avant de signaler une différence : 1 € par défaut, car PriceLabs arrondit à l'euro.

## À confirmer

45 montants sur 51 ont au moins une inclusion non établie. Aucune valeur n'est supposée : tant qu'ils restent inconnus, toute décision qui en dépend devra demander une validation humaine (US-003, pas encore implémenté).

- TVA : SuperHote ne dit pas si `total_price` est TTC. Lire `vat_rate` des lignes `price_details` sur des réservations réelles. — `reservation.gross_room`
- TVA sur le ménage : lire `vat_rate` de la ligne `cleaning_fee` sur des réservations réelles. — `reservation.cleaning`
- TVA sur les frais de paiement : non établie. Un taux de frais de paiement Airbnb est aussi à confirmer, il est supposé nul. — `reservation.payment_fee`
- TVA : non précisée par la documentation SuperHote. — `superhote.total_price`
- Taxe de séjour, ménage, frais de paiement et TVA : non établis. Comparer Comparer `host_payout` à `total_price` sur une réservation sans commission ni taxe. — `superhote.host_payout`
- Taxe, TVA, ménage : non précisés par SuperHote. Comparer à ce qu'affiche chaque canal pour la même nuit. — `superhote.calendar_price`
- La documentation PriceLabs (Customer API) ne dit pas si les prix incluent taxe de séjour, TVA ou ménage. À lever par un cas concret : comparer le prix d'une nuit à ce que voit le voyageur sur le canal. — `price.engine`, `price.recommended`, `price.sent`, `price.published_estimate`, `price.shown_in_calendar`, `price.published_actual`, `price.night_in_action`, `strategy.base_price`, `strategy.min_price`, `strategy.max_price`, `price.display_euros`, `sim.sold_nightly`, `kpi.avg_free_price`
- Taxes, TVA et ménage non précisés par PriceLabs pour les données de voisinage. — `market.adr`
- Préciser dans le parcours « Coûts et seuils » si les montants saisis s'entendent TTC ou HT. — `economics.cleaning_fee_charged`, `economics.cleaning_cost`, `economics.linen_cost`, `economics.nightly_variable_cost`, `economics.hard_contribution`, `economics.strategy_contribution`, `economics.target_contribution`, `economics.answers`, `floor.unrecovered_stay_cost`, `economics.fixed_monthly`, `floor.gross_nightly`, `floor.break_even`, `sim.contribution`, `sim.expected_delta`, `sim.incremental`
- Selon le type de ligne, le montant est ou non TTC : à lire avec `vat_rate` sur des réservations réelles. — `superhote.fee_line`
- Hérite de la TVA du prix publié en entrée de la cascade (voir `price.engine`). — `sim.net_room`
- Fixer une inclusion par clé d'étape (`published`, `promo`, `gross`, `commission`, `fee`, `net`, `stay`, `variable`, `contribution`) si ce montant doit être consommé automatiquement. — `sim.waterfall_step`
- Hérite de la TVA de `reservation.gross_room`. — `kpi.gross`, `kpi.adr`, `kpi.gross_revpan`, `kpi.net`, `kpi.net_adr`, `kpi.net_by_channel`
- Confirmer que `total_cost` PriceLabs a la même composition que `total_price` SuperHote (taxe, ménage) sur des réservations réelles. — `check.compared_amount`
