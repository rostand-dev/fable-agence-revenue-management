import { describe, expect, it } from "vitest";
import { addDays } from "../dates";
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
    capabilities: {}, activeRanges: [],
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
