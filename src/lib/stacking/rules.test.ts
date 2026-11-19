import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { auditCandidate, type AuditContext } from "../engine/audit";
import { buildDemo } from "../engine/demo";
import { reviewProperty, type EngineInput } from "../engine/detect";
import { simulateStack } from "../engine/economics";
import type { Candidate, Promo } from "../engine/types";
import { addDays } from "../dates";
import { capabilityFlags } from "../integrations/capabilities";
import { renderStackingMarkdown } from "./rules-doc";
import { PROMO_KINDS, SOURCES, evaluateStacking, kindsOf, matrix, overlapsWindow, promoKind, ruleFor } from "./rules";

const read = (f: string) => readFileSync(resolve(__dirname, f), "utf8");

describe("registre des règles de cumul", () => {
  it("couvre chaque type de promotion connu du code et rien d'autre", () => {
    expect(PROMO_KINDS.filter((k) => k.channel === "BOOKING").map((k) => k.kind).sort()).toEqual(["COUNTRY", "GENIUS", "LIMITED", "MOBILE"]);
    expect(PROMO_KINDS.filter((k) => k.channel === "AIRBNB").map((k) => k.kind).sort()).toEqual(["CUSTOM", "EARLY_BIRD", "LAST_MINUTE", "LOS", "NEW_LISTING", "TOP_RATED"]);
    for (const k of PROMO_KINDS) expect(promoKind(k.channel, k.kind)).toBe(k);
  });
  it("donne une règle à chaque paire, dans les deux sens, y compris deux promotions du même type", () => {
    for (const ch of ["BOOKING", "AIRBNB"] as const) {
      const n = kindsOf(ch).length;
      expect(matrix(ch)).toHaveLength((n * (n + 1)) / 2);
      for (const a of kindsOf(ch)) for (const b of kindsOf(ch)) {
        expect(ruleFor(ch, a.kind, b.kind).status, `${ch} ${a.kind}/${b.kind}`).toBe(ruleFor(ch, b.kind, a.kind).status);
      }
    }
  });
  it("Airbnb : une seule remise principale s'applique, sauf la remise voyageur très bien noté qui se cumule", () => {
    expect(ruleFor("AIRBNB", "LOS", "LAST_MINUTE").status).toBe("EXCLUSIVE");
    expect(ruleFor("AIRBNB", "CUSTOM", "CUSTOM").status).toBe("EXCLUSIVE");
    expect(ruleFor("AIRBNB", "NEW_LISTING", "EARLY_BIRD").status).toBe("EXCLUSIVE");
    for (const k of ["NEW_LISTING", "CUSTOM", "LOS", "EARLY_BIRD", "LAST_MINUTE"]) expect(ruleFor("AIRBNB", k, "TOP_RATED").status, k).toBe("STACKS");
  });
  it("Booking.com : aucune combinaison n'est établie, rien n'est deviné", () => {
    for (const r of matrix("BOOKING")) expect(r.status, `${r.a}/${r.b}`).toBe("UNKNOWN");
    expect(ruleFor("BOOKING", "GENIUS", "MOBILE").detail).toContain("rate stacking");
  });
  it("un type de promotion absent du registre rend la règle inconnue, sur les deux canaux", () => {
    const r = ruleFor("AIRBNB", "CUSTOM", "FLASH");
    expect(r.status).toBe("UNKNOWN");
    expect(r.detail).toContain("FLASH");
    expect(ruleFor("BOOKING", "GENIUS", "").status).toBe("UNKNOWN");
    // un type d'un canal n'existe pas sur l'autre
    expect(ruleFor("AIRBNB", "GENIUS", "CUSTOM").status).toBe("UNKNOWN");
  });
  it("toute règle établie cite une source officielle, consultée et datée ; une règle inconnue n'en invente pas", () => {
    for (const ch of ["BOOKING", "AIRBNB"] as const) for (const r of matrix(ch)) {
      if (r.status !== "UNKNOWN") { expect(r.source, `${ch} ${r.a}/${r.b}`).not.toBeNull(); }
    }
    for (const s of Object.values(SOURCES)) {
      expect(s.url).toMatch(/^https:\/\/(www\.airbnb\.com|developers\.booking\.com)\//);
      expect(s.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("évaluation du cumul", () => {
  const p = (id: string, kind: string) => ({ id, kind, label: kind });
  it("moins de deux promotions : rien à cumuler, aucune alerte", () => {
    for (const list of [[], [p("a", "GENIUS")]]) {
      const e = evaluateStacking("BOOKING", list);
      expect(e.pairs).toEqual([]); expect(e.needsHuman).toBe(false);
    }
  });
  it("une paire inconnue exige un humain ; trois promotions donnent trois paires", () => {
    const e = evaluateStacking("BOOKING", [p("a", "GENIUS"), p("b", "MOBILE"), p("c", "COUNTRY")]);
    expect(e.pairs).toHaveLength(3);
    expect(e.unknown).toHaveLength(3);
    expect(e.needsHuman).toBe(true);
  });
  it("des paires toutes documentées n'exigent personne", () => {
    const e = evaluateStacking("AIRBNB", [p("a", "CUSTOM"), p("b", "TOP_RATED")]);
    expect(e.needsHuman).toBe(false);
    expect(e.pairs[0].status).toBe("STACKS");
  });
  it("une seule paire inconnue parmi des paires connues suffit", () => {
    const e = evaluateStacking("AIRBNB", [p("a", "CUSTOM"), p("b", "TOP_RATED"), p("c", "FLASH")]);
    expect(e.unknown.map((u) => u.second.kind).sort()).toEqual(["FLASH", "FLASH"]);
    expect(e.needsHuman).toBe(true);
  });
  it("fenêtre de séjour : une promotion permanente est toujours en jeu, une promotion datée seulement si elle recoupe", () => {
    expect(overlapsWindow({ stayFrom: null, stayTo: null }, "2026-12-01", "2026-12-04")).toBe(true);
    expect(overlapsWindow({ stayFrom: "2026-12-04", stayTo: "2026-12-10" }, "2026-12-01", "2026-12-04")).toBe(false);
    expect(overlapsWindow({ stayFrom: "2026-12-03", stayTo: "2026-12-10" }, "2026-12-01", "2026-12-04")).toBe(true);
    expect(overlapsWindow({ stayFrom: "2026-11-20", stayTo: "2026-12-01" }, "2026-12-01", "2026-12-04")).toBe(false);
  });
});

/* ------------------------------------------------------------------ auditeur */
const today = "2026-11-12";
function evryInput(): EngineInput {
  const prop = buildDemo(today).find((x) => x.key === "evry")!;
  const now = new Date(today + "T07:00:00Z");
  return {
    today, now, property: { id: "evry", name: prop.name, isDemo: true }, model: prop.economics, strategy: prop.strategy, days: prop.days,
    resas: prop.reservations.map((r) => ({ ...r, status: "CONFIRMED" })), promos: [], activeRanges: [], capabilities: capabilityFlags({ isDemo: true, killSwitch: {} }),
  };
}
const promo = (id: string, channel: "BOOKING" | "AIRBNB", kind: string, stayFrom: string | null = null, stayTo: string | null = null): Promo => ({ id, channel, kind, label: kind, discountPct: 5, stayFrom, stayTo, verifiedAt: new Date(today + "T06:00:00Z") });

function audit(type: Candidate["type"], channel: "BOOKING" | "AIRBNB", kind: string, active: Promo[], priceChangePct: number | null = null, opts: { pricelabs?: boolean; stale?: ("BOOKING" | "AIRBNB")[] } = {}) {
  const i = evryInput();
  const st = simulateStack({ model: i.model, channel, nights: 3, publishedNightlyCents: 25000 });
  const draft: Omit<Candidate, "audit"> = {
    type, label: "Option", detail: "", agent: "distribution", target: opts.pricelabs ? { system: "PRICELABS" } : { system: channel, channel }, parameters: { kind, discountPct: 5, label: kind },
    nightsTouched: 3, priceChangePct, current: st, proposed: st, expectedDeltaCents: 0, hypothesis: "", rollbackPlan: "Désactiver la promotion",
    executionMode: "MANUAL_RUNBOOK", risk: "MEDIUM", measurementWindowDays: 7,
  };
  const ctx: AuditContext = { model: i.model, strategy: i.strategy, stalePromoChannels: opts.stale ?? [], conflict: false, demo: true, capabilities: i.capabilities, promos: active, window: { from: "2026-12-01", to: "2026-12-04" } };
  const v = auditCandidate(draft, ctx);
  return { verdict: v.verdict, rule: v.rules.find((r) => r.code === "STACK_RULES") };
}

describe("règle d'audit STACK_RULES (US-003)", () => {
  it("règle de cumul inconnue → NEEDS_HUMAN, avec les deux promotions nommées", () => {
    const r = audit("CHANNEL_PROMO", "BOOKING", "MOBILE", [promo("g", "BOOKING", "GENIUS")]);
    expect(r.rule?.outcome).toBe("WARN");
    expect(r.rule?.detail).toContain("Genius");
    expect(r.rule?.detail).toContain("Tarif mobile");
    expect(r.verdict).toBe("NEEDS_HUMAN");
  });
  it("type de promotion inconnu du registre → NEEDS_HUMAN, même sur Airbnb", () => {
    expect(audit("CHANNEL_PROMO", "AIRBNB", "FLASH", [promo("c", "AIRBNB", "CUSTOM")]).verdict).toBe("NEEDS_HUMAN");
  });
  it("promotion seule sur le canal : rien à cumuler, option approuvable", () => {
    const r = audit("CHANNEL_PROMO", "BOOKING", "MOBILE", []);
    expect(r.rule?.outcome).toBe("PASS");
    expect(r.verdict).toBe("APPROVE");
  });
  it("règle documentée (Airbnb) : pas de blocage", () => {
    expect(audit("CHANNEL_PROMO", "AIRBNB", "EARLY_BIRD", [promo("c", "AIRBNB", "CUSTOM")]).verdict).toBe("APPROVE");
    expect(audit("CHANNEL_PROMO", "AIRBNB", "TOP_RATED", [promo("c", "AIRBNB", "LAST_MINUTE")]).rule?.outcome).toBe("PASS");
  });
  it("une promotion datée hors des nuits visées, ou d'un autre canal, n'entre pas en jeu", () => {
    expect(audit("CHANNEL_PROMO", "BOOKING", "MOBILE", [promo("g", "BOOKING", "GENIUS", "2026-12-04", "2026-12-20")]).verdict).toBe("APPROVE");
    expect(audit("CHANNEL_PROMO", "BOOKING", "MOBILE", [promo("c", "AIRBNB", "CUSTOM")]).verdict).toBe("APPROVE");
  });
  it("baisse de prix : contrôlée ; hausse de prix, retrait de promotion ou séjour minimum : pas critiques, donc pas contrôlés", () => {
    const two = [promo("g", "BOOKING", "GENIUS"), promo("m", "BOOKING", "MOBILE")];
    expect(audit("PRICE_OVERRIDE", "BOOKING", "", two, -5).verdict).toBe("NEEDS_HUMAN");
    expect(audit("RULE_EXCLUSION", "BOOKING", "", two, -3).rule?.outcome).toBe("WARN");
    for (const [t, pct] of [["PRICE_OVERRIDE", 5], ["BASE_PRICE_CHANGE", 5], ["PRICE_OVERRIDE", 0], ["PROMO_REMOVAL", null], ["MIN_STAY_OVERRIDE", null]] as const) {
      expect(audit(t, "BOOKING", "", two, pct).rule, `${t} ${pct}`).toBeUndefined();
    }
  });
  it("baisse de prix PriceLabs : tous les canaux du logement sont contrôlés, pas seulement le canal de référence", () => {
    const bookingPair = [promo("g", "BOOKING", "GENIUS"), promo("m", "BOOKING", "MOBILE")];
    const r = audit("PRICE_OVERRIDE", "AIRBNB", "", bookingPair, -5, { pricelabs: true });
    expect(r.rule?.outcome).toBe("WARN");
    expect(r.rule?.detail).toContain("Booking.com");
    expect(r.verdict).toBe("NEEDS_HUMAN");
    expect(audit("PRICE_OVERRIDE", "AIRBNB", "", [], -5, { pricelabs: true }).verdict).toBe("APPROVE");
  });
  it("registre non vérifié récemment : une baisse de prix passe par un humain, même sans paire connue", () => {
    expect(audit("PRICE_OVERRIDE", "BOOKING", "", [promo("g", "BOOKING", "GENIUS")], -5, { pricelabs: true, stale: ["BOOKING"] }).verdict).toBe("NEEDS_HUMAN");
    expect(audit("CHANNEL_PROMO", "AIRBNB", "TOP_RATED", [promo("c", "AIRBNB", "CUSTOM")], null, { stale: ["AIRBNB"] }).rule?.outcome).toBe("WARN");
  });
  it("bornes de fenêtre [from, to[ et promotion permanente combinée à une promotion datée", () => {
    const w = (stayFrom: string | null, stayTo: string | null) => audit("CHANNEL_PROMO", "BOOKING", "MOBILE", [promo("g", "BOOKING", "GENIUS", stayFrom, stayTo)]).verdict;
    expect(w("2026-12-04", "2026-12-09")).toBe("APPROVE"); // commence le jour du départ : exclu
    expect(w("2026-11-25", "2026-12-01")).toBe("APPROVE"); // finit le jour d'arrivée : exclu
    expect(w("2026-12-03", "2026-12-09")).toBe("NEEDS_HUMAN");
    expect(w("2026-11-25", "2026-12-02")).toBe("NEEDS_HUMAN");
    const r = audit("CHANNEL_PROMO", "BOOKING", "MOBILE", [promo("g", "BOOKING", "GENIUS"), promo("l", "BOOKING", "LIMITED", "2026-12-02", "2026-12-06")]);
    expect(r.rule?.detail).toContain("Offre à durée limitée");
  });
  it("la casse d'un type de promotion n'en fait pas un type inconnu", () => {
    expect(ruleFor("AIRBNB", "custom", "early_bird").status).toBe("EXCLUSIVE");
  });
  it("une option sans effet de prix n'est jamais bloquée par ce contrôle", () => {
    const two = [promo("g", "BOOKING", "GENIUS"), promo("m", "BOOKING", "MOBILE")];
    for (const t of ["NO_ACTION", "INVESTIGATION", "LISTING_AUDIT"] as const) expect(audit(t, "BOOKING", "MOBILE", two).rule).toBeUndefined();
  });
  it("un rejet (plancher, plafond de cumul) l'emporte toujours sur une règle inconnue", () => {
    const i = evryInput();
    const st = simulateStack({ model: i.model, channel: "BOOKING", nights: 3, publishedNightlyCents: 25000, promos: [{ label: "A", discountPct: 40 }] });
    const draft: Omit<Candidate, "audit"> = { type: "CHANNEL_PROMO", label: "x", detail: "", agent: "d", target: { system: "BOOKING", channel: "BOOKING" }, parameters: { kind: "MOBILE", discountPct: 40, label: "m" }, nightsTouched: 3, priceChangePct: null, current: st, proposed: st, expectedDeltaCents: 0, hypothesis: "", rollbackPlan: "r", executionMode: "MANUAL_RUNBOOK", risk: "MEDIUM", measurementWindowDays: 7 };
    const v = auditCandidate(draft, { model: i.model, strategy: i.strategy, stalePromoChannels: [], conflict: false, demo: true, capabilities: i.capabilities, promos: [promo("g", "BOOKING", "GENIUS")], window: { from: "2026-12-01", to: "2026-12-04" } });
    expect(v.rules.find((r) => r.code === "STACK_RULES")!.outcome).toBe("WARN");
    expect(v.verdict).toBe("REJECT");
  });
  it("cas dorés de démonstration : aucune promotion à règle de cumul inconnue n'est approuvable", () => {
    for (const key of ["chatillon", "evry"]) {
      const p = buildDemo(today).find((x) => x.key === key)!;
      const now = new Date(today + "T07:00:00Z");
      const input: EngineInput = {
        today, now, property: { id: key, name: p.name, isDemo: true }, model: p.economics, strategy: p.strategy, days: p.days, resas: p.reservations.map((r) => ({ ...r, status: "CONFIRMED" })),
        promos: p.promos.map((x, i) => ({ id: "p" + i, channel: x.channel, kind: x.kind, label: x.label, discountPct: x.discountPct, stayFrom: x.fromOffset === null ? null : addDays(today, x.fromOffset), stayTo: x.toOffset === null ? null : addDays(today, x.toOffset), verifiedAt: new Date(+now - x.verifiedDaysAgo * 86400000) })),
        capabilities: capabilityFlags({ isDemo: true, killSwitch: {} }), activeRanges: [],
      };
      let seen = 0;
      for (const o of reviewProperty(input).opportunities) for (const c of o.candidates) {
        const r = c.audit.rules.find((x) => x.code === "STACK_RULES");
        if (r?.outcome === "WARN") { seen++; expect(c.audit.verdict, `${key} ${o.playbook} ${c.type}`).not.toBe("APPROVE"); }
      }
      if (key === "chatillon") expect(seen, "Châtillon : Genius + tarif par pays, sans règle établie").toBeGreaterThan(0);
    }
  });
});

describe("documentation générée", () => {
  it("garde docs/regles-de-cumul.md synchronisé (npm run docs:stacking)", () => {
    const committed = read("../../../docs/regles-de-cumul.md");
    expect(committed.replace(/\r\n/g, "\n"), "Le document est périmé : lancez `npm run docs:stacking` et commitez-le").toBe(renderStackingMarkdown());
  });
});
