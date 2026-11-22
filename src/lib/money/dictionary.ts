/**
 * Dictionnaire canonique des montants (US-001, blueprint §8.1).
 *
 * Source unique de vérité sur ce que « veut dire » chaque montant manipulé par NuitSignal : d'où il vient, ce qu'il contient
 * (taxes, ménage, commission, frais de paiement), sa devise et son signe. Le document `docs/dictionnaire-montants.md` en est généré
 * (`npm run docs:money`), et un test (`dictionary.test.ts`) échoue si un montant du code n'y figure pas.
 *
 * Règles d'écriture :
 * - on ne suppose rien : ce qui n'est établi ni par le code, ni par la documentation des API, ni par une lecture des données réelles
 *   est marqué `UNKNOWN` et accompagné de `toVerify` (comment le lever). Une inconnue critique devra produire `NEEDS_HUMAN` (US-003, pas encore implémenté : l'auditeur ne consulte pas ce dictionnaire) ;
 * - SuperHote fait foi pour les réservations et leurs montants ; PriceLabs pour les prix, le marché et les réglages.
 *
 * Lecture des colonnes d'inclusion (`taxes`, `fees`) : `INCLUDED` = le poste est DANS le montant ; `EXCLUDED` = il n'y est PAS
 * (soit parce qu'il en est retiré, soit parce qu'il n'y est jamais entré) ; `NOT_APPLICABLE` = sans objet pour ce montant ;
 * `UNKNOWN` = non établi. Pour la commission et les frais de paiement, `INCLUDED` signifie « pas encore déduits » (montant brut),
 * `EXCLUDED` « déjà déduits » (montant net).
 */

export type Inclusion = "INCLUDED" | "EXCLUDED" | "NOT_APPLICABLE" | "UNKNOWN";
export type MoneySource = "SUPERHOTE" | "PRICELABS" | "OWNER_INPUT" | "COMPUTED" | "DEMO";
/** OBSERVED = lu tel quel chez la source ; DERIVED = calculé par NuitSignal ; DECLARED = saisi par le propriétaire ; ESTIMATED = hypothèse ou taux déclaré ; MIXED = observé quand disponible, sinon estimé ; NOT_COMPUTED = prévu mais aujourd'hui jamais calculé. */
export type Derivation = "OBSERVED" | "DERIVED" | "DECLARED" | "ESTIMATED" | "MIXED" | "NOT_COMPUTED";
/** NON_NEGATIVE : valeur ≥ 0 (un montant retiré ou payé est stocké en valeur positive) ; SIGNED : peut être négatif, le signe a un sens. */
export type Sign = "NON_NEGATIVE" | "SIGNED";
export type MoneyGroup = "RESERVATION" | "SUPERHOTE_RAW" | "PRICE" | "STRATEGY" | "MARKET" | "ECONOMICS" | "FLOOR_SIMULATION" | "KPI" | "CHECK";

export type MoneyField = {
  /** Identifiant stable : `groupe.nom`. */
  id: string;
  label: string;
  /** Identifiants du code (`xxxCents`) ou colonnes SQL (`xxx_cents`) qui portent ce montant. Chaque identifiant n'apparaît que dans une entrée. */
  names: string[];
  group: MoneyGroup;
  /** Où le montant vit : table, type ou valeur calculée. */
  location: string;
  sources: MoneySource[];
  derivation: Derivation;
  /** Phrase de définition, sans jargon inutile. */
  definition: string;
  taxes: { cityTax: Inclusion; vat: Inclusion };
  fees: { cleaning: Inclusion; commission: Inclusion; paymentFee: Inclusion };
  /** Unité de stockage ; CENTS par défaut. CENTS_DECIMAL : centimes non arrondis ; EUROS : euros, pas centimes. */
  unit?: "CENTS" | "CENTS_DECIMAL" | "EUROS";
  /** Toujours EUR aujourd'hui, mais la devise n'est stockée nulle part (voir CURRENCY_POLICY). */
  currency: "EUR";
  sign: Sign;
  signNote?: string;
  /** true : `null` signifie « inconnu » et n'est jamais rendu comme zéro. */
  nullable: boolean;
  /** Réserves : écarts entre sources, chemins non conformes, hypothèses. */
  caveats?: string[];
  /** Obligatoire dès qu'une dimension est `UNKNOWN` : comment la lever. */
  toVerify?: string;
};

export const UNIT = "centimes (1 € = 100), entiers sauf mention contraire dans la fiche du montant" as const;

export const CURRENCY_POLICY = {
  code: "EUR",
  stored: false,
  note: "Tous les montants sont en euros, implicitement : aucune colonne devise n'existe. SuperHote (`Rental.currency`) et PriceLabs (`currency`) renvoient une devise, qui n'est ni stockée ni contrôlée. Relevé le 19/11/2026 via le connecteur PriceLabs (`get_listing_prices`, annonce du logement de Châtillon) : EUR. À traiter avant d'accueillir un logement hors zone euro.",
} as const;

const NA = "NOT_APPLICABLE" as const, INC = "INCLUDED" as const, EXC = "EXCLUDED" as const, UNK = "UNKNOWN" as const;
const noTax = { cityTax: NA, vat: NA };
const noFee = { cleaning: NA, commission: NA, paymentFee: NA };
/** Montant déclaré par le propriétaire : on ne sait pas s'il l'entend TTC ou HT. */
const declaredTax = { cityTax: NA, vat: UNK };
const VAT_DECLARED_TO_VERIFY = "Préciser dans le parcours « Coûts et seuils » si les montants saisis s'entendent TTC ou HT.";
const PRICE_TO_VERIFY = "La documentation PriceLabs (Customer API) ne dit pas si les prix incluent taxe de séjour, TVA ou ménage. À lever par un cas concret : comparer le prix d'une nuit à ce que voit le voyageur sur le canal.";

const f = (x: MoneyField): MoneyField => x;

export const MONEY_DICTIONARY: MoneyField[] = [
  // ───────────── Réservations stockées (SuperHote fait foi) ─────────────
  f({
    id: "reservation.gross_room", label: "Hébergement brut d'une réservation", names: ["grossRoomCents", "gross_room_cents"], group: "RESERVATION",
    location: "reservations.gross_room_cents · type Resa / PlReservation", sources: ["SUPERHOTE", "PRICELABS", "DEMO"], derivation: "DERIVED",
    definition: "Revenu d'hébergement après remise, avant commission et frais de paiement. SuperHote : total payé par le voyageur − taxe de séjour − ménage.",
    taxes: { cityTax: EXC, vat: UNK }, fees: { cleaning: EXC, commission: INC, paymentFee: INC }, currency: "EUR", sign: "NON_NEGATIVE", signNote: "Plancher à 0 si ménage + taxe dépassent le total.", nullable: false,
    caveats: [
      "Taxe et ménage ne sont exclus que si SuperHote fournit la ligne `city_tax` / `cleaning_fee` : une ligne absente est comptée 0, et le brut les contient alors (superhote-reservations.ts, `?? 0`).",
      "Chemin de repli PriceLabs : `rental_revenue` sinon `total_cost`, dont la taxe de séjour n'est retirée que si le propriétaire a déclaré une part (`touristTaxPct`, entre 0 et 50 % exclus) ; le ménage n'y est pas retiré, et PriceLabs arrondit à l'euro.",
      "L'écran du logement affiche « hors ménage et taxes de séjour » pour la démo mais « montant total des réservations, net de commissions » pour les données réelles : le second libellé ne correspond pas à la définition ci-dessus.",
    ],
    toVerify: "TVA : SuperHote ne dit pas si `total_price` est TTC. Lire `vat_rate` des lignes `price_details` sur des réservations réelles.",
  }),
  f({
    id: "reservation.cleaning", label: "Frais de ménage facturés au voyageur (réservation)", names: ["cleaningCents", "cleaning_cents"], group: "RESERVATION",
    location: "reservations.cleaning_cents", sources: ["SUPERHOTE", "PRICELABS"], derivation: "OBSERVED",
    definition: "Somme des lignes `cleaning_fee` de `price_details`. Montant payé par le voyageur, hors hébergement.",
    taxes: { cityTax: EXC, vat: UNK }, fees: { cleaning: INC, commission: NA, paymentFee: NA }, currency: "EUR", sign: "NON_NEGATIVE", nullable: true,
    caveats: ["null = ligne absente de la réponse, pas « ménage gratuit »."],
    toVerify: "TVA sur le ménage : lire `vat_rate` de la ligne `cleaning_fee` sur des réservations réelles.",
  }),
  f({
    id: "reservation.commission", label: "Commission de plateforme (réservation)", names: ["commissionCents", "commission_cents"], group: "RESERVATION",
    location: "reservations.commission_cents", sources: ["SUPERHOTE", "PRICELABS", "OWNER_INPUT", "DEMO"], derivation: "MIXED",
    definition: "Total retenu à l'hôte par la plateforme, TVA hôte comprise (ligne `host_platform_commission` seule si elle existe, sinon somme des lignes `host_fees`). Absente chez SuperHote : estimée au taux déclaré du canal ; réservation directe : 0.",
    taxes: { cityTax: NA, vat: INC }, fees: noFee, currency: "EUR", sign: "NON_NEGATIVE", signNote: "Stockée en valeur positive et soustraite du brut.", nullable: true,
    caveats: [
      "SuperHote renvoie ces lignes en positif sur l'API réelle (16/11/2026, superhote-map.ts) ; la page https://docs.superhote.com/api-v2 consultée le 19/11/2026 les dit « généralement négatives » : le code prend la valeur absolue.",
      "Une valeur estimée n'est pas distinguée d'une valeur observée en base (seul l'objet en mémoire porte `commissionEstimated`).",
      "Repli PriceLabs : `ota_commission` quand il est > 0 (souvent 0 chez PriceLabs, donc estimée).",
      "Base : le taux observé se calcule sur total − taxe de séjour (ménage compris), le taux déclaré s'applique au brut hors ménage.",
    ],
  }),
  f({
    id: "reservation.payment_fee", label: "Frais de paiement (réservation)", names: ["paymentFeeCents", "payment_fee_cents"], group: "RESERVATION",
    location: "reservations.payment_fee_cents", sources: ["SUPERHOTE", "OWNER_INPUT", "DEMO"], derivation: "MIXED",
    definition: "Booking.com : écart de versement (total − taxe de séjour − commission − versement hôte) s'il est plausible (0 à 5 % de la base) ; sinon estimé au taux déclaré. Airbnb : taux de frais de paiement posé à 0 % par défaut dans `costs.ts`, jamais saisi. Direct : 0 par règle, pas par lecture.",
    taxes: { cityTax: NA, vat: UNK }, fees: noFee, currency: "EUR", sign: "NON_NEGATIVE", nullable: true,
    caveats: ["Inféré d'un écart, pas lu dans une ligne dédiée ; le versement Booking retire aussi d'autres montants (environ 1 %).", "Un champ « frais de paiement Booking » laissé vide devient 0 % dans `costs.ts` (`?? 0`) au lieu d'inconnu.", "Même réserve de base que la commission (taux observé sur total − taxe, appliqué au brut hors ménage)."],
    toVerify: "TVA sur les frais de paiement : non établie. Un taux de frais de paiement Airbnb est aussi à confirmer, il est supposé nul.",
  }),
  // ───────────── Montants bruts SuperHote (lecture, non stockés) ─────────────
  f({
    id: "superhote.total_price", label: "Total payé par le voyageur (`total_price`)", names: ["totalCents"], group: "SUPERHOTE_RAW",
    location: "ShReservation.totalCents (non stocké)", sources: ["SUPERHOTE"], derivation: "OBSERVED",
    definition: "Montant payé par le voyageur : hébergement, ménage et taxe de séjour, avant toute retenue de la plateforme.",
    taxes: { cityTax: INC, vat: UNK }, fees: { cleaning: INC, commission: INC, paymentFee: INC }, currency: "EUR", sign: "NON_NEGATIVE", nullable: true,
    caveats: ["Les inclusions de taxe de séjour et de ménage sont déduites du calcul validé sur l'API réelle (16/11/2026), la documentation les laissant implicites. Un total à 0 € confirmé = blocage propriétaire."],
    toVerify: "TVA : non précisée par la documentation SuperHote.",
  }),
  f({
    id: "superhote.host_payout", label: "Versement net à l'hôte (`host_payout`)", names: ["hostPayoutCents"], group: "SUPERHOTE_RAW",
    location: "ShReservation.hostPayoutCents (non stocké)", sources: ["SUPERHOTE"], derivation: "OBSERVED",
    definition: "Net versé à l'hôte, après retenues de la plateforme.",
    taxes: { cityTax: UNK, vat: UNK }, fees: { cleaning: UNK, commission: EXC, paymentFee: UNK }, currency: "EUR", sign: "NON_NEGATIVE", nullable: true,
    caveats: ["Circularité : les frais de paiement sont DÉDUITS de l'écart entre ce versement et le total ; on ne peut donc pas s'en servir pour les établir. L'exclusion de la commission vient de la documentation SuperHote, pas d'une lecture.", "Sur Booking, retire environ 1 % de plus que total − taxe − commission : ce n'est pas un contrôle de la commission."],
    toVerify: "Taxe de séjour, ménage, frais de paiement et TVA : non établis. Comparer Comparer `host_payout` à `total_price` sur une réservation sans commission ni taxe.",
  }),
  f({
    id: "superhote.city_tax", label: "Taxe de séjour (réservation)", names: ["cityTaxCents"], group: "SUPERHOTE_RAW",
    location: "ShReservation.cityTaxCents (non stocké)", sources: ["SUPERHOTE"], derivation: "OBSERVED",
    definition: "Somme des lignes de taxe de séjour de `price_details` (`city_tax`, ou type `guest_exclusive_tax_*` pour Airbnb). Collectée pour la commune : jamais un revenu.",
    taxes: { cityTax: INC, vat: NA }, fees: noFee, currency: "EUR", sign: "NON_NEGATIVE", nullable: true,
    caveats: ["null = aucune ligne de taxe trouvée (inconnue, pas forcément nulle)."],
  }),
  f({
    id: "superhote.host_fees", label: "Retenues à l'hôte (`host_fees`)", names: ["hostFeesCents"], group: "SUPERHOTE_RAW",
    location: "ShReservation.hostFeesCents (non stocké)", sources: ["SUPERHOTE"], derivation: "OBSERVED",
    definition: "Total des lignes `host_fees` : frais de plateforme et TVA hôte, sans double compte (le total TTC est repris seul quand il existe).",
    taxes: { cityTax: NA, vat: INC }, fees: noFee, currency: "EUR", sign: "NON_NEGATIVE", signNote: "Valeur absolue, quel que soit le signe renvoyé.", nullable: true,
    caveats: ["Alimente `commissionCents` ; null = lignes absentes de la réponse."],
  }),
  f({
    id: "superhote.calendar_price", label: "Prix de calendrier SuperHote (`price`)", names: ["fetchPublishedPriceCents", "DEFAULT_TOLERANCE_CENTS"], group: "SUPERHOTE_RAW",
    location: "ShNight.priceCents (superhote-map.ts) · fetchPublishedPriceCents (interface non branchée)", sources: ["SUPERHOTE"], derivation: "OBSERVED",
    definition: "Prix de la nuitée dans le calendrier SuperHote, converti d'unités majeures en centimes. Doit permettre de contrôler le prix publié estimé.",
    taxes: { cityTax: UNK, vat: UNK }, fees: { cleaning: UNK, commission: INC, paymentFee: INC }, currency: "EUR", sign: "NON_NEGATIVE", signNote: "D'après https://docs.superhote.com/api-v2 (consultée le 19/11/2026), la valeur doit être ≥ 0 à l'écriture.", nullable: true,
    caveats: ["`fetchPublishedPriceCents` appartient à une interface de vérification NON BRANCHÉE (superhote-check.ts) : seul `ShNight.priceCents` est lu aujourd'hui.", "La documentation relie la devise au logement (`Rental.currency`), pas au prix.", "Une comparaison avec le prix recommandé `price` de PriceLabs (écart ≤ 1 €) indique si ce prix est avant ou après majoration de canal ; relevé réel : identique, donc avant majoration."],
    toVerify: "Taxe, TVA, ménage : non précisés par SuperHote. Comparer à ce qu'affiche chaque canal pour la même nuit.",
  }),
  // ───────────── Prix et calendrier (PriceLabs) ─────────────
  f({
    id: "price.engine", label: "Prix retenu par le moteur (nuit)", names: ["priceCents", "price_cents"], group: "PRICE",  // rattache aussi ShNight.priceCents, voir superhote.calendar_price
    location: "calendar_days.price_cents · type Day · CalendarPatch.priceCents (`ShNight.priceCents` est le prix de calendrier SuperHote : voir superhote.calendar_price)", sources: ["PRICELABS", "SUPERHOTE", "DEMO"], derivation: "DERIVED",
    definition: "Prix par nuit utilisé par les calculs, AVANT majoration de canal. SuperHote fait foi : prix de calendrier SuperHote quand il est rattaché et lisible ; sinon `price` (prix recommandé) PriceLabs si la nuit est libre. `user_price` n'est jamais retenu (relevé réel : 127 € contre 77 € affichés par SuperHote). Le prix vendu d'un canal = ce prix × (1 + majoration du canal), puis remises, commission, coûts. Entre deux lectures, le calendrier est complété par `priceCents ?? recommendedPriceCents` quand SuperHote libère une nuit. Démo : posé égal au prix envoyé.",
    taxes: { cityTax: UNK, vat: UNK }, fees: { cleaning: UNK, commission: INC, paymentFee: INC }, currency: "EUR", sign: "NON_NEGATIVE", signNote: "−1 chez PriceLabs = indisponible → null.", nullable: true,
    caveats: ["Une nuit réservée peut garder un prix conservé lors d'un recalage SuperHote.", "Prix catalogue : jamais net de commission, jamais après majoration de canal SuperHote."], toVerify: PRICE_TO_VERIFY,
  }),
  f({
    id: "price.recommended", label: "Prix recommandé PriceLabs (`price`)", names: ["recommendedPriceCents", "recommended_price_cents", "recommendedCents"], group: "PRICE",
    location: "calendar_days.recommended_price_cents", sources: ["PRICELABS"], derivation: "OBSERVED",
    definition: "Prix recommandé par PriceLabs pour la nuit. Base du prix publié estimé.",
    taxes: { cityTax: UNK, vat: UNK }, fees: { cleaning: UNK, commission: INC, paymentFee: INC }, currency: "EUR", sign: "NON_NEGATIVE", nullable: true,
    caveats: ["Peut différer de `user_price` (écarts relevés le 19/11/2026 via le connecteur PriceLabs sur une même nuit) : ne jamais les confondre."], toVerify: PRICE_TO_VERIFY,
  }),
  f({
    id: "price.sent", label: "Prix envoyé à SuperHote (`user_price`)", names: ["sentPriceCents", "sent_price_cents", "sentCents"], group: "PRICE",
    location: "calendar_days.sent_price_cents", sources: ["PRICELABS"], derivation: "OBSERVED",
    definition: "Prix que PriceLabs pousse vers SuperHote pour la nuit. Conservé pour comparer avec le prix de calendrier SuperHote.",
    taxes: { cityTax: UNK, vat: UNK }, fees: { cleaning: UNK, commission: INC, paymentFee: INC }, currency: "EUR", sign: "NON_NEGATIVE", signNote: "−1 = nuit réservée ou bloquée → null.", nullable: true, toVerify: PRICE_TO_VERIFY,
  }),
  f({
    id: "price.published_estimate", label: "Prix publié estimé (canal)", names: ["exactCents", "estimatedCents"], group: "PRICE",
    location: "PublishedEstimate.exactCents · comparePublishedPrice", sources: ["COMPUTED"], derivation: "ESTIMATED",
    unit: "CENTS_DECIMAL",
    definition: "prix recommandé × (1 + majoration du canal ÷ 100), valeur exacte en centimes décimaux conservée, arrondie à l'euro à l'affichage seulement. La majoration est saisie par le propriétaire, en pourcentage ; inconnue = pas d'estimation.",
    taxes: { cityTax: UNK, vat: UNK }, fees: { cleaning: UNK, commission: INC, paymentFee: INC }, currency: "EUR", sign: "NON_NEGATIVE", nullable: true,
    caveats: ["Estimation d'affichage : SuperHote ne communique pas ses majorations par canal."], toVerify: PRICE_TO_VERIFY,
  }),
  f({
    id: "price.shown_in_calendar", label: "Prix affiché dans le calendrier du logement", names: ["shownCents"], group: "PRICE",
    location: "page du logement (calendrier D+90)", sources: ["PRICELABS", "COMPUTED"], derivation: "DERIVED",
    definition: "Prix d'une nuit libre montré à l'écran : le prix publié estimé du canal choisi (arrondi à l'euro ; inconnu si la majoration l'est), ou, sans canal choisi, le prix du calendrier (SuperHote, avant majoration).",
    taxes: { cityTax: UNK, vat: UNK }, fees: { cleaning: UNK, commission: INC, paymentFee: INC }, currency: "EUR", sign: "NON_NEGATIVE", nullable: true, toVerify: PRICE_TO_VERIFY,
  }),
  f({
    id: "price.published_actual", label: "Prix publié constaté chez SuperHote", names: ["actualCents"], group: "PRICE",
    location: "comparePublishedPrice(estimé, constaté)", sources: ["SUPERHOTE"], derivation: "OBSERVED",
    definition: "Prix lu chez SuperHote, comparé au prix publié estimé. Chemin NON BRANCHÉ aujourd'hui (superhote-check.ts) ; la comparaison active est `comparePriceSeries` (prix de calendrier SuperHote contre `user_price`).",
    taxes: { cityTax: UNK, vat: UNK }, fees: { cleaning: UNK, commission: INC, paymentFee: INC }, currency: "EUR", sign: "NON_NEGATIVE", nullable: true, toVerify: PRICE_TO_VERIFY,
  }),
  f({
    id: "price.night_in_action", label: "Prix de nuit d'une action simulée", names: ["nightlyCents"], group: "PRICE",
    location: "RevenueAction.parameters.nightlyCents", sources: ["COMPUTED"], derivation: "DERIVED",
    definition: "Prix par nuit porté par une action. Appliqué sur la nuit comme prix retenu seulement pour le rétablissement d'un plancher et l'exclusion de règle ; pour un changement en pourcentage, il est informatif et l'exécution applique le pourcentage, arrondi à l'euro.",
    taxes: { cityTax: UNK, vat: UNK }, fees: { cleaning: UNK, commission: INC, paymentFee: INC }, currency: "EUR", sign: "NON_NEGATIVE", nullable: false, toVerify: PRICE_TO_VERIFY,
  }),
  // ───────────── Réglages du logement ─────────────
  f({
    id: "strategy.base_price", label: "Prix de base", names: ["basePriceCents", "baseCents", "previousBasePriceCents"], group: "STRATEGY",
    location: "properties.strategy.basePriceCents · PlListing.baseCents (`parameters.basePriceCents` d'une action est une valeur PROPOSÉE, calculée, voir sim.expected_delta)", sources: ["PRICELABS"], derivation: "OBSERVED",
    definition: "Base Price PriceLabs du logement. `previousBasePriceCents` conserve l'ancienne valeur pour le retour arrière.",
    taxes: { cityTax: UNK, vat: UNK }, fees: { cleaning: UNK, commission: INC, paymentFee: INC }, currency: "EUR", sign: "NON_NEGATIVE", nullable: true,
    caveats: ["PriceLabs renvoie un prix calculé quand aucun n'est fixé explicitement (changelog https://developers.pricelabs.co/customer-api/changelog/changelog/2024/7/9)."], toVerify: PRICE_TO_VERIFY,
  }),
  f({
    id: "strategy.min_price", label: "Prix minimum", names: ["minPriceCents", "minCents", "previousMinPriceCents", "proposedMinCents"], group: "STRATEGY",
    location: "properties.strategy.minPriceCents · PlListing.minCents · paramètres de l'option PB-13 (previousMinPriceCents, proposedMinCents)", sources: ["PRICELABS", "COMPUTED"], derivation: "OBSERVED",
    definition: "Min Price PriceLabs : prix catalogue plancher, avant majoration de canal et avant commission. Ne dit rien du net : le plancher économique est un autre montant. PB-13 compare ce minimum × (1 + majoration du canal) au plancher absolu et propose, si besoin, le plus petit minimum entier qui le respecte (previousMinPriceCents = minimum actuel, proposedMinCents = minimum proposé).",
    taxes: { cityTax: UNK, vat: UNK }, fees: { cleaning: UNK, commission: INC, paymentFee: INC }, currency: "EUR", sign: "NON_NEGATIVE", nullable: true, toVerify: PRICE_TO_VERIFY,
  }),
  f({
    id: "strategy.max_price", label: "Prix maximum", names: ["maxPriceCents", "maxCents"], group: "STRATEGY",
    location: "properties.strategy.maxPriceCents · PlListing.maxCents", sources: ["PRICELABS"], derivation: "OBSERVED",
    definition: "Max Price PriceLabs : prix catalogue plafond, avant commission.",
    taxes: { cityTax: UNK, vat: UNK }, fees: { cleaning: UNK, commission: INC, paymentFee: INC }, currency: "EUR", sign: "NON_NEGATIVE", nullable: true, toVerify: PRICE_TO_VERIFY,
  }),
  // ───────────── Marché ─────────────
  f({
    id: "market.adr", label: "Prix moyen du marché", names: ["marketAdrCents", "market_adr_cents"], group: "MARKET",
    location: "market_days.market_adr_cents · type Day", sources: ["PRICELABS"], derivation: "OBSERVED",
    definition: "Prix médian réservé du voisinage PriceLabs (`Median Booked Price`), sinon 50e centile des prix affichés.",
    taxes: { cityTax: UNK, vat: UNK }, fees: { cleaning: UNK, commission: INC, paymentFee: INC }, currency: "EUR", sign: "NON_NEGATIVE", nullable: true,
    caveats: ["Mélange possible de prix réservés et de prix affichés selon les séries disponibles."], toVerify: "Taxes, TVA et ménage non précisés par PriceLabs pour les données de voisinage.",
  }),
  // ───────────── Modèle économique (saisi par le propriétaire) ─────────────
  f({
    id: "economics.cleaning_fee_charged", label: "Frais de ménage facturés (réglage)", names: ["cleaningFeeChargedCents"], group: "ECONOMICS",
    location: "properties.economics.cleaningFeeChargedCents", sources: ["OWNER_INPUT"], derivation: "DECLARED",
    definition: "Ménage que le propriétaire facture au voyageur par séjour.",
    taxes: declaredTax, fees: { cleaning: INC, commission: NA, paymentFee: NA }, currency: "EUR", sign: "NON_NEGATIVE", nullable: true, toVerify: VAT_DECLARED_TO_VERIFY,
    caveats: ["Le calcul du plancher en retire la commission : on suppose donc que la plateforme prélève sa commission sur le ménage, ce que rien ne confirme."],
  }),
  f({
    id: "economics.cleaning_cost", label: "Coût du ménage", names: ["cleaningCostCents"], group: "ECONOMICS",
    location: "properties.economics.cleaningCostCents", sources: ["OWNER_INPUT"], derivation: "DECLARED",
    definition: "Ce que coûte le ménage d'un séjour au propriétaire.", taxes: declaredTax, fees: noFee, currency: "EUR", sign: "NON_NEGATIVE", nullable: true, toVerify: VAT_DECLARED_TO_VERIFY,
  }),
  f({
    id: "economics.linen_cost", label: "Coût du linge", names: ["linenCostCents"], group: "ECONOMICS",
    location: "properties.economics.linenCostCents", sources: ["OWNER_INPUT"], derivation: "DECLARED",
    definition: "Coût du linge par séjour. 0 si le linge est compris dans le ménage.", taxes: declaredTax, fees: noFee, currency: "EUR", sign: "NON_NEGATIVE", nullable: true, toVerify: VAT_DECLARED_TO_VERIFY,
  }),
  f({
    id: "economics.nightly_variable_cost", label: "Coûts variables par nuit occupée", names: ["nightlyVariableCostCents"], group: "ECONOMICS",
    location: "properties.economics.nightlyVariableCostCents", sources: ["OWNER_INPUT"], derivation: "DECLARED",
    definition: "Énergie, eau et consommables rapportés à une nuit occupée.", taxes: declaredTax, fees: noFee, currency: "EUR", sign: "NON_NEGATIVE", nullable: true, toVerify: VAT_DECLARED_TO_VERIFY,
  }),
  f({
    id: "economics.hard_contribution", label: "Seuil de dérangement par nuit", names: ["hardContributionPerNightCents"], group: "ECONOMICS",
    location: "properties.economics.hardContributionPerNightCents", sources: ["OWNER_INPUT"], derivation: "DECLARED",
    definition: "Contribution minimale absolue par nuit : sous ce seuil, l'auditeur oppose un veto.", taxes: declaredTax, fees: noFee, currency: "EUR", sign: "NON_NEGATIVE", nullable: true, toVerify: VAT_DECLARED_TO_VERIFY,
  }),
  f({
    id: "economics.strategy_contribution", label: "Charges fixes à couvrir par nuit vendue", names: ["strategyContributionPerNightCents"], group: "ECONOMICS",
    location: "properties.economics.strategyContributionPerNightCents", sources: ["OWNER_INPUT", "COMPUTED"], derivation: "DERIVED",
    definition: "« Contribution de sécurité » par nuit : charges fixes mensuelles ÷ nuits vendues par mois, jamais en dessous du seuil de dérangement. Sert au plancher stratégique.",
    taxes: declaredTax, fees: noFee, currency: "EUR", sign: "NON_NEGATIVE", nullable: true, toVerify: VAT_DECLARED_TO_VERIFY,
  }),
  f({
    id: "economics.target_contribution", label: "Contribution visée par nuit vendue", names: ["targetContributionPerNightCents"], group: "ECONOMICS",
    location: "properties.economics.targetContributionPerNightCents", sources: ["OWNER_INPUT", "COMPUTED"], derivation: "DERIVED",
    definition: "(charges fixes + revenu mensuel visé) ÷ nuits vendues par mois, jamais en dessous du plancher stratégique.",
    taxes: declaredTax, fees: noFee, currency: "EUR", sign: "NON_NEGATIVE", nullable: true, toVerify: VAT_DECLARED_TO_VERIFY,
  }),
  f({
    id: "economics.answers", label: "Réponses brutes du parcours « Coûts et seuils »", names: ["CostAnswers"], group: "ECONOMICS",
    location: "properties.economics.answers (chaînes) · fixedMonthly() · variablePerNight()", sources: ["OWNER_INPUT"], derivation: "DECLARED", unit: "EUROS",
    definition: "Montants saisis en euros, sous forme de texte (loyer, copropriété, assurance, abonnements, taxes, autres charges, revenu mensuel visé, énergie et eau annuelles, consommables, taxe de séjour annuelle, brut annuel, coûts par nuit, seuil, ménage, linge). Convertis en centimes par `modelFromAnswers`, qui produit les montants `economics.*`.",
    taxes: declaredTax, fees: noFee, currency: "EUR", sign: "NON_NEGATIVE", nullable: true,
    caveats: ["Seul endroit où des montants sont en euros et non en centimes ; une valeur vide est inconnue (null), 0 n'est retenu que s'il est écrit."], toVerify: VAT_DECLARED_TO_VERIFY,
  }),
  f({
    id: "economics.tourist_tax_pct", label: "Part de taxe de séjour dans le total des réservations", names: ["touristTaxPct"], group: "ECONOMICS",
    location: "properties.economics.touristTaxPct (pourcentage, pas un montant)", sources: ["OWNER_INPUT"], derivation: "DECLARED",
    definition: "Pourcentage retiré du total des réservations PriceLabs pour obtenir l'hébergement brut. Sans objet pour SuperHote, qui fournit la taxe par réservation.",
    taxes: { cityTax: INC, vat: NA }, fees: noFee, currency: "EUR", sign: "NON_NEGATIVE", nullable: true,
    caveats: ["Appliqué seulement entre 0 et 50 % exclus."],
  }),
  f({
    id: "superhote.fee_line", label: "Ligne de retenue à l'hôte", names: ["ShFeeLine.cents"], group: "SUPERHOTE_RAW",
    location: "ShFeeLine.cents (non stocké)", sources: ["SUPERHOTE"], derivation: "OBSERVED",
    definition: "Montant d'une ligne de `host_fees` (frais de plateforme, TVA hôte), avec son taux de TVA propre (`vat_rate`).",
    taxes: { cityTax: NA, vat: UNK }, fees: noFee, currency: "EUR", sign: "SIGNED", signNote: "Signe non fixé par SuperHote : positif observé, négatif d'après la doc ; le code prend la valeur absolue pour le total.", nullable: false,
    toVerify: "Selon le type de ligne, le montant est ou non TTC : à lire avec `vat_rate` sur des réservations réelles.",
  }),
  f({
    id: "price.display_euros", label: "Prix publié estimé arrondi à l'euro", names: ["displayEuros"], group: "PRICE",
    location: "PublishedEstimate.displayEuros", sources: ["COMPUTED"], derivation: "ESTIMATED", unit: "EUROS",
    definition: "Valeur d'affichage de `price.published_estimate`, en euros entiers (et non en centimes) ; multipliée par 100 pour l'écran du logement.",
    taxes: { cityTax: UNK, vat: UNK }, fees: { cleaning: UNK, commission: INC, paymentFee: INC }, currency: "EUR", sign: "NON_NEGATIVE", nullable: false, toVerify: PRICE_TO_VERIFY,
  }),
  // ───────────── Planchers et simulation ─────────────
  f({
    id: "floor.unrecovered_stay_cost", label: "Coût de séjour non récupéré", names: ["unrecoveredStayCostCents"], group: "FLOOR_SIMULATION",
    location: "fonction unrecoveredStayCostCents", sources: ["COMPUTED"], derivation: "DERIVED",
    definition: "Ménage + linge − frais de ménage facturés nets de commission et de frais de paiement.",
    taxes: declaredTax, fees: { cleaning: INC, commission: EXC, paymentFee: EXC }, currency: "EUR", sign: "SIGNED", signNote: "Négatif = le ménage dégage une marge.", nullable: false, toVerify: VAT_DECLARED_TO_VERIFY,
  }),
  f({
    id: "economics.fixed_monthly", label: "Charges fixes du mois (seuil de rentabilité)", names: ["fixedMonthlyCents", "fixedCents"], group: "ECONOMICS",
    location: "paramètre des fonctions de seuil de rentabilité (economics.ts), calculé depuis les réponses du parcours « Charges fixes » (properties.economics.answers, en euros)", sources: ["OWNER_INPUT", "COMPUTED"], derivation: "DERIVED",
    definition: "Somme des charges mensuelles saisies : loyer ou mensualité de crédit (comptée seulement si le propriétaire ne l'a pas décochée), copropriété, assurance, abonnements, taxes, autres. Sert uniquement au seuil de rentabilité du mois, jamais à baisser un prix.",
    taxes: declaredTax, fees: noFee, currency: "EUR", sign: "NON_NEGATIVE", nullable: true, toVerify: VAT_DECLARED_TO_VERIFY,
  }),
  f({
    id: "floor.gross_nightly", label: "Plancher brut par nuit (dur, stratégique)", names: ["floorGrossNightlyCents", "hardFloorCents", "strategyFloorCents", "hardCents", "strategyCents"], group: "FLOOR_SIMULATION",
    location: "fonctions de economics.ts · floorGrid", sources: ["COMPUTED"], derivation: "DERIVED",
    definition: "Prix de vente minimal par nuit (hébergement, avant commission) pour atteindre la contribution visée sur un séjour de n nuits, formule du blueprint §8.3. Arrondi à l'unité supérieure.",
    taxes: { cityTax: EXC, vat: UNK }, fees: { cleaning: EXC, commission: INC, paymentFee: INC }, currency: "EUR", sign: "NON_NEGATIVE", nullable: false,
    caveats: ["Comparable à un prix d'hébergement brut, pas au prix catalogue PriceLabs tant que ses inclusions restent inconnues."], toVerify: VAT_DECLARED_TO_VERIFY,
  }),
  f({
    id: "floor.break_even", label: "Prix minimal du seuil de rentabilité (prix brut par nuit)", names: ["breakEvenPriceCents", "grossNightlyCents"], group: "FLOOR_SIMULATION",
    location: "fonctions breakEvenPriceCents · breakEvenNights · contributionPerNightCents (economics.ts)", sources: ["COMPUTED"], derivation: "DERIVED",
    definition: "Prix brut par nuit (hébergement, avant commission) qui, multiplié par le nombre de nuits vendues dans le mois, couvre les charges fixes du mois. Entrée du calcul inverse : prix brut saisi pour obtenir le nombre de nuits à vendre. Objectif de pilotage mensuel, pas un plancher.",
    taxes: { cityTax: EXC, vat: UNK }, fees: { cleaning: EXC, commission: INC, paymentFee: INC }, currency: "EUR", sign: "NON_NEGATIVE", nullable: false,
    caveats: ["Comparable à un prix d'hébergement brut, pas au prix catalogue PriceLabs tant que ses inclusions restent inconnues."], toVerify: VAT_DECLARED_TO_VERIFY,
  }),
  f({
    id: "sim.sold_nightly", label: "Prix vendu par nuit (simulation)", names: ["soldNightlyCents", "publishedNightlyCents", "soldAtMinCents"], group: "FLOOR_SIMULATION",
    location: "StackResult.soldNightlyCents · StackInput.publishedNightlyCents", sources: ["PRICELABS", "COMPUTED"], derivation: "DERIVED",
    definition: "Prix publié par nuit en entrée de la cascade ; prix vendu par nuit après remises en sortie, avant commission.",
    taxes: { cityTax: UNK, vat: UNK }, fees: { cleaning: UNK, commission: INC, paymentFee: INC }, currency: "EUR", sign: "NON_NEGATIVE", nullable: false, toVerify: PRICE_TO_VERIFY,
  }),
  f({
    id: "sim.net_room", label: "Revenu net d'hébergement (simulation)", names: ["netRoomCents"], group: "FLOOR_SIMULATION",
    location: "StackResult.netRoomCents · StackResult.grossRoomCents (hébergement vendu après remises, sans lien avec une réservation)", sources: ["COMPUTED"], derivation: "DERIVED",
    definition: "Hébergement vendu − commission − frais de paiement, avant coûts. Ordre canonique : prix publié → durée → promotions → commission → paiement → coûts.",
    taxes: { cityTax: EXC, vat: UNK }, fees: { cleaning: EXC, commission: EXC, paymentFee: EXC }, currency: "EUR", sign: "NON_NEGATIVE", nullable: false,
    toVerify: "Hérite de la TVA du prix publié en entrée de la cascade (voir `price.engine`).",
  }),
  f({
    id: "sim.contribution", label: "Contribution (simulation)", names: ["contributionCents", "contributionPerNightCents"], group: "FLOOR_SIMULATION",
    location: "StackResult.contributionCents · contributionPerNightCents", sources: ["COMPUTED"], derivation: "DERIVED",
    definition: "Revenu net d'hébergement − coût de séjour non récupéré − coûts variables, par séjour et par nuit.",
    taxes: { cityTax: EXC, vat: UNK }, fees: { cleaning: INC, commission: EXC, paymentFee: EXC }, currency: "EUR", sign: "SIGNED", signNote: "Négatif = séjour déficitaire.", nullable: false, toVerify: VAT_DECLARED_TO_VERIFY,
  }),
  f({
    id: "sim.waterfall_step", label: "Étape de la cascade de prix", names: ["WaterfallStep.cents"], group: "FLOOR_SIMULATION",
    location: "type WaterfallStep.cents", sources: ["COMPUTED"], derivation: "DERIVED",
    definition: "Montant d'une ligne de la cascade : le prix de départ et les sous-totaux sont positifs, les remises, commissions et coûts sont négatifs.",
    taxes: { cityTax: UNK, vat: UNK }, fees: { cleaning: UNK, commission: UNK, paymentFee: UNK }, currency: "EUR", sign: "SIGNED", signNote: "Seul endroit où commission et coûts sont portés en négatif ; en base ils sont positifs.", nullable: false,
    caveats: ["Les inclusions varient d'une ligne à l'autre ; chacune se lit dans son libellé et sa source."], toVerify: "Fixer une inclusion par clé d'étape (`published`, `promo`, `gross`, `commission`, `fee`, `net`, `stay`, `variable`, `contribution`) si ce montant doit être consommé automatiquement.",
  }),
  f({
    id: "sim.expected_delta", label: "Écart de contribution attendu / impact net", names: ["expectedDeltaCents", "impactCents", "impact_cents"], group: "FLOOR_SIMULATION",
    location: "Candidate.expectedDeltaCents · opportunities.impact_cents", sources: ["COMPUTED"], derivation: "ESTIMATED",
    definition: "Variation de contribution simulée d'une option, hypothèse comprise. Une simulation, pas une prévision.",
    taxes: { cityTax: EXC, vat: UNK }, fees: { cleaning: INC, commission: EXC, paymentFee: EXC }, currency: "EUR", sign: "SIGNED", signNote: "Positif = gain, négatif = perte.", nullable: true, caveats: ["null = non chiffrable ; 0 est écrit pour NO_ACTION (review.ts)."], toVerify: VAT_DECLARED_TO_VERIFY,
  }),
  f({
    id: "sim.incremental", label: "Effet incrémental mesuré", names: ["incrementalCents"], group: "FLOOR_SIMULATION",
    location: "RevenueAction.measurement.incrementalCents", sources: ["COMPUTED"], derivation: "NOT_COMPUTED",
    definition: "Gain ou perte attribué à une action après sa fenêtre d'observation. JAMAIS CALCULÉ aujourd'hui : toujours null (decisions.ts, seed.ts), faute de période témoin comparable.",
    taxes: { cityTax: EXC, vat: UNK }, fees: { cleaning: INC, commission: EXC, paymentFee: EXC }, currency: "EUR", sign: "SIGNED", nullable: true, toVerify: VAT_DECLARED_TO_VERIFY,
  }),
  // ───────────── Indicateurs ─────────────
  f({
    id: "kpi.gross", label: "Revenu brut d'hébergement (période)", names: ["grossCents"], group: "KPI",
    location: "MonthKpi.grossCents · Kpi.grossRoomCents (metrics/kpi.ts)", sources: ["COMPUTED"], derivation: "DERIVED",
    definition: "Somme des hébergements bruts répartis par nuit (centimes entiers, somme exacte) sur la période de séjour.",
    taxes: { cityTax: EXC, vat: UNK }, fees: { cleaning: EXC, commission: INC, paymentFee: INC }, currency: "EUR", sign: "NON_NEGATIVE", nullable: false,
    caveats: ["Hérite des réserves de `reservation.gross_room`, notamment le chemin de repli PriceLabs."], toVerify: "Hérite de la TVA de `reservation.gross_room`.",
  }),
  f({
    id: "kpi.adr", label: "ADR (prix moyen par nuit occupée)", names: ["adrCents"], group: "KPI",
    location: "MonthKpi.adrCents · Kpi.adrCents (metrics/kpi.ts)", sources: ["COMPUTED"], derivation: "DERIVED",
    definition: "Brut ÷ nuits vendues de la période.",
    taxes: { cityTax: EXC, vat: UNK }, fees: { cleaning: EXC, commission: INC, paymentFee: INC }, currency: "EUR", sign: "NON_NEGATIVE", nullable: true,
    caveats: ["null = aucune nuit occupée."], toVerify: "Hérite de la TVA de `reservation.gross_room`.",
  }),
  f({
    id: "kpi.gross_revpan", label: "RevPAN brut (revenu brut par nuit disponible)", names: ["grossRevpanCents"], group: "KPI",
    location: "Kpi.grossRevpanCents (metrics/kpi.ts)", sources: ["COMPUTED"], derivation: "DERIVED",
    definition: "Brut ÷ nuits disponibles (nuits de la période moins les nuits bloquées par le propriétaire).",
    taxes: { cityTax: EXC, vat: UNK }, fees: { cleaning: EXC, commission: INC, paymentFee: INC }, currency: "EUR", sign: "NON_NEGATIVE", nullable: true,
    caveats: ["null = aucune nuit disponible sur la période."], toVerify: "Hérite de la TVA de `reservation.gross_room`.",
  }),
  f({
    id: "kpi.net", label: "Revenu net d'hébergement (période)", names: ["netCents"], group: "KPI",
    location: "MonthKpi.netCents · Kpi.netRoomCents (metrics/kpi.ts)", sources: ["COMPUTED"], derivation: "DERIVED",
    definition: "Brut − commissions − frais de paiement, par nuit de séjour, sur les nuits dont la commission est connue.",
    taxes: { cityTax: EXC, vat: UNK }, fees: { cleaning: EXC, commission: EXC, paymentFee: EXC }, currency: "EUR", sign: "SIGNED", signNote: "Négatif si les retenues dépassent le brut (brut plancher à 0).", nullable: true,
    caveats: ["Une commission inconnue n'est jamais comptée pour 0 (US-050) : la nuit sort du net, `netIncomplete` (mensuel) ou `netStatus` PARTIAL/UNKNOWN (KPI canonique) le signale. `Kpi.netRoomCents` vaut null si aucune commission n'est connue.", "Un frais de paiement absent compte pour 0, sans signal : seule la commission décide si le net est connu (Airbnb n'a pas de frais de paiement)."],
    toVerify: "Hérite de la TVA de `reservation.gross_room`.",
  }),
  f({
    id: "kpi.net_adr", label: "Net ADR et Net RevPAN", names: ["netAdrCents", "netRevpanCents"], group: "KPI",
    location: "MonthKpi.netAdrCents · netRevpanCents · Kpi.netAdrCents · netRevpanCents (metrics/kpi.ts)", sources: ["COMPUTED"], derivation: "DERIVED",
    definition: "Net ADR = net ÷ nuits vendues dont la commission est connue (null sans nuit connue) ; Net RevPAN = net ÷ nuits disponibles.",
    caveats: ["`Kpi.netRevpanCents` est null tant que le net n'est pas connu pour TOUTES les nuits vendues (statut COMPLETE) : un Net RevPAN partiel serait sous-évalué. La vue mensuelle `MonthKpi.netRevpanCents` reste un nombre (net connu ÷ disponibles) et doit se lire avec `netIncomplete`."],
    taxes: { cityTax: EXC, vat: UNK }, fees: { cleaning: EXC, commission: EXC, paymentFee: EXC }, currency: "EUR", sign: "SIGNED", nullable: true,
    toVerify: "Hérite de la TVA de `reservation.gross_room`.",
  }),
  f({
    id: "kpi.net_by_channel", label: "Net par canal (période)", names: ["MonthKpi.byChannel"], group: "KPI",
    location: "MonthKpi.byChannel", sources: ["COMPUTED"], derivation: "DERIVED",
    definition: "Net cumulé par canal sur le mois, en centimes non arrondis.", unit: "CENTS_DECIMAL",
    taxes: { cityTax: EXC, vat: UNK }, fees: { cleaning: EXC, commission: EXC, paymentFee: EXC }, currency: "EUR", sign: "SIGNED", nullable: false,
    toVerify: "Hérite de la TVA de `reservation.gross_room`.",
  }),
  f({
    id: "kpi.avg_free_price", label: "Prix moyen des nuits libres (fenêtre)", names: ["avgFreePriceCents"], group: "KPI",
    location: "WindowStat.avgFreePriceCents", sources: ["COMPUTED"], derivation: "DERIVED",
    definition: "Moyenne du prix retenu sur les nuits libres d'une fenêtre canonique (J+0–7, 8–14, 15–30, 31–60, 61–90).",
    taxes: { cityTax: UNK, vat: UNK }, fees: { cleaning: UNK, commission: INC, paymentFee: INC }, currency: "EUR", sign: "NON_NEGATIVE", nullable: true, toVerify: PRICE_TO_VERIFY,
  }),
  // ───────────── Contrôles d'écart ─────────────
  f({
    id: "check.compared_amount", label: "Montant comparé entre sources", names: ["shCents", "plCents"], group: "CHECK",
    location: "ReservationGap · PriceCheckSummary.samples", sources: ["SUPERHOTE", "PRICELABS"], derivation: "OBSERVED",
    definition: "Total de réservation (`total_price` SuperHote contre `total_cost` PriceLabs) ou prix de nuit (calendrier SuperHote), selon le contrôle. Rapprochés, jamais corrigés.",
    taxes: { cityTax: UNK, vat: UNK }, fees: { cleaning: UNK, commission: INC, paymentFee: INC }, currency: "EUR", sign: "NON_NEGATIVE", nullable: true,
    caveats: ["Les deux côtés doivent avoir la même composition pour que l'écart ait un sens ; PriceLabs arrondit à l'euro."],
    toVerify: "Confirmer que `total_cost` PriceLabs a la même composition que `total_price` SuperHote (taxe, ménage) sur des réservations réelles.",
  }),
  f({
    id: "check.reconciliation_net", label: "Net d'hébergement d'une réservation : application et relevé de la source", names: ["appNetCents", "sourceNetCents", "sourceNetRoomCents", "signedGapCents"], group: "CHECK",
    location: "metrics/reconcile.ts · SampleRow.sourceNetRoomCents · RowGap (US-054)", sources: ["COMPUTED", "SUPERHOTE"], derivation: "DERIVED",
    definition: "Côté application : hébergement − commission − frais de paiement d'une réservation (null si la commission est inconnue). Côté source : net indiqué par le relevé du canal ou par SuperHote (null s'il est absent). Les deux sont comparés à ±1 % ; `signedGapCents` = application − source (positif si l'application dépasse le relevé).",
    taxes: { cityTax: EXC, vat: UNK }, fees: { cleaning: EXC, commission: EXC, paymentFee: EXC }, currency: "EUR", sign: "SIGNED", signNote: "Un net négatif est possible si les retenues dépassent l'hébergement.", nullable: true,
    caveats: ["Une valeur absente n'est jamais un zéro : la ligne est « inconnue » et l'échantillon ne peut pas être attesté.", "Le net du relevé doit avoir la même composition que celui de l'application (hors ménage et taxes)."],
    toVerify: "Confirmer, sur le premier échantillon réel, que le net du relevé Airbnb et celui de Booking.com excluent le ménage et la taxe de séjour comme l'application.",
  }),
  f({
    id: "check.gap", label: "Écart entre deux montants", names: ["gapCents", "maxGapCents", "medianGapCents"], group: "CHECK",
    location: "PriceCheck.gapCents · PriceCheckSummary", sources: ["COMPUTED"], derivation: "DERIVED",
    definition: "Différence (constaté − estimé, ou SuperHote − envoyé) entre deux prix de nuit ; maximum et médiane sur une série.",
    taxes: noTax, fees: noFee, currency: "EUR", sign: "SIGNED", signNote: "Positif = le montant de gauche dépasse celui de droite.", nullable: true,
    caveats: ["`maxGapCents` est une valeur absolue ; `medianGapCents` est la médiane haute (élément n/2 du tri)."],
  }),
  f({
    id: "check.tolerance", label: "Tolérance de comparaison", names: ["toleranceCents"], group: "CHECK",
    location: "paramètre des fonctions de comparaison (100 par défaut)", sources: ["COMPUTED"], derivation: "DERIVED",
    definition: "Écart toléré avant de signaler une différence : 1 € par défaut, car PriceLabs arrondit à l'euro.",
    taxes: noTax, fees: noFee, currency: "EUR", sign: "NON_NEGATIVE", nullable: false,
  }),
];

/** Un champ est « à confirmer » dès qu'une de ses dimensions est inconnue. */
export const isToConfirm = (m: MoneyField): boolean => Object.values(m.taxes).includes("UNKNOWN") || Object.values(m.fees).includes("UNKNOWN");

export const GROUP_LABEL: Record<MoneyGroup, string> = {
  RESERVATION: "Réservations stockées", SUPERHOTE_RAW: "Montants bruts SuperHote (lecture)", PRICE: "Prix et calendrier", STRATEGY: "Réglages de prix du logement",
  MARKET: "Marché", ECONOMICS: "Modèle économique (saisi par le propriétaire)", FLOOR_SIMULATION: "Planchers et simulation", KPI: "Indicateurs", CHECK: "Contrôles d'écart",
};
