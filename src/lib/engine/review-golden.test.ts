import { describe, expect, it } from "vitest";
import { addDays } from "../dates";
import { capabilityFlags } from "../integrations/capabilities";
import { buildDemo } from "./demo";
import { priorityScore, reviewProperty, type EngineInput } from "./detect";

/**
 * Non-régression du moteur de décision (épic 6) : la revue des deux logements de démonstration, à date fixe, est figée dans un fichier.
 * Toute évolution du moteur qui change une opportunité (dates, option retenue, verdict d'audit, urgence, ordre) fait échouer ce test :
 * le changement doit alors être voulu, relu, puis le fichier régénéré (`npx vitest run -u src/lib/engine/review-golden.test.ts`).
 */
function inputFor(key: string, today = "2026-11-12"): EngineInput {
  const p = buildDemo(today).find((x) => x.key === key)!;
  const now = new Date(today + "T07:00:00Z");
  return {
    today, now, property: { id: key, name: p.name, isDemo: true }, model: p.economics, strategy: p.strategy,
    days: p.days, resas: p.reservations.map((r) => ({ ...r, status: "CONFIRMED" })),
    promos: p.promos.map((x, i) => ({
      id: "p" + i, channel: x.channel, kind: x.kind, label: x.label, discountPct: x.discountPct,
      stayFrom: x.fromOffset === null ? null : addDays(today, x.fromOffset), stayTo: x.toOffset === null ? null : addDays(today, x.toOffset),
      verifiedAt: new Date(+now - x.verifiedDaysAgo * 86400000),
    })),
    capabilities: capabilityFlags({ isDemo: true, killSwitch: {} }), activeRanges: [],
  };
}

function digest(key: string) {
  const r = reviewProperty(inputFor(key));
  return r.opportunities.map((o) => ({
    playbook: o.playbook, dedupe: o.dedupe ?? null, reasonCode: o.reasonCode, title: o.title, from: o.stayFrom, to: o.stayTo,
    veto: o.veto, urgency: o.urgency, expiresAt: o.expiresAt, primary: o.diagnosis.primary, confidence: o.diagnosis.confidence,
    score: priorityScore(o), selected: o.selected,
    candidates: o.candidates.map((c) => ({ type: c.type, label: c.label, verdict: c.audit.verdict, risk: c.risk, mode: c.executionMode, nights: c.nightsTouched, delta: c.expectedDeltaCents, rules: c.audit.rules.map((x) => `${x.code}:${x.outcome}`) })),
  }));
}

describe("moteur de décision : non-régression sur les logements de démonstration", () => {
  for (const key of ["chatillon", "evry"]) {
    it(`revue ${key} figée`, async () => {
      await expect(JSON.stringify(digest(key), null, 1) + "\n").toMatchFileSnapshot(`./__golden__/review-${key}.json`);
    });
  }
});
