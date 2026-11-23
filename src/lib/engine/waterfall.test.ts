import { describe, expect, it } from "vitest";
import { gaugePositions, waterfallGeometry } from "./waterfall";
import type { WaterfallStep } from "./types";

const steps: WaterfallStep[] = [
  { key: "published", label: "Prix publié", cents: 30000, source: "s" },
  { key: "promo", label: "Promotion 10 %", cents: -3000, source: "s" },
  { key: "gross", label: "Prix vendu", cents: 27000, source: "s" },
  { key: "commission", label: "Commission", cents: -4590, source: "s" },
  { key: "fee", label: "Paiement", cents: -378, source: "s" },
  { key: "net", label: "Net", cents: 22032, kind: "net", source: "s" },
  { key: "stay", label: "Ménage", cents: -2000, source: "s" },
  { key: "variable", label: "Coûts variables", cents: -6000, source: "s" },
  { key: "contribution", label: "Contribution", cents: 14032, kind: "final", source: "s" },
];
describe("cascade du revenu net (US-083)", () => {
  it("les mouvements flottent entre cumul avant et après ; les totaux partent de zéro", () => {
    const g = waterfallGeometry(steps);
    const by = Object.fromEntries(g.rows.map((r) => [r.key, r]));
    expect(by.published).toMatchObject({ kind: "total", from: 0, to: 30000 });
    expect(by.promo).toMatchObject({ kind: "down", from: 30000, to: 27000 });
    expect(by.commission).toMatchObject({ from: 27000, to: 22410 });
    expect(by.net).toMatchObject({ kind: "total", from: 0, to: 22032 });
    expect(by.contribution.kind).toBe("final");
  });
  it("se referme sur la contribution et reste dans l'axe 0–100 %", () => {
    const g = waterfallGeometry(steps);
    expect(g.closes).toBe(true);
    for (const r of g.rows) { expect(r.leftPct).toBeGreaterThanOrEqual(0); expect(r.leftPct + r.widthPct).toBeLessThanOrEqual(100.0001); }
  });
  it("une contribution négative étend l'axe sous zéro sans sortir des bornes", () => {
    const g = waterfallGeometry([{ key: "published", label: "P", cents: 10000, source: "" }, { key: "variable", label: "V", cents: -15000, source: "" }, { key: "contribution", label: "C", cents: -5000, kind: "final", source: "" }]);
    expect(g.minCents).toBe(-5000);
    expect(g.zeroPct).toBeGreaterThan(0);
    for (const r of g.rows) { expect(r.leftPct).toBeGreaterThanOrEqual(0); expect(r.leftPct + r.widthPct).toBeLessThanOrEqual(100.0001); }
  });
  it("une cascade qui ne se referme pas est signalée", () => {
    expect(waterfallGeometry([{ key: "published", label: "P", cents: 100, source: "" }, { key: "contribution", label: "C", cents: 50, kind: "final", source: "" }]).closes).toBe(true);
    expect(waterfallGeometry([{ key: "published", label: "P", cents: 100, source: "" }, { key: "commission", label: "C", cents: -10, source: "" }]).closes).toBe(false);
  });
  it("jauge de plancher : repères ordonnés et dans l'axe", () => {
    const g = gaugePositions({ hard: 9000, strategy: 10500, sold: 9800 });
    expect(g.pos.hard).toBeLessThan(g.pos.sold); expect(g.pos.sold).toBeLessThan(g.pos.strategy);
    for (const v of Object.values(g.pos)) { expect(v).toBeGreaterThan(0); expect(v).toBeLessThan(100); }
  });
});
