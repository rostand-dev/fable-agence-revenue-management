import { describe, expect, it } from "vitest";
import { addDays } from "../dates";
import { capabilityFlags } from "../integrations/capabilities";
import { auditCandidate } from "./audit";
import { buildDemo } from "./demo";
import { priorityScore, reviewProperty, type EngineInput } from "./detect";
import { cumulativeDiscountPct, floorGrossNightlyCents, hardFloorCents, missingEconomics, simulateStack, strategyFloorCents } from "./economics";
import { monthlyKpis } from "./metrics";
import { assertTransition, canTransition } from "./stateMachine";
import type { EconomicModel } from "./types";

const model: EconomicModel = {
  channels: { BOOKING: { commissionPct: 17, paymentFeePct: 1.4 }, AIRBNB: { commissionPct: 15.5, paymentFeePct: 0 } },
  cleaningFeeChargedCents: 0, cleaningCostCents: 0, linenCostCents: 0, nightlyVariableCostCents: 0,
  hardContributionPerNightCents: 3000, strategyContributionPerNightCents: 4000, targetContributionPerNightCents: 6000, origin: "DECLARED",
};

describe("simulateur de cumul", () => {
  it("reproduit l'exemple du blueprint §8.4 (145 € − 10 % − 17 % − 1,4 %)", () => {
    const r = simulateStack({ model, channel: "BOOKING", nights: 1, publishedNightlyCents: 14500, promos: [{ label: "Promotion", discountPct: 10 }] });
    expect(r.soldNightlyCents).toBe(13050);
    expect(r.steps.find((s) => s.key === "commission")!.cents).toBe(-2219); // 22,185 € arrondi au centime
    expect(r.steps.find((s) => s.key === "fee")!.cents).toBe(-183);
    expect(r.netRoomCents).toBe(10648);
  });
  it("cumule les remises de façon multiplicative", () => {
    expect(cumulativeDiscountPct([10, 10, 15])).toBeCloseTo(31.15, 2);
  });
  it("la cascade est cohérente de bout en bout", () => {
    const r = simulateStack({ model: { ...model, cleaningCostCents: 6000, linenCostCents: 1000, cleaningFeeChargedCents: 5000, nightlyVariableCostCents: 700 }, channel: "AIRBNB", nights: 3, publishedNightlyCents: 12000, promos: [{ label: "A", discountPct: 5 }] });
    const sum = r.steps.filter((s) => !s.kind).reduce((a, s) => a + s.cents, 0);
    expect(sum).toBe(r.contributionCents);
  });
});

describe("planchers économiques", () => {
  const m: EconomicModel = { ...model, cleaningCostCents: 6200, linenCostCents: 800, cleaningFeeChargedCents: 5500, nightlyVariableCostCents: 600 };
  it("un séjour vendu exactement au plancher laisse au moins la contribution minimale", () => {
    for (const ch of ["AIRBNB", "BOOKING"] as const) for (const n of [1, 2, 3, 7, 14, 28]) {
      const floor = hardFloorCents(m, ch, n);
      const at = simulateStack({ model: m, channel: ch, nights: n, publishedNightlyCents: floor });
      expect(at.contributionPerNightCents).toBeGreaterThanOrEqual(m.hardContributionPerNightCents! - 1);
      const below = simulateStack({ model: m, channel: ch, nights: n, publishedNightlyCents: floor - 200 });
      expect(below.contributionPerNightCents).toBeLessThan(m.hardContributionPerNightCents!);
    }
  });
  it("le plancher baisse quand le séjour s'allonge et le plancher stratégique reste au-dessus", () => {
    expect(hardFloorCents(m, "BOOKING", 2)).toBeGreaterThan(hardFloorCents(m, "BOOKING", 7));
    expect(strategyFloorCents(m, "BOOKING", 2)).toBeGreaterThan(hardFloorCents(m, "BOOKING", 2));
  });
  it("une donnée absente bloque le calcul au lieu de valoir zéro", () => {
    const partial = { ...m, cleaningCostCents: null };
    expect(missingEconomics(partial)).toContain("coût du ménage");
    expect(() => floorGrossNightlyCents(partial, "BOOKING", 2, 3000)).toThrow();
  });
});

describe("machine à états", () => {
  it("refuse toute transition hors graphe", () => {
    expect(canTransition("PENDING_APPROVAL", "APPROVED")).toBe(true);
    expect(canTransition("PENDING_APPROVAL", "EXECUTED")).toBe(false);
    expect(() => assertTransition("CLOSED", "APPROVED")).toThrow();
    expect(() => assertTransition("APPROVED", "VERIFIED")).toThrow();
  });
});

function inputFor(key: string, today = "2026-11-12"): EngineInput {
  const p = buildDemo(today).find((x) => x.key === key)!;
  const now = new Date(today + "T07:00:00Z");
  return {
    today, now, property: { id: key, name: p.name, isDemo: true }, model: p.economics, strategy: p.strategy,
    days: p.days, resas: p.reservations.map((r) => ({ ...r, status: "CONFIRMED" })),
    promos: p.promos.map((x, i) => ({ id: "p" + i, channel: x.channel, kind: x.kind, label: x.label, discountPct: x.discountPct, stayFrom: x.fromOffset === null ? null : addDays(today, x.fromOffset), stayTo: x.toOffset === null ? null : addDays(today, x.toOffset), verifiedAt: new Date(+now - x.verifiedDaysAgo * 86400000) })),
    capabilities: capabilityFlags({ isDemo: true, killSwitch: {} }), activeRanges: [],
  };
}

describe("revue d'un logement (cas dorés de démonstration)", () => {
  const ch = reviewProperty(inputFor("chatillon")), ev = reviewProperty(inputFor("evry"));
  const by = (r: typeof ch, pb: string) => r.opportunities.filter((o) => o.playbook === pb);

  it("Châtillon : trou de 2 nuits → séjour minimum, jamais une baisse de prix", () => {
    const [o] = by(ch, "PB-03");
    expect(o.diagnosis.primary).toBe("RESTRICTION_MISMATCH");
    expect(o.candidates[o.selected].type).toBe("MIN_STAY_OVERRIDE");
    expect(o.candidates.some((c) => c.type === "PRICE_OVERRIDE")).toBe(false);
  });
  it("Châtillon : rythme faible avec prix haut → la promotion qui dépasse le cumul est rejetée par l'auditeur", () => {
    const o = by(ch, "PB-01").find((x) => x.diagnosis.primary === "PRICE_HIGH")!;
    const promo = o.candidates.find((c) => c.type === "CHANNEL_PROMO")!;
    expect(promo.audit.verdict).toBe("REJECT");
    expect(promo.audit.rules.find((r) => r.code === "DISCOUNT_STACK")!.outcome).toBe("FAIL");
    expect(o.selected).not.toBe(o.candidates.indexOf(promo));
  });
  it("Châtillon : fenêtre de réservation pas encore ouverte → recommandation de ne rien faire", () => {
    const o = by(ch, "PB-01").find((x) => x.diagnosis.primary === "BOOKING_WINDOW_NOT_OPEN")!;
    expect(o.candidates[o.selected].type).toBe("NO_ACTION");
    expect(o.candidates[o.selected].reviewAt).toBeTruthy();
  });
  it("Châtillon : cumul de remises et registre périmé", () => {
    expect(by(ch, "PB-05")[0].candidates[by(ch, "PB-05")[0].selected].type).toBe("PROMO_REMOVAL");
    expect(by(ch, "PB-05")[0].candidates[0].parameters.promotionLabel).toBe("Offre à durée limitée");
    expect(by(ch, "PB-10")).toHaveLength(1);
  });
  it("Évry : passage sous le plancher → veto, et l'inaction est rejetée", () => {
    const [o] = by(ev, "PB-06");
    expect(o.veto).toBe(true);
    expect(o.candidates.find((c) => c.type === "NO_ACTION")!.audit.verdict).toBe("REJECT");
    expect(o.candidates[o.selected].type).not.toBe("NO_ACTION");
  });
  it("Évry : avance sur le marché → hausse structurelle soumise à validation commentée ; événement détecté", () => {
    const [o] = by(ev, "PB-02");
    expect(o.candidates[0].type).toBe("BASE_PRICE_CHANGE");
    expect(o.candidates[0].audit.verdict).toBe("NEEDS_HUMAN");
    expect(by(ev, "PB-07")).toHaveLength(1);
  });
  it("propriété : aucune option retenue ou approuvable ne passe sous le plancher absolu", () => {
    for (const r of [ch, ev]) for (const o of r.opportunities) for (const c of o.candidates) {
      const s = c.proposed ?? c.current;
      if (!s || c.audit.verdict === "REJECT") continue;
      expect(s.soldNightlyCents).toBeGreaterThanOrEqual(hardFloorCents(inputFor("evry").model, s.channel, s.nights) > 0 ? hardFloorCents(r === ch ? inputFor("chatillon").model : inputFor("evry").model, s.channel, s.nights) : 0);
    }
  });
  it("le veto passe en tête du classement", () => {
    const sorted = [...ev.opportunities].sort((a, b) => priorityScore(b) - priorityScore(a));
    expect(sorted[0].veto).toBe(true);
  });
  it("modèle économique incomplet → aucune opportunité, la revue signale le blocage", () => {
    const i = inputFor("chatillon"); i.model = { ...i.model, hardContributionPerNightCents: null };
    const r = reviewProperty(i);
    expect(r.opportunities).toHaveLength(0);
    expect(r.blocked.length).toBeGreaterThan(0);
  });
  it("une action déjà en observation sur les dates bloque une nouvelle écriture", () => {
    const i = inputFor("chatillon"); i.activeRanges = [{ from: addDays(i.today, 0), to: addDays(i.today, 90) }];
    const o = reviewProperty(i).opportunities.find((x) => x.playbook === "PB-03")!;
    expect(o.candidates[0].audit.verdict).toBe("REJECT");
  });
});

describe("métriques", () => {
  it("attribue chaque nuit à son mois et ne compte pas une commission inconnue comme nulle sans le dire", () => {
    const k = monthlyKpis([{ channel: "AIRBNB", checkIn: "2026-01-30", checkOut: "2026-02-02", nights: 3, grossRoomCents: 30000, commissionCents: null, paymentFeeCents: null, bookedAt: "2026-01-01", status: "CONFIRMED" }], ["2026-01", "2026-02"]);
    expect(k[0].nights).toBe(2); expect(k[1].nights).toBe(1); expect(k[0].netIncomplete).toBe(true);
  });
});
void auditCandidate;

import { answersFromModel, fixedMonthly, modelFromAnswers, parseNum, variablePerNight } from "./costs";
import { breakEvenNights, breakEvenPriceCents, contributionPerNightCents } from "./economics";
describe("parcours Coûts et seuils", () => {
  it("déduit le modèle des réponses concrètes", () => {
    const m = modelFromAnswers({ airbnbPct: "17,6", bookingPct: "16,3", bookingFeePct: "1,4", cleaningFee: "55", cleaningCost: "62", linenMode: "included", nightMode: "calc", energyYear: "900", waterYear: "300", nightsYear: "200", consumablesStay: "9", avgStay: "3", hard: "20", rent: "900", insurance: "30", nightsMonth: "15", goalMonth: "600", provisional: ["hard", "inconnu"] });
    expect(m.channels.AIRBNB!.commissionPct).toBe(17.6);
    expect(m.linenCostCents).toBe(0);                       // « compris dans le ménage » est un zéro déclaré
    expect(m.nightlyVariableCostCents).toBe(900);           // 1 200 / 200 + 9 / 3
    expect(m.strategyContributionPerNightCents).toBe(6200); // 930 / 15
    expect(m.targetContributionPerNightCents).toBe(10200);  // (930 + 600) / 15
    expect(m.provisional).toEqual(["seuil de dérangement"]);
    expect(missingEconomics(m)).toHaveLength(0);
  });
  it("une réponse absente reste inconnue et bloque le plancher", () => {
    const m = modelFromAnswers({ bookingPct: "16", cleaningFee: "55", cleaningCost: "62", linenMode: "self", hard: "20" });
    expect(m.linenCostCents).toBeNull(); expect(m.nightlyVariableCostCents).toBeNull(); expect(m.strategyContributionPerNightCents).toBeNull();
    expect(missingEconomics(m)).toEqual(expect.arrayContaining(["coût du linge", "coûts variables par nuit", "couverture des charges fixes"]));
    expect(parseNum("")).toBeNull(); expect(parseNum("0")).toBe(0); expect(parseNum("abc")).toBeNull();
    expect(variablePerNight({ nightMode: "calc", energyYear: "900" })).toBeNull(); // sans nombre de nuits, pas de division
    expect(modelFromAnswers({ taxMode: "calc", taxYear: "1946,49", grossYear: "27527,45" }).touristTaxPct).toBe(7.1);
    expect(modelFromAnswers({ taxMode: "none" }).touristTaxPct).toBe(0); expect(modelFromAnswers({ taxMode: "calc", taxYear: "100" }).touristTaxPct).toBeNull();
  });
  it("le plancher stratégique ne passe jamais sous le seuil de dérangement, et un ancien dossier se reprend", () => {
    expect(modelFromAnswers({ hard: "50", rent: "300", nightsMonth: "20" }).strategyContributionPerNightCents).toBe(5000);
    const back = answersFromModel({ ...model, cleaningCostCents: 6250, linenCostCents: 0, nightlyVariableCostCents: 600 });
    expect(back).toMatchObject({ bookingPct: "17", cleaningCost: "62,5", linenMode: "included", nightMode: "direct", variableDirect: "6" });
  });
});
describe("occupation", () => {
  it("retire les nuits bloquées par le propriétaire du disponible", () => {
    const r = (status: string, ci: string, co: string, g = 0) => ({ channel: "AIRBNB", checkIn: ci, checkOut: co, nights: 0, grossRoomCents: g, commissionCents: 0, paymentFeeCents: 0, bookedAt: ci, status });
    const [k] = monthlyKpis([{ ...r("CONFIRMED", "2026-04-01", "2026-04-19", 180000), nights: 18 }, r("BLOCKED", "2026-04-25", "2026-05-11")], ["2026-04"]);
    expect(k.blockedNights).toBe(6); expect(k.available).toBe(24); expect(k.occupancy).toBeCloseTo(0.75);
  });
});

describe("capacités d'exécution (US-002)", () => {
  const modes = (i: EngineInput) => reviewProperty(i).opportunities.flatMap((o) => o.candidates.map((c) => c.executionMode));
  it("logement de démonstration : l'écriture PriceLabs est proposée, simulée", () => {
    expect(modes(inputFor("chatillon"))).toContain("API_PRICELABS");
  });
  it("sans capacité d'écriture (logement réel ou coupe-circuit), aucune option n'est proposée en écriture par API", () => {
    const real = { ...inputFor("chatillon"), capabilities: capabilityFlags({ isDemo: false, killSwitch: {} }) };
    expect(modes(real)).not.toContain("API_PRICELABS");
    expect(modes(real)).toContain("MANUAL_RUNBOOK");
    const killed = { ...inputFor("chatillon"), capabilities: capabilityFlags({ isDemo: true, killSwitch: { pricelabs: true } }) };
    expect(modes(killed)).not.toContain("API_PRICELABS");
  });
  it("l'auditeur rejette une écriture par API sans capacité, quelle que soit la simulation", () => {
    const o = reviewProperty(inputFor("chatillon")).opportunities.flatMap((x) => x.candidates).find((c) => c.executionMode === "API_PRICELABS")!;
    const { audit: _, ...draft } = o;
    const ctx = { model: inputFor("chatillon").model, strategy: inputFor("chatillon").strategy, stalePromoChannels: [], conflict: false, demo: true, promos: [], window: { from: "2026-11-12", to: "2026-11-14" } };
    expect(auditCandidate(draft, { ...ctx, capabilities: { "pricelabs.write": true } }).rules.find((r) => r.code === "CAPABILITY")!.outcome).toBe("PASS");
    const v = auditCandidate(draft, { ...ctx, capabilities: { "pricelabs.write": false } });
    expect(v.rules.find((r) => r.code === "CAPABILITY")!.outcome).toBe("FAIL");
    expect(v.verdict).toBe("REJECT");
  });
});

describe("charges du mois et seuil de rentabilité", () => {
  const a = { airbnbPct: "20", cleaningFee: "50", cleaningCost: "50", linenMode: "included" as const, nightMode: "included" as const, hard: "20", rent: "600", insurance: "0", nightsMonth: "20" };
  it("« déjà dans mes charges du mois » est un zéro déclaré, pas une valeur manquante", () => {
    expect(variablePerNight({ nightMode: "included" })).toBe(0);
    expect(modelFromAnswers(a).nightlyVariableCostCents).toBe(0);
    expect(missingEconomics(modelFromAnswers(a))).toHaveLength(0);
  });
  it("le loyer ou le crédit se compte par défaut et se décoche", () => {
    expect(fixedMonthly({ rent: "600", coop: "100" })).toBe(700);
    expect(fixedMonthly({ rent: "600", coop: "100", rentCounted: "yes" })).toBe(700);
    expect(fixedMonthly({ rent: "600", coop: "100", rentCounted: "no" })).toBe(100);
    expect(fixedMonthly({ rent: "600", rentCounted: "no" })).toBe(0); // loyer seul et décoché : choix déclaré, pas une inconnue
    expect(fixedMonthly({ rentCounted: "no" })).toBeNull();            // rien de saisi : inconnu
    expect(modelFromAnswers({ ...a, insurance: undefined, rentCounted: "no" }).strategyContributionPerNightCents).toBe(2000);
    expect(modelFromAnswers({ ...a, rentCounted: "no" }).strategyContributionPerNightCents).toBe(2000); // retombe sur le seuil de dérangement
  });
  it("calcule les nuits à vendre à un prix, et le prix minimum pour un nombre de nuits", () => {
    const m = modelFromAnswers(a);
    expect(contributionPerNightCents(m, "AIRBNB", 2, 10000)).toBe(7500); // 100 × 0,8 − (ménage non récupéré 10 € ÷ 2 nuits)
    expect(breakEvenNights(m, "AIRBNB", 2, 10000, 60000)).toBe(8);
    expect(breakEvenPriceCents(m, "AIRBNB", 2, 20, 60000)).toBe(4375);
    expect(breakEvenNights(m, "AIRBNB", 2, 500, 60000)).toBeNull(); // à 5 € la nuit ne laisse rien
  });
  it("ignore une estimation provisoire du coût par nuit quand il est déjà dans les charges", () => {
    expect(modelFromAnswers({ ...a, provisional: ["variable", "hard"] }).provisional).toEqual(["seuil de dérangement"]);
  });
  it("cas limites du seuil de rentabilité : charges nulles, ménage en marge, arrondi", () => {
    const m = modelFromAnswers({ ...a, cleaningFee: "100", cleaningCost: "50" }); // ménage en marge : coût de séjour négatif
    expect(breakEvenNights(m, "AIRBNB", 2, 10000, 0)).toBe(0);
    expect(breakEvenPriceCents(m, "AIRBNB", 7, 15, 60000)).toBeGreaterThan(0);
    expect(breakEvenNights(m, "AIRBNB", 7, 1999, 60000)).toBeGreaterThan(0);
    expect(() => breakEvenPriceCents(m, "AIRBNB", 2, 0, 60000)).toThrow();
    expect(modelFromAnswers({ ...a, linenMode: "service", linenCost: "10" }).nightlyVariableCostCents).toBe(0); // linge et coût par nuit restent indépendants
  });
  it("« couvrir les coûts de la nuit me suffit » est un seuil de dérangement à 0, déclaré", () => {
    const m = modelFromAnswers({ ...a, hard: "30", hardMode: "none", provisional: ["hard"] });
    expect(m.hardContributionPerNightCents).toBe(0);                 // la valeur saisie est ignorée
    expect(m.provisional).toEqual([]);
    expect(m.strategyContributionPerNightCents).toBe(3000);          // 600 € ÷ 20 nuits, plus de plancher de dérangement
    expect(missingEconomics(m)).toHaveLength(0);
    expect(modelFromAnswers({ ...a, hard: "30", hardMode: "set" }).hardContributionPerNightCents).toBe(3000);
    // le retour au mode « set » retrouve la valeur saisie ; un dossier repris garde son choix
    expect(answersFromModel({ ...model, answers: { hard: "30", hardMode: "none" } as any })).toMatchObject({ hard: "30", hardMode: "none" });
    expect(answersFromModel({ ...model, hardContributionPerNightCents: 3000 }).hardMode).toBeUndefined();
    expect(modelFromAnswers({ ...a, hard: "", hardMode: "set" }).hardContributionPerNightCents).toBeNull(); // sans choix ni valeur : inconnu
  });
});
