import { describe, expect, it } from "vitest";
import { addDays, type ISODate } from "../dates";
import { capabilityFlags } from "../integrations/capabilities";
import { buildDemo } from "./demo";
import { reviewProperty, type EngineInput } from "./detect";
import type { Cancellation } from "./history";
import { threshold } from "./playbooks";
import type { Day, Resa } from "./types";

const TODAY = "2026-11-12";
const NOW = new Date(TODAY + "T07:00:00Z");
const base = buildDemo(TODAY).find((x) => x.key === "chatillon")!;
const resa = (channel: string, checkIn: ISODate, nights: number, bookedAgo = 20): Resa => ({ channel, checkIn, checkOut: addDays(checkIn, nights), nights, grossRoomCents: nights * 10000, commissionCents: 1500, paymentFeeCents: 0, bookedAt: addDays(TODAY, -bookedAgo), status: "CONFIRMED" });
const canc = (o: Partial<Cancellation> & { inDays?: number; nights?: number; agoDays?: number } = {}): Cancellation => {
  const ci = addDays(TODAY, o.inDays ?? 10), n = o.nights ?? 4;
  return { channel: o.channel ?? "AIRBNB", checkIn: ci, checkOut: addDays(ci, n), nights: n, grossRoomCents: n * 10000, cancelledAt: addDays(TODAY, -(o.agoDays ?? 1)) };
};

/** Logement neutre, marché sans écart ; les nuits listées dans `booked` sont réservées, les autres libres. */
function scenario(o: { cancellations?: Cancellation[] | undefined; since?: ISODate | null; booked?: ISODate[]; blocked?: ISODate[] } = {}): EngineInput {
  const hist: Resa[] = [];
  for (let i = 0; i < 16; i++) hist.push(resa(i % 2 ? "AIRBNB" : "BOOKING", addDays(TODAY, -300 + i * 15), 3));
  const booked = new Set(o.booked ?? []), blocked = new Set(o.blocked ?? []);
  const days: Day[] = [];
  for (let k = 0; k <= 90; k++) {
    const date = addDays(TODAY, k);
    days.push({ date, state: blocked.has(date) ? "BLOCKED" : booked.has(date) ? "BOOKED" : "FREE", priceCents: 10000, minStay: 2, rule: null, marketOccupancy: 0, marketAdrCents: 10000, pricePercentile: 50, event: null });
  }
  return {
    today: TODAY, now: NOW, property: { id: "t", name: "Test", isDemo: true }, model: base.economics, strategy: base.strategy, days, resas: hist, promos: [],
    capabilities: capabilityFlags({ isDemo: true, killSwitch: {} }), activeRanges: [],
    cancellations: o.cancellations, cancellationTracking: o.since === undefined ? { since: addDays(TODAY, -90) } : o.since ? { since: o.since } : null,
  };
}
const pb08 = (i: EngineInput) => reviewProperty(i).opportunities.filter((x) => x.playbook === "PB-08");

describe("PB-08 · dates rouvertes par une annulation", () => {
  it("annulation récente avec des nuits encore libres : un dossier de relecture, sans action de prix", () => {
    const [o] = pb08(scenario({ cancellations: [canc()] }));
    expect(o.reasonCode).toBe("DATES_REOPENED");
    expect(o.stayFrom).toBe(addDays(TODAY, 10)); expect(o.stayTo).toBe(addDays(TODAY, 14));
    expect(o.candidates.map((c) => c.type)).toEqual(["INVESTIGATION", "NO_ACTION"]);
    expect(o.candidates[o.selected].type).toBe("INVESTIGATION");
    expect(o.candidates.every((c) => c.nightsTouched === 0 && c.priceChangePct === null)).toBe(true);
    expect(o.signal!.measures[0]).toMatchObject({ key: "reopenedNights", measured: 4, threshold: threshold("PB-08", "minReopenedNights") });
    expect(o.veto).toBe(false);
  });
  it("historique inconnu : silence, jamais « zéro annulation »", () => {
    expect(pb08(scenario({ cancellations: undefined, since: null }))).toHaveLength(0);
    expect(pb08(scenario({ cancellations: [canc()], since: null }))).toHaveLength(0); // annulation sans début d'historique : non fiable
    expect(pb08(scenario({ cancellations: [canc()], since: addDays(TODAY, -1) }))).toHaveLength(0); // historique plus court que la fenêtre
  });
  it("annulation trop ancienne, nuits déjà revendues ou bloquées, ou séjour déjà passé : aucun dossier", () => {
    expect(pb08(scenario({ cancellations: [canc({ agoDays: 3 })] }))).toHaveLength(0); // fenêtre de 3 jours : aujourd'hui, hier, avant-hier
    expect(pb08(scenario({ cancellations: [canc({ agoDays: 2 })] }))).toHaveLength(1);
    const dates = [10, 11, 12, 13].map((n) => addDays(TODAY, n));
    expect(pb08(scenario({ cancellations: [canc()], booked: dates }))).toHaveLength(0);
    expect(pb08(scenario({ cancellations: [canc()], blocked: dates }))).toHaveLength(0);
    expect(pb08(scenario({ cancellations: [canc({ inDays: -6, nights: 4 })] }))).toHaveLength(0);
  });
  it("seuil de nuits rouvertes : une nuit seule ne suffit pas, deux suffisent, seules les nuits libres comptent", () => {
    expect(pb08(scenario({ cancellations: [canc({ nights: 1 })] }))).toHaveLength(0);
    expect(pb08(scenario({ cancellations: [canc({ nights: 2 })] }))).toHaveLength(1);
    const o = pb08(scenario({ cancellations: [canc({ nights: 4 })], booked: [addDays(TODAY, 10)] }))[0];
    expect(o.stayFrom).toBe(addDays(TODAY, 11)); expect(o.signal!.nights).toBe(3);
  });
  it("horizon : au-delà de 60 jours rien ; entre 46 et 60 jours l'inaction est retenue", () => {
    expect(pb08(scenario({ cancellations: [canc({ inDays: 70 })] }))).toHaveLength(0);
    const far = pb08(scenario({ cancellations: [canc({ inDays: 55 })] }))[0];
    expect(far.candidates[far.selected].type).toBe("NO_ACTION");
  });
  it("une annulation = un dossier, clé stable d'un jour à l'autre ; deux annulations = deux dossiers", () => {
    const two = pb08(scenario({ cancellations: [canc(), canc({ inDays: 30, channel: "BOOKING" })] }));
    expect(two).toHaveLength(2);
    const a = pb08(scenario({ cancellations: [canc()] }))[0], b = pb08(scenario({ cancellations: [canc({ agoDays: 0 })] }))[0];
    expect(a.dedupe).toBe(b.dedupe);
  });
  it("série d'annulations : le taux sur 14 jours est affiché et relève l'urgence, sans changer l'option", () => {
    const calm = pb08(scenario({ cancellations: [canc()] }))[0];
    const burst = pb08(scenario({ cancellations: [canc(), canc({ inDays: 30, agoDays: 5 }), canc({ inDays: 40, agoDays: 6 }), canc({ inDays: 50, agoDays: 7 })] })).find((o) => o.stayFrom === addDays(TODAY, 10))!;
    expect(burst.signal!.measures[1].measured).toBeGreaterThanOrEqual(0.25);
    expect(burst.urgency).toBeGreaterThan(calm.urgency);
    expect(burst.candidates[burst.selected].type).toBe(calm.candidates[calm.selected].type);
  });
  it("taux sur 14 jours inconnu : trop peu de réservations, ou historique plus court que 14 jours ; le dossier est maintenu", () => {
    const few = pb08(scenario({ cancellations: [canc()] }))[0];
    expect(few.signal!.measures[1].measured).toBeNull(); // 1 annulation, aucune prise : échantillon de 1 < 4
    const short = pb08(scenario({ cancellations: [canc(), canc({ inDays: 30 }), canc({ inDays: 40 }), canc({ inDays: 50 })], since: addDays(TODAY, -5) })).find((o) => o.stayFrom === addDays(TODAY, 10))!;
    expect(short.signal!.measures[1].measured).toBeNull(); // 5 jours d'historique : 3 jours évaluables, 14 non
  });
  it("PB-08 ne marque aucune nuit : un autre playbook peut encore traiter les mêmes dates", () => {
    const r = reviewProperty(scenario({ cancellations: [canc()] }));
    expect(r.signals.find((s) => s.playbook === "PB-08")).toBeTruthy();
    expect(r.opportunities.filter((x) => x.playbook !== "PB-08").every((x) => x.candidates.length > 0)).toBe(true);
  });
});
