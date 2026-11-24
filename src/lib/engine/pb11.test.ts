import { describe, expect, it } from "vitest";
import { addDays, type ISODate } from "../dates";
import { capabilityFlags } from "../integrations/capabilities";
import { approvalRequirement } from "./approval";
import { buildDemo } from "./demo";
import { reviewProperty, type EngineInput } from "./detect";
import { PLAYBOOKS, threshold } from "./playbooks";
import type { Day, Resa } from "./types";

const TODAY = "2026-11-12";
const NOW = new Date(TODAY + "T07:00:00Z");
const base = buildDemo(TODAY).find((x) => x.key === "chatillon")!;
const booking = (channel: string, bookedAgo: number, leadDays: number, nights = 3): Resa => {
  const bookedAt = addDays(TODAY, -bookedAgo), checkIn = addDays(bookedAt, leadDays);
  return { channel, checkIn, checkOut: addDays(checkIn, nights), nights, grossRoomCents: nights * 10000, commissionCents: 1500, paymentFeeCents: 0, bookedAt, status: "CONFIRMED" };
};
/** `n` réservations réparties sur [from, to] jours avant aujourd'hui, toutes avec le même délai. */
const batch = (n: number, from: number, to: number, lead: number, channel = "AIRBNB") => Array.from({ length: n }, (_, i) => booking(channel, from + Math.round(((to - from) * i) / Math.max(1, n - 1)), lead));

type O = { recent?: Resa[]; reference?: Resa[]; market?: number | null; first?: ISODate | null; bookedFrom?: number; extra?: Partial<EngineInput> };
// Référence : 8 prises il y a 30 à 83 jours, délai de 15 jours ; récent : 8 prises sur les 27 derniers jours, délai de 40 jours.
function scenario(o: O = {}): EngineInput {
  const days: Day[] = [];
  for (let k = 0; k <= 90; k++) days.push({ date: addDays(TODAY, k), state: o.bookedFrom !== undefined && k >= o.bookedFrom && k % 10 < 7 ? "BOOKED" : "FREE", priceCents: 10000, minStay: 2, rule: null, marketOccupancy: o.market === undefined ? null : o.market, marketAdrCents: o.market === null || o.market === undefined ? null : 10000, pricePercentile: o.market === null || o.market === undefined ? null : 50, event: null });
  return {
    today: TODAY, now: NOW, property: { id: "t", name: "Test", isDemo: true }, model: base.economics, strategy: base.strategy, days, promos: [],
    resas: [...(o.reference ?? batch(8, 30, 83, 15)), ...(o.recent ?? batch(8, 0, 27, 40))], capabilities: capabilityFlags({ isDemo: true, killSwitch: {} }), activeRanges: [],
    firstBookingDate: o.first === undefined ? addDays(TODAY, -200) : o.first, ...o.extra,
  };
}
const pb11 = (i: EngineInput) => reviewProperty(i).opportunities.filter((x) => x.playbook === "PB-11");

describe("PB-11 · prix de base trop bas, lu dans le logement lui-même", () => {
  it("délai de réservation qui s'allonge sans ralentir, sans aucune donnée de marché : un palier de hausse, validation du propriétaire", () => {
    const [o] = pb11(scenario());
    expect(o.reasonCode).toBe("LEAD_TIME_LENGTHENS");
    expect(o.candidates.map((c) => c.type)).toEqual(["BASE_PRICE_CHANGE", "NO_ACTION"]);
    const c = o.candidates[0];
    expect(c.parameters.changePct).toBe(threshold("PB-11", "stepPct"));
    expect(c.expectedDeltaCents).toBeNull(); // pas de marché : gain non chiffré, dit dans l'hypothèse
    expect(c.hypothesis).toContain("Sans donnée de marché");
    expect(c.audit.verdict).not.toBe("REJECT");
    expect(o.candidates[o.selected].type).toBe("BASE_PRICE_CHANGE");
    expect(o.signal!.measures.map((m) => m.key)).toEqual(["leadGrowth", "leadShift", "bookingRatio", "recentBookings", "channelShift"]);
    expect(approvalRequirement(c, o.playbook).reasons.join(" ")).toContain("PB-11");
    expect(o.dedupe).toBe("base");
  });
  it("historique inconnu ou trop court : silence", () => {
    expect(pb11(scenario({ first: null }))).toHaveLength(0);
    expect(pb11(scenario({ first: addDays(TODAY, -60) }))).toHaveLength(0); // ne couvre pas la référence (84 jours)
    expect(pb11(scenario({ extra: { firstBookingDate: undefined } }))).toHaveLength(0);
  });
  it("échantillons trop petits : silence", () => {
    expect(pb11(scenario({ recent: batch(5, 0, 27, 40) }))).toHaveLength(0);
    expect(pb11(scenario({ reference: batch(5, 30, 83, 15) }))).toHaveLength(0);
  });
  it("délai peu allongé : silence ; allongement net : dossier", () => {
    expect(pb11(scenario({ recent: batch(8, 0, 27, 20) }))).toHaveLength(0); // 15 → 20 jours : +33 %, +5 jours
    expect(pb11(scenario({ recent: batch(8, 0, 27, 28) }))).toHaveLength(0); // +87 % mais +13 jours, sous le minimum absolu
    expect(pb11(scenario({ recent: batch(8, 0, 27, 30) }))).toHaveLength(1); // +100 %, +15 jours
  });
  it("demande qui faiblit (rythme récent inférieur à la référence) : le prix n'est pas en cause", () => {
    expect(pb11(scenario({ reference: batch(30, 30, 83, 15), recent: batch(6, 0, 27, 40) }))).toHaveLength(0); // 6 prises contre 30 en 56 jours (15 attendues sur 28)
  });
  it("mix de canaux modifié : exclu", () => {
    const ref = batch(8, 30, 83, 15, "AIRBNB"), rec = batch(8, 0, 27, 40, "BOOKING");
    expect(pb11(scenario({ reference: ref, recent: rec }))).toHaveLength(0);
  });
  it("PB-02 prioritaire : si l'avance sur le marché se déclenche, PB-11 se tait", () => {
    const i = scenario({ market: 0.3, bookedFrom: 15 });
    const r = reviewProperty(i);
    expect(r.opportunities.some((o) => o.playbook === "PB-02")).toBe(true);
    expect(r.opportunities.some((o) => o.playbook === "PB-11")).toBe(false);
  });
  it("verrou structurant et plafond de 7 jours : l'option est rejetée, l'inaction est retenue", () => {
    const locked = pb11(scenario({ extra: { structuralHold: { reason: "ACTION_ACTIVE", since: addDays(TODAY, -2) } } }))[0];
    expect(locked.candidates[0].audit.verdict).toBe("REJECT");
    expect(locked.candidates[locked.selected].type).toBe("NO_ACTION");
    const capped = pb11(scenario({ extra: { recentBaseChanges: [{ at: addDays(TODAY, -3), changePct: 12 }] } }))[0];
    expect(capped.candidates[0].audit.verdict).toBe("REJECT");
    expect(capped.candidates[capped.selected].type).toBe("NO_ACTION");
  });
  it("trop peu de nuits libres entre J+14 et J+90 : rien à relever", () => {
    const i = scenario();
    i.days = i.days.map((d, k) => ({ ...d, state: (k >= 14 && k < 90 ? "BOOKED" : d.state) as Day["state"] })); // ne reste qu'une nuit libre au-delà de J+14 (J+90)
    expect(pb11(i)).toHaveLength(0);
  });
  it("catalogue : actif, approbateur propriétaire, repos de groupe avec PB-02 et PB-12", () => {
    expect(PLAYBOOKS["PB-11"].status).toBe("IMPLEMENTED");
    expect(PLAYBOOKS["PB-11"].approver).toBe("REVENUE_MANAGER_AND_OWNER");
    expect(PLAYBOOKS["PB-11"].vetoRules).toEqual(expect.arrayContaining(["STRUCTURAL_LOCK", "MAX_VARIATION_7D"]));
  });
});
