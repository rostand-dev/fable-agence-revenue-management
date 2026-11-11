import { addDays, dow, type ISODate } from "../dates";
import type { Channel, EconomicModel, Strategy } from "./types";

/**
 * Jeu de données de DÉMONSTRATION. Rien ici n'est relevé dans un outil réel :
 * les scénarios sont construits pour que chaque playbook du moteur soit visible.
 * Les valeurs économiques sont des hypothèses à remplacer pendant l'onboarding.
 */
function prng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const SEASON = [0.9, 0.9, 0.98, 1.05, 1.1, 1.15, 1.08, 0.95, 1.12, 1.08, 1.0, 1.05];
const season = (d: ISODate) => SEASON[Number(d.slice(5, 7)) - 1];

export type DemoDay = { date: ISODate; state: "FREE" | "BOOKED" | "BLOCKED"; priceCents: number; minStay: number; rule: string | null; marketOccupancy: number; marketAdrCents: number; pricePercentile: number; event: string | null };
export type DemoResa = { externalId: string; channel: Channel; checkIn: ISODate; checkOut: ISODate; nights: number; grossRoomCents: number; cleaningCents: number; commissionCents: number; paymentFeeCents: number; bookedAt: ISODate };
export type DemoPromo = { channel: Channel; kind: string; label: string; discountPct: number; fromOffset: number | null; toOffset: number | null; verifiedDaysAgo: number };
export type DemoProperty = {
  key: string; name: string; city: string; kind: string; bedrooms: number; capacity: number; profile: Record<string, any>;
  economics: EconomicModel; strategy: Strategy; days: DemoDay[]; reservations: DemoResa[]; promos: DemoPromo[];
};

type Spec = {
  key: string; name: string; city: string; kind: string; bedrooms: number; capacity: number; profile: Record<string, any>;
  economics: EconomicModel; strategy: Strategy; seed: number; weekendFactor: number; airbnbShare: number;
  histLos: number[]; histGapMean: number; leadMean: number;
  future: [number, number, Channel][];
  tweak: (o: number, d: DemoDay) => void;
  promos: DemoPromo[];
};

const SPECS: Spec[] = [
  {
    key: "chatillon", name: "T3 Châtillon", city: "Châtillon", kind: "T3", bedrooms: 2, capacity: 4, seed: 4211,
    profile: { positioning: "Professionnels et séjours longs, familles le week-end", channels: ["AIRBNB", "BOOKING"], notes: "Logement pilote." },
    economics: {
      channels: { AIRBNB: { commissionPct: 15.5, paymentFeePct: 0 }, BOOKING: { commissionPct: 15, paymentFeePct: 1.4 } },
      cleaningFeeChargedCents: 5500, cleaningCostCents: 6200, linenCostCents: 800, nightlyVariableCostCents: 600,
      hardContributionPerNightCents: 3000, strategyContributionPerNightCents: 4800, targetContributionPerNightCents: 6500, origin: "DEMO",
    },
    strategy: { basePriceCents: 11600, minPriceCents: 8300, maxPriceCents: 21000, minStay: 2, objective: "+20 % de chiffre d'affaires sur six mois", positioning: "Pro et long séjour", maxDiscountStackPct: 20, maxPriceChangePct: 5 },
    weekendFactor: 1.08, airbnbShare: 0.6, histLos: [2, 2, 3, 3, 3, 4, 5, 7], histGapMean: 1.7, leadMean: 16,
    future: [[0, 4, "AIRBNB"], [4, 3, "BOOKING"], [7, 3, "AIRBNB"], [12, 4, "BOOKING"], [20, 2, "AIRBNB"], [31, 2, "AIRBNB"], [48, 4, "BOOKING"], [53, 3, "AIRBNB"], [57, 3, "AIRBNB"], [70, 2, "AIRBNB"]],
    tweak: (o, d) => {
      if (o >= 8 && o <= 14) d.minStay = 3;
      if (o >= 15 && o <= 30) { d.marketOccupancy = 0.62; d.pricePercentile = 78; }
      if (o >= 31 && o <= 60) { d.marketOccupancy = 0.41; d.pricePercentile = 50; }
      if (o >= 36 && o <= 43) d.priceCents = 10500;
      if (o >= 61) { d.marketOccupancy = 0.38; d.pricePercentile = 52; }
    },
    promos: [
      { channel: "BOOKING", kind: "GENIUS", label: "Genius", discountPct: 10, fromOffset: null, toOffset: null, verifiedDaysAgo: 2 },
      { channel: "BOOKING", kind: "COUNTRY", label: "Tarif par pays", discountPct: 10, fromOffset: null, toOffset: null, verifiedDaysAgo: 2 },
      { channel: "BOOKING", kind: "LIMITED", label: "Offre à durée limitée", discountPct: 15, fromOffset: 36, toOffset: 44, verifiedDaysAgo: 2 },
      { channel: "AIRBNB", kind: "CUSTOM", label: "Promotion personnalisée", discountPct: 8, fromOffset: 62, toOffset: 69, verifiedDaysAgo: 12 },
    ],
  },
  {
    key: "evry", name: "T5 Évry-Courcouronnes", city: "Évry-Courcouronnes", kind: "T5", bedrooms: 4, capacity: 8, seed: 9137,
    profile: { positioning: "Groupes, entreprises et séjours longs", channels: ["AIRBNB", "BOOKING"], notes: "Orienté professionnels." },
    economics: {
      channels: { AIRBNB: { commissionPct: 15.5, paymentFeePct: 0 }, BOOKING: { commissionPct: 15, paymentFeePct: 1.4 } },
      cleaningFeeChargedCents: 10000, cleaningCostCents: 11000, linenCostCents: 2500, nightlyVariableCostCents: 1200,
      hardContributionPerNightCents: 5500, strategyContributionPerNightCents: 7000, targetContributionPerNightCents: 9500, origin: "DEMO",
    },
    strategy: { basePriceCents: 16500, minPriceCents: 12500, maxPriceCents: 32000, minStay: 2, objective: "Protéger le revenu net des séjours professionnels", positioning: "Entreprises et séjours longs", maxDiscountStackPct: 20, maxPriceChangePct: 5 },
    weekendFactor: 0.97, airbnbShare: 0.35, histLos: [3, 4, 5, 7, 7, 7, 10, 14, 21], histGapMean: 1.9, leadMean: 36,
    future: [[0, 2, "BOOKING"], [5, 7, "BOOKING"], [12, 14, "BOOKING"], [31, 14, "BOOKING"], [45, 11, "AIRBNB"], [57, 3, "BOOKING"], [75, 7, "BOOKING"]],
    tweak: (o, d) => {
      if (o >= 2 && o <= 4) { d.priceCents = 11600; d.rule = "Dernière minute −30 %"; d.pricePercentile = 22; d.marketOccupancy = 0.75; }
      if (o >= 31 && o <= 60) { d.marketOccupancy = 0.38; d.pricePercentile = 32; }
      if (o >= 61) { d.marketOccupancy = 0.3; d.pricePercentile = 32; }
      if (o >= 66 && o <= 68) { d.event = "Salon professionnel (démonstration)"; d.marketOccupancy = 0.88; d.pricePercentile = 30; d.priceCents = 16500; }
    },
    promos: [{ channel: "BOOKING", kind: "GENIUS", label: "Genius", discountPct: 10, fromOffset: null, toOffset: null, verifiedDaysAgo: 1 }],
  },
];

function fees(e: EconomicModel, ch: Channel, gross: number) {
  const c = e.channels[ch]!;
  return { commissionCents: Math.round(gross * c.commissionPct / 100), paymentFeeCents: Math.round(gross * c.paymentFeePct / 100) };
}

export function buildDemo(today: ISODate): DemoProperty[] {
  return SPECS.map((s) => {
    const rnd = prng(s.seed);
    const base = s.strategy.basePriceCents!;
    const nightly = (d: ISODate) => Math.round((base * season(d) * ([5, 6].includes(dow(d)) ? s.weekendFactor : 1)) / 100) * 100;
    const reservations: DemoResa[] = [];
    let n = 0;
    const push = (checkIn: ISODate, nights: number, channel: Channel, lead: number, factor: number) => {
      let gross = 0; for (let i = 0; i < nights; i++) gross += nightly(addDays(checkIn, i));
      gross = Math.round(gross * factor);
      reservations.push({ externalId: `DEMO-${s.key}-${++n}`, channel, checkIn, checkOut: addDays(checkIn, nights), nights, grossRoomCents: gross, cleaningCents: s.economics.cleaningFeeChargedCents!, ...fees(s.economics, channel, gross), bookedAt: addDays(checkIn, -lead) });
    };
    // douze mois d'historique synthétique
    let cursor = addDays(today, -365);
    while (cursor < addDays(today, -2)) {
      cursor = addDays(cursor, Math.floor(-Math.log(1 - rnd()) * s.histGapMean));
      const nights = s.histLos[Math.floor(rnd() * s.histLos.length)];
      if (addDays(cursor, nights) > today) break;
      push(cursor, nights, rnd() < s.airbnbShare ? "AIRBNB" : "BOOKING", Math.max(0, Math.round(-Math.log(1 - rnd()) * s.leadMean)), 0.88 + rnd() * 0.16);
      cursor = addDays(cursor, nights);
    }
    // calendrier et marché J+0 à J+90
    const days: DemoDay[] = [];
    for (let o = 0; o <= 90; o++) {
      const date = addDays(today, o);
      const d: DemoDay = {
        date, state: "FREE", priceCents: nightly(date), minStay: s.strategy.minStay!, rule: null,
        marketOccupancy: Math.round((0.25 + 0.5 * Math.exp(-o / 38) + (rnd() - 0.5) * 0.04) * 100) / 100,
        marketAdrCents: Math.round(base * season(date) * (0.97 + rnd() * 0.06) / 100) * 100,
        pricePercentile: Math.round(44 + rnd() * 10), event: null,
      };
      s.tweak(o, d);
      days.push(d);
    }
    for (const [o, nights, ch] of s.future) {
      push(addDays(today, o), nights, ch, 4 + Math.floor(rnd() * 24) + (o > 30 ? o - 20 : 0), 0.95 + rnd() * 0.08);
      for (let i = o; i < o + nights && i <= 90; i++) days[i].state = "BOOKED";
    }
    return { key: s.key, name: s.name, city: s.city, kind: s.kind, bedrooms: s.bedrooms, capacity: s.capacity, profile: s.profile, economics: s.economics, strategy: s.strategy, days, reservations, promos: s.promos };
  });
}
