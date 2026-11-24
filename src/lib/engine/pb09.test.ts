import { describe, expect, it } from "vitest";
import { addDays, type ISODate } from "../dates";
import { capabilityFlags } from "../integrations/capabilities";
import { approvalRequirement } from "./approval";
import { buildDemo } from "./demo";
import { conformOpportunity } from "./candidates";
import { reviewProperty, type EngineInput } from "./detect";
import { PLAYBOOKS, threshold } from "./playbooks";
import type { Channel, Day, Promo } from "./types";

const TODAY = "2026-11-12";
const NOW = new Date(TODAY + "T07:00:00Z");
const base = buildDemo(TODAY).find((x) => x.key === "chatillon")!;

/** Marché à l'occupation donnée ; `bookedEvery`/`bookedFor` : motif de nuits réservées (k % bookedEvery < bookedFor) pour tenir le logement au niveau du marché. */
function scenario(o: { market?: number | null; bookedEvery?: number; bookedFor?: number; channels?: Channel[]; promos?: Promo[]; strategyFloor?: boolean } = {}): EngineInput {
  const days: Day[] = [];
  for (let k = 0; k <= 90; k++) {
    const booked = o.bookedEvery ? k % o.bookedEvery < (o.bookedFor ?? 0) : false;
    days.push({ date: addDays(TODAY, k), state: booked ? "BOOKED" : "FREE", priceCents: 10000, minStay: 2, rule: null, marketOccupancy: o.market === undefined ? 0.3 : o.market, marketAdrCents: 10000, pricePercentile: 50, event: null });
  }
  const model = JSON.parse(JSON.stringify(base.economics));
  if (o.channels) for (const c of Object.keys(model.channels)) if (!o.channels.includes(c as Channel)) delete model.channels[c];
  return { today: TODAY, now: NOW, property: { id: "t", name: "Test", isDemo: true }, model, strategy: base.strategy, days, resas: [], promos: o.promos ?? [], capabilities: capabilityFlags({ isDemo: true, killSwitch: {} }), activeRanges: [] };
}
const pb09 = (i: EngineInput) => reviewProperty(i).opportunities.filter((x) => x.playbook === "PB-09");
// 30 % d'occupation réparti : 3 nuits réservées, puis 7 libres
const lowSeason = (extra: Parameters<typeof scenario>[0] = {}) => scenario({ bookedEvery: 10, bookedFor: 3, ...extra });

describe("PB-09 · séjours longs en basse saison", () => {
  it("trou libre de 7 nuits sur un marché creux : dossier avec offre Airbnb 7 nuits, vérification Booking, inaction", () => {
    const os = pb09(lowSeason());
    expect(os).toHaveLength(threshold("PB-09", "maxRuns"));
    const o = os[0];
    expect(o.reasonCode).toBe("LONG_GAP_LOW_SEASON");
    expect(o.candidates.map((c) => c.type)).toEqual(["CHANNEL_PROMO", "INVESTIGATION", "NO_ACTION"]);
    const promo = o.candidates[0];
    expect(promo.parameters).toMatchObject({ kind: "LOS", minLos: 7, discountPct: 10, stayFrom: o.stayFrom, stayTo: o.stayTo });
    expect(promo.target.channel).toBe("AIRBNB");
    expect(o.candidates[1].parameters).toMatchObject({ channel: "BOOKING", subject: "LONG_STAY" });
    expect(o.signal!.measures.map((m) => m.key)).toEqual(["gapNights", "marketOccupancy", "leadDays"]);
    expect(diffDays(o.stayFrom)).toBeGreaterThanOrEqual(threshold("PB-09", "minLeadDays"));
  });
  it("marché peu occupé établi par la donnée : un marché plus occupé ou inconnu ne déclenche rien", () => {
    expect(pb09(lowSeason({ market: 0.6 }))).toHaveLength(0);
    expect(pb09(lowSeason({ market: 0.41 }))).toHaveLength(0);
    expect(pb09(lowSeason({ market: null }))).toHaveLength(0);
  });
  it("trou trop court : six nuits libres ne suffisent pas", () => {
    expect(pb09(scenario({ bookedEvery: 10, bookedFor: 4 }))).toHaveLength(0);
  });
  it("trou de 28 nuits et plus : paliers 7, 14 et 28 nuits ; la remise mensuelle au-delà de 15 % exige un commentaire", () => {
    const i = scenario({ bookedEvery: 100, bookedFor: 9, market: 0.1 }); // 9 premières nuits réservées, le reste libre
    const o = pb09(i)[0];
    const promos = o.candidates.filter((c) => c.type === "CHANNEL_PROMO");
    expect(promos.map((c) => c.parameters.minLos)).toEqual([7, 14, 28]);
    expect(promos.map((c) => c.parameters.discountPct)).toEqual([10, 12, 18]);
    expect(approvalRequirement(promos[0], o.playbook).reasons.join(" ")).not.toContain("durée de séjour");
    const monthly = approvalRequirement(promos[2], o.playbook);
    expect(monthly.commentRequired).toBe(true);
    expect(monthly.reasons.join(" ")).toContain("remise de durée de séjour de 18 %");
    expect(o.signal!.nights).toBe(threshold("PB-09", "maxTargetNights")); // le trou est tronqué à 28 nuits ciblées
  });
  it("une offre de durée de séjour déjà active sur Airbnb : aucune seconde remise du même type, la vérification Booking reste", () => {
    const promo = { id: "p", channel: "AIRBNB", kind: "LOS", label: "Semaine", discountPct: 8, stayFrom: null, stayTo: null, verifiedAt: NOW } as unknown as Promo;
    const o = pb09(lowSeason({ promos: [promo] }))[0];
    expect(o.candidates.map((c) => c.type)).toEqual(["INVESTIGATION", "NO_ACTION"]);
    expect(o.diagnosis.tree.find((s) => s.question.includes("déjà active"))!.verdict).toBe("oui");
  });
  it("Booking seul : aucune remise inventée, seule la vérification manuelle est proposée et retenue", () => {
    const o = pb09(lowSeason({ channels: ["BOOKING"] }))[0];
    expect(o.candidates.map((c) => c.type)).toEqual(["INVESTIGATION", "NO_ACTION"]);
    expect(o.candidates[o.selected].type).toBe("INVESTIGATION");
  });
  it("Airbnb seul : pas de vérification Booking", () => {
    const o = pb09(lowSeason({ channels: ["AIRBNB"] }))[0];
    expect(o.candidates.map((c) => c.type)).toEqual(["CHANNEL_PROMO", "NO_ACTION"]);
  });
  it("PB-01 prioritaire : si le logement est en retard sur son marché, PB-09 se tait (un seul diagnostic à la fois)", () => {
    const r = reviewProperty(scenario({ market: 0.3 })); // tout libre : écart au marché très négatif
    expect(r.opportunities.some((o) => o.playbook === "PB-01")).toBe(true);
    expect(r.opportunities.some((o) => o.playbook === "PB-09")).toBe(false);
  });
  it("l'auditeur rejette une offre qui dépasse le plafond de cumul : une option non rejetée est retenue", () => {
    const i = lowSeason();
    i.strategy = { ...i.strategy, maxDiscountStackPct: 5 };
    const o = pb09(i)[0];
    expect(o.candidates.find((c) => c.type === "CHANNEL_PROMO")!.audit.verdict).toBe("REJECT");
    expect(o.candidates[o.selected].audit.verdict).not.toBe("REJECT");
    expect(o.candidates[o.selected].type).not.toBe("CHANNEL_PROMO");
  });
  it("clé de dédoublonnage stable d'un jour à l'autre : le repos de 14 jours ne peut pas être contourné par le glissement du début du trou", () => {
    // trou réel de J+3 à J+20 : le début passe sous J+8 puis glisse chaque jour ; la fin reste la même
    const at = (offset: number) => {
      const today = addDays(TODAY, offset), i = lowSeason({ market: 0.1 });
      i.today = today; i.now = new Date(today + "T07:00:00Z");
      i.days = i.days.map((d) => ({ ...d, state: (d.date >= addDays(TODAY, 3) && d.date <= addDays(TODAY, 20) ? "FREE" : d.state) as Day["state"] })).filter((d) => d.date >= today);
      return pb09(i).map((o) => o.dedupe);
    };
    const keys = [0, 1, 5].map(at);
    expect(keys[0].length).toBeGreaterThan(0);
    expect(keys[1][0]).toBe(keys[0][0]); expect(keys[2][0]).toBe(keys[0][0]);
    expect(keys[0][0]).toBe(addDays(TODAY, 20));
  });
  it("bornes du délai : un trou qui commence à J+8 est retenu, à J+7 il est écarté, au-delà de J+90 rien", () => {
    // marché creux, logement au niveau du marché (30 % réservé) : ni PB-01 ni PB-02 ne s'en mêlent ; seul le trou testé est forcé libre
    const at = (from: number, to: number) => { const i = lowSeason({ market: 0.1 }); i.days = i.days.map((d) => ({ ...d, state: (d.date >= addDays(TODAY, from) && d.date <= addDays(TODAY, to) ? "FREE" : d.state) as Day["state"] })); return pb09(i); };
    expect(at(8, 20).some((o) => o.stayFrom === addDays(TODAY, 8))).toBe(true);
    expect(at(7, 13).some((o) => o.stayFrom === addDays(TODAY, 7))).toBe(false); // J+7 : avant le délai minimal
    expect(at(7, 20).some((o) => o.stayFrom === addDays(TODAY, 8))).toBe(true);
  });
  it("remise de durée de séjour à 15 % pile : aucun commentaire de ce fait ; 15,5 % en exige un", () => {
    const c = (pct: number) => ({ type: "CHANNEL_PROMO", risk: "LOW", audit: { verdict: "APPROVE", rules: [] }, parameters: { kind: "LOS", discountPct: pct, minLos: 28 } }) as never;
    expect(approvalRequirement(c(15), "PB-09").commentRequired).toBe(false);
    expect(approvalRequirement(c(15.5), "PB-09").commentRequired).toBe(true);
  });
  it("une remise de durée de séjour sans séjour minimal est refusée par le contrat des candidats", () => {
    const o = pb09(lowSeason())[0];
    const bad = { ...o, candidates: [{ ...o.candidates[0], parameters: { ...o.candidates[0].parameters, minLos: undefined } }, o.candidates[2]], selected: 1 };
    const r = conformOpportunity(bad);
    expect(r.issues[0].issues.join(" ")).toContain("minLos");
    expect(r.opportunity!.candidates.map((x) => x.type)).toEqual(["NO_ACTION"]);
  });
  it("Airbnb seul avec une offre de durée de séjour déjà active : aucun dossier réduit à l'inaction", () => {
    const promo = { id: "p", channel: "AIRBNB", kind: "LOS", label: "Semaine", discountPct: 8, stayFrom: null, stayTo: null, verifiedAt: NOW } as unknown as Promo;
    expect(pb09(lowSeason({ channels: ["AIRBNB"], promos: [promo] }))).toHaveLength(0);
  });
  it("nuits traitées par PB-09 marquées : le catalogue annonce PB-09 actif avec son approbateur", () => {
    expect(PLAYBOOKS["PB-09"].status).toBe("IMPLEMENTED");
    expect(PLAYBOOKS["PB-09"].approver).toBe("REVENUE_MANAGER");
  });
});
function diffDays(d: ISODate): number { return Math.round((Date.parse(d) - Date.parse(TODAY)) / 86_400_000); }
