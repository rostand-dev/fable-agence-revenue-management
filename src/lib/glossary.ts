/**
 * Glossaire du revenue management, écrit pour un propriétaire qui n'est pas du métier.
 * Une seule source : la page /glossaire et les infobulles « Term » en dépendent.
 * Les exemples sont illustratifs : leurs chiffres sont inventés pour se calculer de tête.
 */
export type GlossaryCategory = "perf" | "prix" | "marche" | "sejours" | "canaux" | "garde" | "agence";

export type GlossaryEntry = {
  id: string;
  term: string;
  /** Autres façons de le dire : sigle, anglicisme, libellé affiché dans l'application. */
  aka?: string[];
  category: GlossaryCategory;
  /** Explication en une ou deux phrases, sans jargon. */
  plain: string;
  /** Exemple concret chiffré. */
  example?: string;
  /** Où le retrouver dans l'application. */
  seeIn?: { label: string; href: string };
  related?: string[];
};

export const CATEGORIES: { id: GlossaryCategory; label: string; intro: string }[] = [
  { id: "perf", label: "Mesurer ses résultats", intro: "Les indicateurs qui disent si le logement travaille bien." },
  { id: "prix", label: "Les prix", intro: "Du prix recommandé au prix que paie réellement le voyageur." },
  { id: "marche", label: "Marché et demande", intro: "Se comparer aux autres logements et lire le rythme des réservations." },
  { id: "sejours", label: "Séjours et calendrier", intro: "Durées, restrictions et nuits qui restent sur le carreau." },
  { id: "canaux", label: "Canaux et coûts", intro: "Qui prend quoi entre le prix payé par le voyageur et ce qui vous reste." },
  { id: "garde", label: "Seuils et garde-fous", intro: "Les limites en dessous desquelles l'agence ne descendra jamais." },
  { id: "agence", label: "Fonctionnement de l'agence", intro: "Les mots propres à NuitSignal et à la façon dont l'équipe décide." },
];

export const GLOSSARY: GlossaryEntry[] = [
  // ───────────── Mesurer ses résultats
  {
    id: "occupation", term: "Taux d'occupation", aka: ["Occupation"], category: "perf",
    plain: "La part des nuits ouvertes à la vente qui ont été réellement vendues. Les nuits que vous avez bloquées ne comptent pas.",
    example: "En mars, votre T3 a 31 nuits, dont 3 bloquées pour un séjour perso : 28 sont à vendre. Si 21 sont réservées, l'occupation est de 21 ÷ 28 = 75 %.",
    related: ["nuits-disponibles", "nuit-bloquee", "revpar"],
  },
  {
    id: "nuits-disponibles", term: "Nuits disponibles", category: "perf",
    plain: "Les nuits ouvertes à la réservation, qu'elles soient vendues ou encore libres. C'est le dénominateur de l'occupation et du revenu par nuit disponible.",
    example: "Un mois de 30 jours avec 2 nuits bloquées pour des travaux : 28 nuits disponibles.",
    related: ["occupation", "nuit-libre", "nuit-bloquee"],
  },
  {
    id: "adr", term: "ADR", aka: ["Prix moyen par nuit occupée", "Prix moyen net"], category: "perf",
    plain: "Average Daily Rate : ce que rapporte en moyenne une nuit vendue. On le calcule en divisant le revenu d'hébergement par le nombre de nuits vendues. Dans l'application, le « Prix moyen net » est calculé après commissions.",
    example: "21 nuits vendues ont rapporté 2 100 € : l'ADR est de 100 € par nuit. Il ne dit rien du nombre de nuits vendues : il se lit avec l'occupation.",
    seeIn: { label: "Bilan mensuel", href: "/bilan" },
    related: ["occupation", "revpar", "revenu-net"],
  },
  {
    id: "revpar", term: "RevPAR / RevPAN", aka: ["Revenu net par nuit disponible"], category: "perf",
    plain: "Le revenu moyen par nuit disponible, vendue ou non. C'est l'indicateur le plus honnête, parce qu'il combine le prix et le remplissage. RevPAR vient de l'hôtellerie (par chambre) ; « RevPAN » est le même calcul par nuit disponible.",
    example: "Logement A : 120 € la nuit, occupé 55 % du temps, soit 66 € par nuit disponible. Logement B : 90 € la nuit, occupé 80 %, soit 72 €. B gagne davantage alors qu'il est moins cher.",
    seeIn: { label: "Bilan mensuel", href: "/bilan" },
    related: ["adr", "occupation", "revenu-net"],
  },
  {
    id: "revenu-net", term: "Revenu net", category: "perf",
    plain: "Ce qui reste du montant des réservations une fois retirées la taxe de séjour, les commissions des plateformes et les frais de paiement. Ce n'est pas encore votre bénéfice : le ménage et les charges restent à payer.",
    example: "Une réservation de 500 € avec 16 % de commission et de frais de paiement laisse 500 − 80 = 420 € de revenu net.",
    related: ["commission", "taxe-sejour", "contribution"],
  },
  {
    id: "contribution", term: "Contribution", aka: ["Marge de contribution"], category: "perf",
    plain: "Ce qu'une nuit vendue (ou un séjour) laisse après tous les coûts qui lui sont propres : commission, ménage, linge, consommables. Cette somme sert à payer vos charges fixes, puis devient votre gain.",
    example: "Une nuit vendue 100 €, 16 € de commission et frais, 8 € de consommables et d'énergie : 76 € de contribution. Le ménage, payé par séjour, se répartit sur les nuits du séjour.",
    seeIn: { label: "Fiche d'un logement, onglet Économie", href: "/logements" },
    related: ["cascade", "charges-fixes", "plancher-absolu"],
  },
  {
    id: "tendance", term: "Tendance", aka: ["croissante", "stable", "décroissante"], category: "perf",
    plain: "Le sens dans lequel va un indicateur, résumé en un mot plutôt qu'en une liste d'écarts. Dans l'application : « croissante » au-delà de +3 %, « décroissante » en dessous de −3 %, « stable » entre les deux.",
    example: "Revenu net de 2 000 € puis 2 100 € (+5 %) : tendance croissante. 2 000 € puis 2 040 € (+2 %) : tendance stable, l'écart est trop petit pour être un signal.",
    related: ["revenu-net", "revpar"],
  },

  // ───────────── Les prix
  {
    id: "tarification-dynamique", term: "Tarification dynamique", aka: ["Dynamic pricing", "Yield management"], category: "prix",
    plain: "Faire varier le prix de chaque nuit selon la demande, plutôt que de garder un tarif unique toute l'année. C'est le principe des billets d'avion : le même siège ne coûte pas le même prix selon le jour.",
    example: "Un samedi de grand week-end à 130 €, un mardi calme de novembre à 78 €, pour le même appartement.",
    related: ["prix-de-base", "prix-recommande", "saisonnalite"],
  },
  {
    id: "prix-de-base", term: "Prix de base", category: "prix",
    plain: "Le prix de référence d'une nuit « ordinaire ». L'outil de tarification part de lui, puis monte ou descend selon la saison, le jour de la semaine et la demande. Le changer déplace tous les prix d'un coup : c'est une décision lourde.",
    example: "Avec un prix de base de 90 €, un week-end chargé peut afficher 130 € et un mardi creux 78 €.",
    related: ["prix-recommande", "prix-date", "tarification-dynamique"],
  },
  {
    id: "prix-recommande", term: "Prix recommandé", aka: ["Recommandation PriceLabs"], category: "prix",
    plain: "Le prix que PriceLabs calcule pour chaque nuit. C'est un prix « avant canal » : le voyageur ne le voit pas tel quel, car la majoration de chaque plateforme s'y ajoute.",
    example: "PriceLabs recommande 100 € pour le 12 décembre. Sur Airbnb, avec 15 % de majoration, le voyageur verra environ 115 €.",
    related: ["majoration", "prix-publie", "pricelabs"],
  },
  {
    id: "majoration", term: "Majoration", aka: ["Markup"], category: "prix",
    plain: "Le pourcentage que SuperHote ajoute au prix pour chaque plateforme, en général pour compenser la commission qu'elle prélève. Il diffère d'un canal à l'autre. SuperHote ne le communique pas : c'est vous qui le renseignez dans NuitSignal.",
    example: "Prix recommandé de 100 € et majoration de 15 % sur Airbnb : le prix publié est 100 × 1,15 = 115 €.",
    seeIn: { label: "Fiche d'un logement", href: "/logements" },
    related: ["prix-recommande", "prix-publie", "commission"],
  },
  {
    id: "prix-publie", term: "Prix publié", aka: ["Prix affiché"], category: "prix",
    plain: "Le prix que le voyageur voit réellement sur Airbnb ou Booking.com, majoration comprise et avant remises. NuitSignal l'estime tant que SuperHote ne le confirme pas : il est alors précédé d'un « ~ ».",
    example: "Recommandé 100 € × (1 + 15 %) = 115 € affichés sur Airbnb.",
    related: ["majoration", "prix-vendu", "bar"],
  },
  {
    id: "prix-vendu", term: "Prix vendu", category: "prix",
    plain: "Le prix réellement payé par nuit après toutes les remises, avant la commission de la plateforme. C'est à ce prix que se comparent les planchers.",
    example: "Prix publié 115 € avec une promotion de 10 % : le prix vendu est 103,50 € la nuit.",
    related: ["prix-publie", "remise", "plancher-absolu"],
  },
  {
    id: "bar", term: "BAR", aka: ["Best Available Rate", "Tarif public"], category: "prix",
    plain: "Le meilleur tarif public du moment, sans offre particulière. C'est la base à partir de laquelle on calcule les remises et les promotions.",
    example: "Le tarif public d'une nuit est 115 €. Une promotion « dernière minute » de 10 % le ramène à 103,50 € pour ceux qui y ont droit.",
    related: ["prix-publie", "remise"],
  },
  {
    id: "remise", term: "Remise", aka: ["Réduction", "Discount"], category: "prix",
    plain: "Une baisse de prix accordée dans un cas précis : long séjour, dernière minute, promotion de plateforme. Plusieurs remises ne s'additionnent pas, elles s'enchaînent : l'une s'applique sur le prix déjà réduit par l'autre.",
    example: "Deux remises de 10 % ne font pas 20 % mais 19 % : 100 € deviennent 90 €, puis 81 €.",
    related: ["promotion-canal", "sejour-long", "prix-vendu"],
  },
  {
    id: "regle-de-cumul", term: "Règle de cumul", aka: ["Cumul des promotions", "Stacking"], category: "canaux",
    plain: "Ce que décide une plateforme quand plusieurs promotions s'appliquent à la même nuit : elles se cumulent, ou une seule est retenue. Chaque canal a ses règles, et NuitSignal ne les devine pas : tant qu'une règle n'est pas établie par l'aide officielle du canal, l'option est soumise à votre validation.",
    example: "Sur Airbnb, une remise de dernière minute et une remise mensuelle ne se cumulent pas : une seule s'applique. Sur Booking.com, la règle entre un tarif Genius et un tarif mobile dépend d'un réglage du compte que l'application ne peut pas lire : elle reste inconnue.",
    seeIn: { label: "Méthode de travail", href: "/methode" },
    related: ["remise", "promotion-canal", "veto"],
  },
  {
    id: "promotion-canal", term: "Promotion de canal", category: "prix",
    plain: "Une offre proposée sur une plateforme précise (Airbnb ou Booking.com), le plus souvent un pourcentage de réduction sur une période. Elle se paramètre sur le site de la plateforme, d'où la procédure manuelle guidée de l'agence.",
    example: "Une promotion de 8 % sur Booking.com pour les séjours de janvier : un prix de 115 € passe à 105,80 € sur ce canal seulement.",
    related: ["remise", "procedure-manuelle", "canal"],
  },
  {
    id: "prix-date", term: "Prix daté", aka: ["Override", "Prix forcé"], category: "prix",
    plain: "Un prix fixé pour des dates précises, qui prend le dessus sur le prix calculé automatiquement. C'est le levier le plus ciblé : il ne touche que les nuits concernées.",
    example: "Un salon professionnel remplit la ville du 3 au 5 mars : on force 140 € ces trois nuits, et le reste du mois n'est pas modifié.",
    related: ["prix-de-base", "prix-recommande"],
  },
  {
    id: "position-de-prix", term: "Position de prix", aka: ["Percentile de prix"], category: "prix",
    plain: "Où se situe votre prix parmi ceux des logements comparables, sur une échelle de 0 à 100. Plus le chiffre est haut, plus vous êtes cher par rapport aux autres.",
    example: "70e centile : votre prix dépasse celui de 70 logements comparables sur 100. 30e centile : vous êtes moins cher que 70 d'entre eux.",
    seeIn: { label: "Fiche d'un logement, rythme de réservation", href: "/logements" },
    related: ["marche", "ecart-marche"],
  },

  // ───────────── Marché et demande
  {
    id: "marche", term: "Marché", aka: ["Compset", "Logements comparables"], category: "marche",
    plain: "L'ensemble des logements proches du vôtre par la localisation, la taille et le niveau de gamme. Compset veut dire « competitive set » : le groupe auquel on se compare.",
    example: "Pour le T3 de Châtillon, le marché regroupe des appartements de 2 à 3 chambres à quelques stations de métro. Un studio du centre de Paris n'en fait pas partie.",
    related: ["occupation-marche", "position-de-prix", "ecart-marche"],
  },
  {
    id: "occupation-marche", term: "Occupation du marché", category: "marche",
    plain: "Le taux d'occupation moyen des logements comparables sur les mêmes dates. Il sert de thermomètre : si tout le monde est plein, la demande est forte ; si tout le monde est vide, le problème ne vient pas que de vous.",
    example: "Pour la semaine du 8 mars, le marché est occupé à 70 % et votre logement à 40 % : vous êtes en retard sur la demande disponible.",
    related: ["marche", "ecart-marche"],
  },
  {
    id: "ecart-marche", term: "Écart au marché", aka: ["Gap", "Écart en points"], category: "marche",
    plain: "Votre occupation moins celle du marché, en points de pourcentage. Un écart négatif n'est pas un ordre de baisser le prix : il ouvre un diagnostic pour comprendre pourquoi.",
    example: "Vous : 40 %. Marché : 55 %. Écart : −15 points. La cause peut être le prix, un séjour minimum trop long, des photos faibles ou un simple décalage de calendrier.",
    seeIn: { label: "Fiche d'un logement, rythme de réservation", href: "/logements" },
    related: ["diagnostic-causal", "occupation-marche", "pacing"],
  },
  {
    id: "pacing", term: "Pacing", aka: ["Rythme de réservation"], category: "marche",
    plain: "La vitesse à laquelle les dates à venir se remplissent, comparée à ce qui est attendu. On cherche à savoir si une période se remplit à un rythme normal, en avance ou en retard.",
    example: "À 30 jours de l'arrivée, un mois est habituellement rempli à 45 %. S'il n'est qu'à 25 %, le pacing est en retard : on regarde pourquoi avant de toucher au prix.",
    related: ["delai-reservation", "fenetre-reservation", "pickup"],
  },
  {
    id: "pickup", term: "Pickup", category: "marche",
    plain: "Le nombre de nouvelles réservations reçues sur une période donnée, par exemple les 7 derniers jours. C'est la pulsation de la demande, jour après jour.",
    example: "5 nuits réservées cette semaine pour le mois prochain, contre 2 la semaine dernière : le pickup s'accélère.",
    related: ["pacing", "delai-reservation"],
  },
  {
    id: "delai-reservation", term: "Délai de réservation", aka: ["Lead time"], category: "marche",
    plain: "Le nombre de jours entre le moment où le voyageur réserve et son arrivée. On utilise la médiane (la valeur du milieu) pour ne pas se laisser tromper par quelques réservations très anticipées.",
    example: "Réservation faite le 1er mars pour une arrivée le 15 mars : délai de 14 jours. Un délai médian de 14 jours signifie que la moitié des voyageurs réservent à moins de deux semaines.",
    related: ["fenetre-reservation", "derniere-minute", "pacing"],
  },
  {
    id: "fenetre-reservation", term: "Fenêtre de réservation", aka: ["J+0 à J+7", "J+8 à J+14"], category: "marche",
    plain: "Une tranche du calendrier à venir, mesurée en jours à partir d'aujourd'hui. « J » est aujourd'hui, « J+7 » est dans sept jours. L'équipe regarde cinq fenêtres, de la plus proche à la plus lointaine, car on n'agit pas de la même façon à 5 jours et à 80 jours.",
    example: "Le 16 novembre, la fenêtre J+0 à J+7 couvre les séjours qui commencent entre le 16 et le 23 novembre. Les fenêtres vont jusqu'à J+90.",
    seeIn: { label: "Fiche d'un logement, rythme de réservation", href: "/logements" },
    related: ["delai-reservation", "pacing", "derniere-minute"],
  },
  {
    id: "saisonnalite", term: "Saisonnalité", aka: ["Haute saison", "Basse saison"], category: "marche",
    plain: "Les variations régulières de la demande au fil de l'année, des semaines et des événements : vacances, week-ends, congrès, salons. Elle explique une grande part des écarts de prix.",
    example: "Pour un logement orienté professionnels, la demande est forte du mardi au jeudi et faible le week-end : l'inverse d'un logement de loisirs.",
    related: ["tarification-dynamique", "pacing"],
  },
  {
    id: "probabilite-de-vente", term: "Probabilité de vente", category: "marche",
    plain: "La chance estimée qu'une nuit se vende à un prix donné. Les simulations de l'agence s'appuient sur l'occupation du marché et la position de prix. C'est un modèle simple, pas une promesse.",
    example: "Pour une nuit à 100 €, l'agence estime 60 % de chances de vente ; à 120 €, 40 %. Elle compare ensuite ce que chaque prix rapporterait en moyenne.",
    related: ["position-de-prix", "occupation-marche", "hypothese"],
  },

  // ───────────── Séjours et calendrier
  {
    id: "los", term: "LOS", aka: ["Durée de séjour", "Length of stay"], category: "sejours",
    plain: "Le nombre de nuits d'une réservation. La durée médiane des séjours est un repère : elle dit si votre logement sert plutôt à des escapades ou à des séjours longs.",
    example: "Une arrivée le vendredi et un départ le lundi : LOS de 3 nuits. Une durée médiane de 4 nuits signifie que la moitié des séjours sont plus courts.",
    related: ["sejour-minimum", "sejour-long", "menage"],
  },
  {
    id: "sejour-minimum", term: "Séjour minimum", aka: ["Min stay", "Durée minimale"], category: "sejours",
    plain: "Le nombre de nuits minimum qu'un voyageur doit réserver. Il protège vos marges (moins de ménages), mais trop élevé, il écarte des réservations et laisse des trous.",
    example: "Séjour minimum de 3 nuits le week-end : une demande pour 2 nuits est refusée. Le réduire à 2 nuits pour combler un trou est une action courante de l'agence.",
    related: ["trou", "los", "menage"],
  },
  {
    id: "trou", term: "Trou", aka: ["Nuit orpheline", "Gap", "Orphan night"], category: "sejours",
    plain: "Une ou deux nuits libres coincées entre deux réservations, trop courtes pour respecter le séjour minimum. Personne ne peut les réserver, ce sont des nuits perdues.",
    example: "Un séjour se termine le 14 et le suivant commence le 16 : la nuit du 14 est un trou. Avec un séjour minimum de 3 nuits, elle ne se vendra jamais ; ramener le minimum à 1 nuit lui rend une chance.",
    related: ["sejour-minimum", "nuit-libre"],
  },
  {
    id: "nuit-libre", term: "Nuit libre", category: "sejours",
    plain: "Une nuit ouverte à la vente qui n'est pas (encore) réservée. Ne pas confondre avec une nuit bloquée.",
    example: "Sur 28 nuits disponibles dont 21 vendues, 7 nuits sont libres.",
    related: ["nuits-disponibles", "nuit-bloquee"],
  },
  {
    id: "nuit-bloquee", term: "Nuit bloquée", category: "sejours",
    plain: "Une nuit fermée à la vente : séjour personnel, travaux, indisponibilité. Elle n'est pas comptée dans les nuits disponibles, donc elle ne fait pas baisser votre occupation.",
    example: "Vous gardez l'appartement pour la famille du 20 au 23 : ces 3 nuits sont bloquées et ne comptent ni dans l'occupation, ni dans le revenu par nuit disponible.",
    related: ["nuits-disponibles", "occupation"],
  },
  {
    id: "derniere-minute", term: "Dernière minute", aka: ["Last minute"], category: "sejours",
    plain: "Une réservation faite très peu de temps avant l'arrivée, de quelques jours à une semaine. Ces nuits non vendues perdent leur valeur à l'approche de la date : c'est pour cela que l'agence les surveille de près.",
    example: "Il reste le week-end prochain libre, dans 4 jours. Chaque jour qui passe réduit les chances de le vendre, ce qui justifie d'étudier une action rapide.",
    related: ["fenetre-reservation", "delai-reservation"],
  },
  {
    id: "sejour-long", term: "Séjour long", aka: ["Moyen séjour", "Remise long séjour"], category: "sejours",
    plain: "Une réservation d'une semaine ou plus, souvent d'un mois, pour un professionnel en mission par exemple. Moins de ménages et de rotations, mais un prix par nuit en général plus bas : une remise de long séjour est courante.",
    example: "28 nuits à 80 € (2 240 €) avec un seul ménage, plutôt que 4 séjours d'une semaine à 100 € (2 800 €) avec 4 ménages et des journées d'attente entre chaque. Le plus rentable dépend de vos coûts.",
    related: ["remise", "los", "menage"],
  },

  // ───────────── Canaux et coûts
  {
    id: "canal", term: "Canal", aka: ["Canal de distribution", "Plateforme"], category: "canaux",
    plain: "Le site ou la voie par laquelle arrive une réservation : Airbnb, Booking.com, réservation directe, saisie manuelle. Chaque canal a ses commissions, sa clientèle et sa majoration.",
    example: "Une réservation reçue par Airbnb est « canal Airbnb ». Un ami qui réserve par message : « direct », sans commission de plateforme.",
    related: ["commission", "majoration", "reservation-directe"],
  },
  {
    id: "commission", term: "Commission", category: "canaux",
    plain: "Le pourcentage prélevé par la plateforme sur chaque réservation, auquel s'ajoutent les frais de paiement. Elle diffère selon le canal et se renseigne dans le modèle économique du logement.",
    example: "Une réservation de 500 € avec 15 % de commission et 1 % de frais de paiement : la plateforme garde 80 €, il vous reste 420 €.",
    seeIn: { label: "Fiche d'un logement, onglet Économie", href: "/logements" },
    related: ["frais-paiement", "revenu-net", "majoration"],
  },
  {
    id: "frais-paiement", term: "Frais de paiement", category: "canaux",
    plain: "Le coût du traitement du paiement par carte du voyageur, prélevé en plus de la commission. Il est faible (autour de 1 à 3 %) mais compte dans le calcul du revenu net.",
    example: "Sur un paiement de 500 €, des frais de 1,5 % représentent 7,50 €.",
    related: ["commission", "revenu-net"],
  },
  {
    id: "menage", term: "Frais de ménage et coût du ménage", aka: ["Frais de ménage facturés", "Coût du ménage"], category: "canaux",
    plain: "Deux montants à ne pas confondre : les frais de ménage que le voyageur paie, et le coût réel du ménage que vous payez à la personne qui nettoie. L'écart entre les deux, avec le linge, est un coût de séjour que vos nuits doivent absorber.",
    example: "Le voyageur paie 60 € de frais de ménage, votre prestataire en facture 70 € et le linge coûte 12 €. Le séjour vous coûte 22 € de plus que ce qu'il rapporte au titre du ménage, avant commission.",
    related: ["couts-variables", "sejour-minimum", "contribution"],
  },
  {
    id: "couts-variables", term: "Coûts variables par nuit", category: "canaux",
    plain: "Ce que coûte chaque nuit occupée en plus : électricité, eau, chauffage, café, produits d'entretien, usure. Si le logement est vide, vous ne payez pas ces coûts.",
    example: "Environ 8 € par nuit en consommables et énergie : une nuit vendue 100 € ne rapporte plus que 92 € avant commission.",
    seeIn: { label: "Coûts et seuils d'un logement", href: "/logements" },
    related: ["contribution", "charges-fixes"],
  },
  {
    id: "taxe-sejour", term: "Taxe de séjour", category: "canaux",
    plain: "Une taxe de la commune payée par le voyageur et reversée par vous ou par la plateforme. Ce n'est pas votre revenu : NuitSignal la retire des montants quand elle est renseignée.",
    example: "Taxe de 3 € par nuit et par personne : pour 2 adultes sur 3 nuits, 18 € qui ne vous appartiennent pas.",
    related: ["revenu-net"],
  },
  {
    id: "reservation-directe", term: "Réservation directe", category: "canaux",
    plain: "Une réservation reçue sans passer par Airbnb ou Booking.com : bouche-à-oreille, site à vous, message direct. Pas de commission de plateforme, mais il faut gérer le paiement et la confiance soi-même.",
    example: "Un client habituel réserve 4 nuits à 100 € par téléphone : 400 € sans commission, contre environ 336 € nets via une plateforme à 16 %.",
    related: ["canal", "commission"],
  },
  {
    id: "superhote", term: "SuperHote", aka: ["Channel manager", "PMS"], category: "canaux",
    plain: "Votre logiciel de gestion : il reçoit les réservations de toutes les plateformes, évite les doubles réservations et publie les prix. Dans NuitSignal, c'est lui qui fait foi pour les réservations.",
    example: "Une réservation Airbnb arrive d'abord dans SuperHote, qui bloque aussitôt les mêmes dates sur Booking.com.",
    seeIn: { label: "Intégrations", href: "/integrations" },
    related: ["pricelabs", "synchronisation", "majoration"],
  },
  {
    id: "pricelabs", term: "PriceLabs", category: "canaux",
    plain: "L'outil qui calcule les prix recommandés nuit par nuit en observant le marché. Il fournit le moteur de prix ; l'agence décide quand et comment l'utiliser.",
    example: "PriceLabs observe que les logements voisins sont pleins le 12 décembre et recommande de monter le prix de cette nuit-là.",
    seeIn: { label: "Intégrations", href: "/integrations" },
    related: ["prix-recommande", "superhote", "synchronisation"],
  },
  {
    id: "synchronisation", term: "Synchronisation", aka: ["Synchro", "Écart de synchro"], category: "canaux",
    plain: "L'échange automatique de données entre deux outils. Quand deux outils ne racontent pas la même chose (par exemple une réservation que PriceLabs ne voit pas), on parle d'écart de synchro.",
    example: "SuperHote indique 18 réservations ce mois-ci, PriceLabs en voit 16 : deux écarts à vérifier. SuperHote fait foi.",
    seeIn: { label: "Intégrations", href: "/integrations" },
    related: ["superhote", "pricelabs"],
  },

  // ───────────── Seuils et garde-fous
  {
    id: "charges-fixes", term: "Charges fixes", category: "garde",
    plain: "Les dépenses que vous payez que le logement soit occupé ou non : crédit, charges de copropriété, assurance, internet, taxe foncière. Vos nuits vendues doivent les couvrir.",
    example: "900 € de charges fixes par mois, qu'il y ait 5 ou 25 nuits vendues.",
    related: ["plancher-strategique", "contribution"],
  },
  {
    id: "seuil-rentabilite", term: "Seuil de rentabilité", aka: ["Point mort", "Break-even"], category: "garde",
    plain: "Le nombre de nuits à vendre dans le mois, à un prix donné, pour couvrir toutes vos charges et ne pas perdre d'argent. Ou l'inverse : le prix minimum de la nuit si vous en vendez un nombre donné. C'est un objectif du mois, pas un prix plancher par nuit.",
    example: "900 € de charges fixes par mois, une nuit qui laisse 60 € après commission et ménage : il faut vendre 15 nuits pour atteindre l'équilibre. À 10 nuits seulement, il faudrait que chaque nuit laisse 90 €.",
    seeIn: { label: "Coûts et seuils d'un logement", href: "/logements" },
    related: ["charges-fixes", "plancher-strategique", "contribution"],
  },
  {
    id: "plancher-absolu", term: "Plancher absolu", aka: ["Seuil de dérangement", "Contribution minimale absolue"], category: "garde",
    plain: "Le prix minimal en dessous duquel vous ne voulez pas accueillir quelqu'un, car la nuit ne couvre même pas ses coûts et le dérangement. L'agence ne propose jamais d'action sous ce prix, et l'auditeur y oppose son veto.",
    example: "Si votre seuil est de 30 € de contribution par nuit, le plancher absolu est le prix vendu qui laisse 30 € après commission, ménage et coûts variables. En dessous, vous perdriez de l'argent à accueillir.",
    seeIn: { label: "Fiche d'un logement, onglet Économie", href: "/logements" },
    related: ["plancher-strategique", "veto", "contribution"],
  },
  {
    id: "plancher-strategique", term: "Plancher stratégique", aka: ["Couverture des charges fixes", "Contribution de sécurité"], category: "garde",
    plain: "Le prix qui, en plus des coûts de la nuit, couvre sa part de vos charges fixes. Entre le plancher absolu et le plancher stratégique, descendre le prix est possible mais demande votre validation commentée.",
    example: "900 € de charges fixes ÷ 20 nuits vendues attendues = 45 € à couvrir par nuit vendue. Le plancher stratégique est le prix qui laisse 45 € de contribution.",
    seeIn: { label: "Fiche d'un logement, onglet Économie", href: "/logements" },
    related: ["plancher-absolu", "charges-fixes", "validation-commentee"],
  },
  {
    id: "objectif-nuit", term: "Objectif par nuit vendue", category: "garde",
    plain: "Ce que vous souhaitez gagner en moyenne par nuit vendue, au-delà des coûts et des charges. C'est le repère « idéal », au-dessus des deux planchers.",
    example: "Planchers à 30 € et 45 € : un objectif à 70 € signifie que l'agence cherche des nuits qui laissent 70 € de contribution.",
    related: ["plancher-absolu", "plancher-strategique", "contribution"],
  },
  {
    id: "valeurs-provisoires", term: "Valeurs provisoires", category: "garde",
    plain: "Des montants acceptés temporairement pour démarrer, en attendant que vous les confirmiez. Tant qu'elles sont provisoires, les planchers qui en dépendent le sont aussi, et chaque dossier le signale.",
    example: "Vous ne connaissez pas encore le coût exact du linge : une valeur d'essai permet de lancer la revue, à corriger quand vous aurez vos factures.",
    related: ["plancher-absolu", "onboarding"],
  },
  {
    id: "veto", term: "Veto", aka: ["Droit de veto de l'auditeur"], category: "garde",
    plain: "Le blocage d'une proposition par l'auditeur de l'agence, qui ne rend de comptes qu'à vous. Un veto ne se contourne pas : toute action sous le plancher absolu en reçoit un.",
    example: "Une promotion ferait descendre le prix vendu à 70 € alors que votre plancher absolu est de 78 € : l'auditeur la rejette, elle ne peut pas être approuvée.",
    related: ["plancher-absolu", "validation-commentee"],
  },
  {
    id: "validation-commentee", term: "Validation commentée", category: "garde",
    plain: "Une approbation qui demande de rédiger la raison de votre choix. Elle s'applique aux actions risquées mais permises, par exemple un prix sous le plancher stratégique mais au-dessus du plancher absolu.",
    example: "Vous acceptez de descendre à 62 € pour remplir un week-end creux, au-dessus du plancher absolu mais sous le stratégique : vous notez « week-end creux, trou entre deux séjours ».",
    related: ["plancher-strategique", "veto"],
  },
  {
    id: "risque", term: "Niveau de risque", category: "garde",
    plain: "L'importance des conséquences si une action se révèle mauvaise : faible, modéré, élevé ou critique. Plus il monte, plus l'approbation est exigeante.",
    example: "Réduire un séjour minimum pour un seul trou : risque faible. Changer le prix de base : risque élevé, car il touche toutes les nuits.",
    related: ["confiance", "validation-commentee"],
  },
  {
    id: "confiance", term: "Confiance du diagnostic", category: "garde",
    plain: "Le degré d'assurance de l'équipe dans son analyse, de faible à élevée. Elle dépend de la quantité et de la fraîcheur des données disponibles.",
    example: "Avec 12 mois d'historique et un marché bien documenté, la confiance est élevée. Avec 3 réservations seulement, elle reste faible : mieux vaut attendre.",
    related: ["risque", "diagnostic-causal"],
  },

  // ───────────── Fonctionnement de l'agence
  {
    id: "diagnostic-causal", term: "Diagnostic causal", category: "agence",
    plain: "La règle centrale de l'agence : une occupation faible n'entraîne jamais automatiquement une baisse de prix. L'équipe cherche d'abord la cause (demande, fenêtre de réservation, prix, restriction, promotion, annonce), compare les options, dont celle de ne rien faire.",
    example: "Occupation basse en février : la demande de toute la ville est faible (le marché est aussi à 30 %). Baisser le prix n'y changerait rien. On attend, ou on vise une autre clientèle.",
    seeIn: { label: "Méthode de travail", href: "/methode" },
    related: ["ecart-marche", "inaction", "hypothese"],
  },
  {
    id: "inaction", term: "Inaction retenue", aka: ["Ne rien faire et réévaluer"], category: "agence",
    plain: "Une vraie option, pas un oubli : l'équipe décide de ne rien changer et de réexaminer plus tard, parce qu'agir coûterait plus que d'attendre.",
    example: "Une semaine semble creuse, mais tout le marché l'est aussi. L'équipe propose d'attendre 7 jours avant de toucher au prix.",
    related: ["diagnostic-causal", "hypothese"],
  },
  {
    id: "hypothese", term: "Hypothèse", category: "agence",
    plain: "L'explication que l'équipe retient pour justifier une action. Chaque montant simulé est rattaché à son hypothèse, et la mesure ultérieure vérifie si elle était juste.",
    example: "« Le séjour minimum de 3 nuits écarte les voyageurs d'un week-end » : on le réduit à 2 nuits, puis on regarde si de nouvelles réservations arrivent.",
    related: ["diagnostic-causal", "effet-incremental"],
  },
  {
    id: "effet-incremental", term: "Effet incrémental", category: "agence",
    plain: "Le gain réellement dû à une action, c'est-à-dire ce qui s'est passé de mieux que ce qui serait arrivé sans elle. Sans période témoin pour comparer, l'application ne l'attribue pas et affiche « inconnu » plutôt qu'un chiffre trompeur.",
    example: "Vous baissez le prix et vendez 3 nuits de plus. Mais le marché a lui aussi progressé de 3 nuits : l'effet de votre action est nul. Sans cette comparaison, on aurait crié victoire à tort.",
    seeIn: { label: "Historique", href: "/historique" },
    related: ["hypothese", "mesure"],
  },
  {
    id: "mesure", term: "Mesure", aka: ["Fenêtre de mesure", "Période de mesure"], category: "agence",
    plain: "Le temps d'observation qui suit une action, pour juger de son effet. Une action n'est considérée comme réussie qu'une fois mesurée.",
    example: "Une action sur un week-end de mars est mesurée pendant 14 jours : on compare le rythme des réservations de ces nuits à celui des 14 jours d'avant l'action.",
    related: ["baseline", "effet-incremental", "retour-arriere"],
  },
  {
    id: "baseline", term: "Référence avant action", aka: ["Baseline", "Expérience", "Fenêtre de référence"], category: "agence",
    plain: "Ce que le logement faisait juste avant une action : combien de nuits des dates visées se réservaient par jour pendant les 14 jours précédents, et la même chose un an plus tôt quand l'historique le permet. Elle est figée au moment de l'exécution et ne se modifie plus : c'est elle qui permet de dire plus tard si quelque chose a changé. Sans historique suffisant, elle est déclarée insuffisante et la mesure reste non concluante, jamais comparée à un faux zéro.",
    example: "Avant de lancer une promotion sur le week-end du 12, 3 de ses nuits s'étaient réservées en 14 jours (0,2 nuit par jour). Deux semaines après, on compare à ce rythme-là.",
    seeIn: { label: "Historique", href: "/historique" },
    related: ["mesure", "pickup", "effet-incremental"],
  },
  {
    id: "retour-arriere", term: "Retour arrière", aka: ["Rollback", "Annulation"], category: "agence",
    plain: "La possibilité d'annuler une action et de revenir à la situation précédente. Chaque action doit avoir un plan de retour avant d'être approuvée.",
    example: "Un prix daté à 130 € ne rapporte rien : on le supprime et le prix calculé par PriceLabs reprend la main.",
    related: ["mesure", "risque"],
  },
  {
    id: "rythme-de-suivi", term: "Rythme de suivi", aka: ["Fréquence de mise à jour", "Suivi soutenu", "Suivi actif", "Suivi régulier", "Suivi allégé"], category: "agence",
    plain: "La fréquence à laquelle l'équipe relit les données d'un logement et le repasse en revue. Elle s'adapte à chaque logement : plus il bouge (nuits libres proches, réservations récentes, marché agité, action en cours), plus les passages sont rapprochés. Une réservation ou une annulation relance la revue sans attendre.",
    example: "Châtillon a 5 nuits libres cette semaine et vient de recevoir 2 réservations : ses réservations sont relues toutes les 2 h et l'équipe le revoit toutes les 12 h. Évry est plein pour le mois : une lecture toutes les 6 h et une revue tous les 2 jours suffisent.",
    seeIn: { label: "Logements", href: "/logements" },
    related: ["pickup", "delai-reservation", "synchronisation"],
  },
  {
    id: "dossier", term: "Dossier", aka: ["Opportunité", "Situation à arbitrer"], category: "agence",
    plain: "Une situation que l'équipe vous présente pour décision : le signal observé, la période, l'hypothèse, puis les options. Vous n'en voyez que quand une décision humaine est utile.",
    example: "« Trou de 2 nuits du 14 au 16 mars » est un dossier : trois options chiffrées vous sont proposées, dont ne rien faire.",
    seeIn: { label: "Opportunités", href: "/" },
    related: ["diagnostic-causal", "cascade"],
  },
  {
    id: "cascade", term: "Cascade du revenu net", category: "agence",
    plain: "Le tableau qui détaille, étape par étape, comment on passe du prix publié à ce qu'il vous reste : promotion, commission, frais, ménage, coûts variables, puis contribution. Il se lit de haut en bas.",
    example: "Prix publié 115 € → remise de 10 % → 103,50 € payés → commission et frais de 16 % → revenu net 86,94 € → coûts de la nuit → contribution.",
    seeIn: { label: "Un dossier", href: "/" },
    related: ["contribution", "revenu-net", "prix-publie"],
  },
  {
    id: "onboarding", term: "Onboarding", aka: ["Mise en route"], category: "agence",
    plain: "La phase de démarrage d'un logement : vous renseignez ses informations, ses connexions et ses coûts pour que l'agence puisse calculer vos planchers. Sans ces données, aucune recommandation n'est faite.",
    example: "Le T5 d'Évry est en onboarding tant que son coût du ménage et ses commissions ne sont pas renseignés.",
    seeIn: { label: "Logements", href: "/logements" },
    related: ["valeurs-provisoires", "observation"],
  },
  {
    id: "observation", term: "Période d'observation", aka: ["Shadow", "Mode observation"], category: "agence",
    plain: "Une phase de test où l'équipe analyse et propose, mais où aucune écriture n'est faite chez PriceLabs ou sur les plateformes. Vos approbations sont enregistrées comme des jugements hypothétiques.",
    example: "Pendant l'observation, vous approuvez une hausse de prix : elle est notée « approuvée en observation » et aucun prix réel ne change.",
    related: ["onboarding", "mode-demo"],
  },
  {
    id: "mode-demo", term: "Mode démonstration", aka: ["Données démo"], category: "agence",
    plain: "Des logements fictifs, aux données synthétiques, pour découvrir l'application sans toucher à vos vrais biens. Les écritures vers PriceLabs y sont simulées.",
    example: "Un logement marqué « démo » affiche de faux revenus : à ne pas confondre avec les vôtres.",
    related: ["observation"],
  },
  {
    id: "procedure-manuelle", term: "Procédure manuelle guidée", category: "agence",
    plain: "Quand l'agence ne peut pas agir elle-même sur Airbnb ou Booking.com (pas d'accès partenaire officiel), elle vous donne les étapes à suivre sur le site de la plateforme. L'application n'automatise aucun navigateur.",
    example: "Pour lancer une promotion de 8 % sur Booking.com, l'application affiche le parcours à suivre dans l'extranet, étape par étape.",
    related: ["promotion-canal"],
  },
];

export const GLOSSARY_BY_ID: Record<string, GlossaryEntry> = Object.fromEntries(GLOSSARY.map((e) => [e.id, e]));
