import { describe, expect, it } from "vitest";
import { addDays, type ISODate } from "../dates";
import { capabilityFlags } from "../integrations/capabilities";
import { buildDemo } from "./demo";
import { reviewProperty, type EngineInput } from "./detect";
import { IMPLEMENTED_PLAYBOOKS, PLAYBOOK_CODES, PLAYBOOKS, playbookOf, threshold } from "./playbooks";
import { formatMeasure, formatValue } from "./signal-format";
import { horizonOf } from "./signals";
import type { Day, Resa } from "./types";

const TODAY = "2026-11-12";
const NOW = new Date(TODAY + "T07:00:00Z");
const base = buildDemo(TODAY).find((x) => x.key === "chatillon")!;

const resa = (channel: string, checkIn: ISODate, nights: number): Resa => ({
  channel, checkIn, checkOut: addDays(checkIn, nights), nights, grossRoomCents: nights * 10000, commissionCents: 1500, paymentFeeCents: 0, bookedAt: addDays(checkIn, -20), status: "CONFIRMED",
});

/** Logement neutre : prix 100 €, marché à l'occupation donnée, séjours à venir réservés au canal donné, historique réparti. */
function scenario(o: { market?: number | null; upcomingChannel?: string; histChannels?: string[]; unknownUpcoming?: boolean } = {}): EngineInput {
  const upcoming = [resa(o.upcomingChannel ?? "BOOKING", addDays(TODAY, 2), 4), resa(o.upcomingChannel ?? "BOOKING", addDays(TODAY, 10), 4), resa(o.upcomingChannel ?? "BOOKING", addDays(TODAY, 20), 4)];
  if (o.unknownUpcoming) upcoming.push(resa("DIRECT", addDays(TODAY, 30), 4), resa("DIRECT", addDays(TODAY, 36), 4));
  const hist: Resa[] = [];
  const chans = o.histChannels ?? ["AIRBNB", "BOOKING"];
  for (let i = 0; i < 16; i++) hist.push(resa(chans[i % chans.length], addDays(TODAY, -300 + i * 15), 3));
  const resas = [...hist, ...upcoming];
  const booked = new Set<ISODate>();
  for (const r of upcoming) for (let i = 0; i < r.nights; i++) booked.add(addDays(r.checkIn, i));
  const days: Day[] = [];
  for (let k = 0; k <= 90; k++) {
    const date = addDays(TODAY, k);
    days.push({ date, state: booked.has(date) ? "BOOKED" : "FREE", priceCents: 10000, minStay: 2, rule: null, marketOccupancy: o.market === undefined ? 0 : o.market, marketAdrCents: 10000, pricePercentile: 50, event: null });
  }
  return {
    today: TODAY, now: NOW, property: { id: "t", name: "Test", isDemo: true }, model: base.economics, strategy: base.strategy, days, resas, promos: [],
    capabilities: capabilityFlags({ isDemo: true, killSwitch: {} }), activeRanges: [],
  };
}
const pb04 = (i: EngineInput) => reviewProperty(i).signals.filter((s) => s.playbook === "PB-04");

describe("catalogue des playbooks", () => {
  it("décrit PB-01 à PB-13, chacun avec ses champs obligatoires", () => {
    expect(PLAYBOOK_CODES).toHaveLength(13);
    for (const c of PLAYBOOK_CODES) {
      const p = PLAYBOOKS[c];
      expect(p.code).toBe(c);
      expect(p.label.length).toBeGreaterThan(3);
      expect(p.cooldownDays).toBeGreaterThan(0);
      expect(p.measurementHorizonDays).toBeGreaterThanOrEqual(0);
      expect(p.verification.length).toBeGreaterThan(10);
      expect(p.requiredData.length).toBeGreaterThan(0);
    }
  });
  it("les 13 playbooks du catalogue sont actifs", () => {
    expect(IMPLEMENTED_PLAYBOOKS).toEqual(["PB-01", "PB-02", "PB-03", "PB-04", "PB-05", "PB-06", "PB-07", "PB-08", "PB-09", "PB-10", "PB-11", "PB-12", "PB-13"]);
    expect(Object.values(PLAYBOOKS).filter((p) => p.status === "PLANNED")).toHaveLength(0);
  });
  it("threshold lit le catalogue et refuse une clé inconnue", () => {
    expect(threshold("PB-01", "paceGap")).toBe(-0.18);
    expect(() => threshold("PB-01", "inexistant")).toThrow();
  });
  it("playbookOf ignore un code inconnu", () => {
    expect(playbookOf("PB-04")?.code).toBe("PB-04");
    expect(playbookOf("PB-99")).toBeNull();
  });
});

describe("horizonOf", () => {
  it("classe une date dans la fenêtre canonique", () => {
    expect(horizonOf(TODAY, addDays(TODAY, 0))).toBe("D0_7");
    expect(horizonOf(TODAY, addDays(TODAY, 8))).toBe("D8_14");
    expect(horizonOf(TODAY, addDays(TODAY, 20))).toBe("D15_30");
    expect(horizonOf(TODAY, addDays(TODAY, 45))).toBe("D31_60");
    expect(horizonOf(TODAY, addDays(TODAY, 80))).toBe("D61_90");
    expect(horizonOf(TODAY, addDays(TODAY, 120))).toBe("D90_PLUS");
  });
});

describe("PB-04 · un canal sous-performe", () => {
  it("se déclenche quand un canal est absent des nuits à venir alors qu'il pèse la moitié de l'historique", () => {
    const s = pb04(scenario());
    expect(s).toHaveLength(1);
    expect(s[0].channel).toBe("AIRBNB");
    const gap = s[0].measures.find((x) => x.key === "shareGap")!;
    expect(gap.measured).toBeLessThanOrEqual(-0.2);
    expect(gap.threshold).toBe(-0.2);
  });
  it("produit une opportunité dont le signal porte ses mesures", () => {
    const r = reviewProperty(scenario());
    const o = r.opportunities.find((x) => x.playbook === "PB-04");
    expect(o).toBeTruthy();
    expect(o!.signal?.playbook).toBe("PB-04");
    expect(o!.signal?.measures.length).toBeGreaterThanOrEqual(3);
  });
  it("se tait quand le marché est inconnu : on ne peut pas dire que le logement suit son marché", () => {
    expect(pb04(scenario({ market: null }))).toHaveLength(0);
  });
  it("laisse PB-01 traiter un retard général du logement", () => {
    expect(pb04(scenario({ market: 0.95 }))).toHaveLength(0);
  });
  it("se tait si l'historique ne couvre qu'un seul canal", () => {
    expect(pb04(scenario({ histChannels: ["BOOKING"] }))).toHaveLength(0);
  });
  it("se tait si les nuits à venir viennent trop d'un canal non identifié", () => {
    expect(pb04(scenario({ unknownUpcoming: true }))).toHaveLength(0);
  });
  it("se tait si l'historique est trop court", () => {
    const i = scenario();
    i.resas = i.resas.filter((r) => r.checkIn >= TODAY || r.nights !== 3 || r.checkIn > addDays(TODAY, -60));
    expect(pb04(i)).toHaveLength(0);
  });
  it("se tait si les parts sont équilibrées", () => {
    const i = scenario();
    i.resas = i.resas.map((r, k) => (r.checkIn >= TODAY && k % 2 === 0 ? { ...r, channel: "AIRBNB" } : r));
    expect(pb04(i)).toHaveLength(0);
  });
  it("marque les nuits ciblées pour qu'aucun autre playbook ne les reprenne", () => {
    const r = reviewProperty(scenario());
    const opp = r.opportunities.filter((o) => o.playbook === "PB-04");
    expect(opp).toHaveLength(1);
  });
});

describe("mesures de signal", () => {
  it("formate chaque unité en français, l'inconnu n'est jamais zéro", () => {
    expect(formatValue(null, "ratio")).toBe("inconnu");
    expect(formatValue(-0.18, "points")).toBe("−18 pts");
    expect(formatValue(0.2, "points")).toBe("+20 pts");
    expect(formatValue(1, "nuits")).toBe("1 nuit");
    expect(formatValue(4, "nuits")).toBe("4 nuits");
    expect(formatValue(7, "jours")).toBe("7 jours");
    expect(formatValue(65, "percentile")).toBe("65e percentile");
    expect(formatValue(12, "séjours")).toBe("12 séjours");
  });
  it("affiche l'opérateur du seuil", () => {
    const f = formatMeasure({ key: "k", label: "L", measured: -0.3, threshold: -0.18, op: "<=", unit: "points" });
    expect(f.observed).toBe("−30 pts");
    expect(f.threshold).toBe("≤ −18 pts");
    expect(formatMeasure({ key: "k", label: "L", measured: 3, threshold: null, op: null, unit: "nuits" }).threshold).toBeNull();
  });
});

describe("signaux sur les logements de démonstration", () => {
  it("chaque opportunité porte un signal rattaché à un playbook du catalogue", () => {
    for (const key of ["chatillon", "evry"]) {
      const p = buildDemo(TODAY).find((x) => x.key === key)!;
      const i: EngineInput = { ...scenario(), property: { id: key, name: p.name, isDemo: true }, model: p.economics, strategy: p.strategy, days: p.days, resas: p.reservations.map((r) => ({ ...r, status: "CONFIRMED" })) };
      const r = reviewProperty(i);
      for (const o of r.opportunities) {
        expect(o.signal, o.title).toBeTruthy();
        expect(playbookOf(o.signal!.playbook)).not.toBeNull();
        expect(o.signal!.measures.length).toBeGreaterThan(0);
      }
      expect(r.signals.length).toBeGreaterThanOrEqual(r.opportunities.length);
    }
  });
});
