import { describe, expect, it } from "vitest";
import { addDays } from "../dates";
import { capabilityFlags } from "../integrations/capabilities";
import { approvalRequirement } from "./approval";
import { buildDemo } from "./demo";
import { reviewProperty, type EngineInput } from "./detect";
import { PLAYBOOKS, threshold } from "./playbooks";
import type { Day, Promo } from "./types";

const TODAY = "2026-11-12";
const NOW = new Date(TODAY + "T07:00:00Z");
const base = buildDemo(TODAY).find((x) => x.key === "chatillon")!;

/** Logement vide face à un marché occupé à 70 %, prix au percentile donné : retard de 70 points sur toutes les fenêtres. */
function scenario(o: { market?: number | null; pctl?: number | null; minStay?: number; lagDays?: number | null; promos?: Promo[]; extra?: Partial<EngineInput> } = {}): EngineInput {
  const days: Day[] = [];
  for (let k = 0; k <= 90; k++) days.push({ date: addDays(TODAY, k), state: "FREE", priceCents: 10000, minStay: o.minStay ?? 2, rule: null, marketOccupancy: o.market === undefined ? 0.7 : o.market, marketAdrCents: 10000, pricePercentile: o.pctl === undefined ? 85 : o.pctl, event: null });
  return {
    today: TODAY, now: NOW, property: { id: "t", name: "Test", isDemo: true }, model: base.economics, strategy: base.strategy, days, resas: [], promos: o.promos ?? [],
    capabilities: capabilityFlags({ isDemo: true, killSwitch: {} }), activeRanges: [],
    lagSince: o.lagDays === undefined ? addDays(TODAY, -30) : o.lagDays === null ? null : addDays(TODAY, -o.lagDays), ...o.extra,
  };
}
const by = (i: EngineInput, p: string) => reviewProperty(i).opportunities.filter((x) => x.playbook === p);

describe("PB-12 · prix de base trop haut, retard durable", () => {
  it("retard suivi depuis 30 jours, prix au 85e percentile, marché occupé : audit retenu, baisse proposée mais non présélectionnée, approbation du propriétaire", () => {
    const [o] = by(scenario(), "PB-12");
    expect(o.reasonCode).toBe("PACE_BELOW_MARKET_PERSISTENT");
    expect(o.candidates.map((c) => c.type)).toEqual(["BASE_PRICE_CHANGE", "LISTING_AUDIT", "NO_ACTION"]);
    expect(o.candidates[o.selected].type).toBe("LISTING_AUDIT");
    const down = o.candidates[0];
    expect(down.parameters).toMatchObject({ changePct: -threshold("PB-12", "stepPct") });
    expect(down.risk).toBe("HIGH");
    expect(o.signals).toMatchObject({ lagSince: addDays(TODAY, -30), persistDays: 30 });
    expect(approvalRequirement(down, "PB-12").commentRequired).toBe(true);
    expect(o.diagnosis.alternatives.map((a) => a.cause)).toContain("VISIBILITY_CONVERSION");
    expect(o.diagnosis.tree.some((s) => s.verdict === "inconnu")).toBe(true);
  });

  it("il remplace PB-01 sur les nuits qu'il prend ; avant la durée minimale, PB-01 reste seul", () => {
    const persistent = reviewProperty(scenario());
    expect(persistent.opportunities.filter((x) => x.playbook === "PB-12")).toHaveLength(1);
    expect(persistent.opportunities.filter((x) => x.playbook === "PB-01")).toHaveLength(0);
    const young = reviewProperty(scenario({ lagDays: 10 }));
    expect(young.opportunities.filter((x) => x.playbook === "PB-12")).toHaveLength(0);
    expect(young.opportunities.filter((x) => x.playbook === "PB-01").length).toBeGreaterThan(0);
  });

  it("borne de durée : 21 jours se déclenchent, 20 non", () => {
    expect(by(scenario({ lagDays: threshold("PB-12", "minPersistDays") }), "PB-12")).toHaveLength(1);
    expect(by(scenario({ lagDays: threshold("PB-12", "minPersistDays") - 1 }), "PB-12")).toHaveLength(0);
  });

  it("durée du retard inconnue : silence (aucune durée inventée)", () => {
    expect(by(scenario({ lagDays: null }), "PB-12")).toHaveLength(0);
    const i = scenario(); delete i.lagSince;
    expect(by(i, "PB-12")).toHaveLength(0);
  });

  it("prix sous le seuil ou position inconnue : PB-12 se tait (PB-01 traite)", () => {
    expect(by(scenario({ pctl: 60 }), "PB-12")).toHaveLength(0);
    expect(by(scenario({ pctl: null }), "PB-12")).toHaveLength(0);
    expect(by(scenario({ pctl: threshold("PB-12", "priceHighPercentile") }), "PB-12")).toHaveLength(1);
  });

  it("marché faible, marché inconnu, séjour minimum restrictif, promotion active : PB-12 se tait", () => {
    expect(by(scenario({ market: 0.2 }), "PB-12")).toHaveLength(0);
    expect(by(scenario({ market: null }), "PB-12")).toHaveLength(0);
    expect(by(scenario({ minStay: 4 }), "PB-12")).toHaveLength(0);
    const promo: Promo = { id: "p", channel: "AIRBNB", kind: "LAST_MINUTE", label: "Dernière minute", discountPct: 10, stayFrom: null, stayTo: null, verifiedAt: NOW };
    expect(by(scenario({ promos: [promo] }), "PB-12")).toHaveLength(0);
  });

  it("action récente en observation sur les dates : silence", () => {
    expect(by(scenario({ extra: { activeRanges: [{ from: TODAY, to: addDays(TODAY, 91) }] } }), "PB-12")).toHaveLength(0);
  });

  it("verrou structurant : la baisse est refusée par l'auditeur, l'audit reste retenu", () => {
    const [o] = by(scenario({ extra: { structuralHold: { reason: "ACTION_ACTIVE", since: addDays(TODAY, -3) } } }), "PB-12");
    expect(o.candidates[0].audit.verdict).toBe("REJECT");
    expect(o.candidates[o.selected].type).toBe("LISTING_AUDIT");
  });

  it("plafond de 7 jours : une baisse déjà approuvée de 12 % bloque un palier de plus", () => {
    const [o] = by(scenario({ extra: { recentBaseChanges: [{ at: addDays(TODAY, -2), changePct: -12 }] } }), "PB-12");
    expect(o.candidates[0].audit.verdict).toBe("REJECT");
  });

  it("le catalogue porte les seuils et le statut actif", () => {
    expect(PLAYBOOKS["PB-12"].status).toBe("IMPLEMENTED");
    expect(Object.keys(PLAYBOOKS["PB-12"].thresholds)).toEqual(["lagGapToleranceDays", "minLagObservations", "strongPersistDays", "strongPercentile", "minPersistDays", "paceGap", "priceHighPercentile", "weakMarketOccupancy", "restrictiveMinStay", "minFreeNights", "stepPct"]);
  });

  it("promotion qui démarre en milieu de fenêtre : silence (pas de baisse sur des nuits déjà remisées)", () => {
    const promo: Promo = { id: "p", channel: "AIRBNB", kind: "LAST_MINUTE", label: "Dernière minute", discountPct: 10, stayFrom: addDays(TODAY, 40), stayTo: addDays(TODAY, 50), verifiedAt: NOW };
    const o = by(scenario({ promos: [promo] }), "PB-12");
    const nights = o.flatMap((x) => x.signals.windows as string[]);
    expect(nights).not.toContain("D31_60");
  });

  it("le dossier porte l'ancienneté d'origine, et PB-01 l'estampille pour le suivant", () => {
    const [young] = by(scenario({ lagDays: 10 }), "PB-01");
    expect(young.signals.lagSince).toBe(addDays(TODAY, -10));
    const first = scenario({ lagDays: null });
    expect(by(first, "PB-01")[0].signals.lagSince).toBe(TODAY);
  });
});
