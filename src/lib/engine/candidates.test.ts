import { describe, expect, it } from "vitest";
import { addDays } from "../dates";
import { capabilityFlags } from "../integrations/capabilities";
import { CANDIDATE_SPECS, candidateIssues, conformOpportunity } from "./candidates";
import { buildDemo } from "./demo";
import { reviewProperty, type EngineInput } from "./detect";
import { PLAYBOOKS } from "./playbooks";
import type { Candidate, CandidateType, DetectedOpportunity } from "./types";

const base = (over: Partial<Candidate> = {}): Candidate => ({
  type: "PRICE_OVERRIDE", label: "Poser un prix", detail: "", agent: "pricing", target: { system: "PRICELABS" },
  parameters: { dates: ["2026-12-01", "2026-12-02"], nightlyCents: 12000, changePct: -5 }, nightsTouched: 2, priceChangePct: -5, current: null, proposed: null,
  expectedDeltaCents: 5000, hypothesis: "h", rollbackPlan: "Retirer le prix daté", executionMode: "API_PRICELABS", risk: "MEDIUM",
  audit: { verdict: "APPROVE", rules: [] }, measurementWindowDays: 7, ...over,
});
const noAction = (): Candidate => base({ type: "NO_ACTION", label: "Ne rien faire", target: { system: "INTERNAL" }, parameters: {}, nightsTouched: 0, priceChangePct: null, executionMode: "NONE", risk: "LOW", expectedDeltaCents: 0, rollbackPlan: "", measurementWindowDays: 7 });

describe("contrat des actions candidates", () => {
  it("chaque type d'action a un contrat", () => {
    const types: CandidateType[] = ["PRICE_OVERRIDE", "MIN_STAY_OVERRIDE", "RULE_EXCLUSION", "BASE_PRICE_CHANGE", "MIN_PRICE_CHANGE", "CHANNEL_PROMO", "PROMO_REMOVAL", "LISTING_AUDIT", "INVESTIGATION", "NO_ACTION"];
    for (const t of types) expect(CANDIDATE_SPECS[t], t).toBeTruthy();
  });
  it("les types permis par le catalogue des playbooks ont tous un contrat", () => {
    for (const p of Object.values(PLAYBOOKS)) for (const t of p.candidates) expect(CANDIDATE_SPECS[t], `${p.code} ${t}`).toBeTruthy();
  });
  it("une candidate conforme n'a aucun écart", () => { expect(candidateIssues(base(), "PB-01")).toEqual([]); });
  it("refuse un type que le playbook ne permet pas", () => {
    expect(candidateIssues(base({ type: "BASE_PRICE_CHANGE", parameters: { dates: ["2026-12-01"], changePct: 5, basePriceCents: 9000 } }), "PB-01").join()).toContain("n'est pas une action permise pour PB-01");
  });
  it("refuse un mauvais système cible ou un mauvais mode d'exécution", () => {
    expect(candidateIssues(base({ target: { system: "BOOKING", channel: "BOOKING" } }), "PB-01").join()).toContain("système cible");
    expect(candidateIssues(base({ executionMode: "INTERNAL" }), "PB-01").join()).toContain("mode d'exécution");
  });
  it("refuse un playbook inconnu, un verdict d'audit manquant et un canal cible incohérent", () => {
    expect(candidateIssues(base(), "PB-99").join()).toContain("playbook inconnu");
    expect(candidateIssues(base({ audit: undefined as any }), "PB-01").join()).toContain("verdict d'audit");
    const promo = base({ type: "CHANNEL_PROMO", target: { system: "BOOKING" }, executionMode: "MANUAL_RUNBOOK", parameters: { kind: "MOBILE", discountPct: 10, label: "O", stayFrom: "2026-12-01", stayTo: "2026-12-05" } });
    expect(candidateIssues(promo, "PB-01").join()).toContain("canal cible");
  });
  it("une promotion à retirer sans libellé reste valide si elle a un identifiant", () => {
    const rm = base({ type: "PROMO_REMOVAL", target: { system: "BOOKING", channel: "BOOKING" }, executionMode: "MANUAL_RUNBOOK", parameters: { promotionId: "p1", promotionLabel: "" } });
    expect(candidateIssues(rm, "PB-05")).toEqual([]);
  });
  it("accepte le repli en procédure manuelle d'une action PriceLabs", () => { expect(candidateIssues(base({ executionMode: "MANUAL_RUNBOOK" }), "PB-01")).toEqual([]); });
  it("refuse les paramètres manquants, mal typés ou hors bornes", () => {
    expect(candidateIssues(base({ parameters: { nightlyCents: 12000 } }), "PB-01").join()).toContain("paramètre dates");
    expect(candidateIssues(base({ parameters: { dates: [], nightlyCents: 12000 } }), "PB-01").join()).toContain("paramètre dates");
    expect(candidateIssues(base({ parameters: { dates: ["01/12/2026"], nightlyCents: 12000 } }), "PB-01").join()).toContain("paramètre dates");
    expect(candidateIssues(base({ parameters: { dates: ["2026-12-01"], nightlyCents: 120.5 } }), "PB-01").join()).toContain("entier attendu");
    expect(candidateIssues(base({ parameters: { dates: ["2026-12-01"], nightlyCents: 0 } }), "PB-01").join()).toContain("au moins 1");
    expect(candidateIssues(base({ parameters: { dates: ["2026-12-01"], nightlyCents: Number.NaN } }), "PB-01").join()).toContain("nombre attendu");
  });
  it("une promotion de canal borne sa remise", () => {
    const promo = (d: number) => base({ type: "CHANNEL_PROMO", target: { system: "BOOKING", channel: "BOOKING" }, executionMode: "MANUAL_RUNBOOK", parameters: { kind: "MOBILE", discountPct: d, label: "Offre", stayFrom: "2026-12-01", stayTo: "2026-12-05" } });
    expect(candidateIssues(promo(10), "PB-01")).toEqual([]);
    expect(candidateIssues(promo(55), "PB-01").join()).toContain("au plus 40");
    expect(candidateIssues(promo(0), "PB-01").join()).toContain("au moins 1");
  });
  it("une action exécutable exige retour arrière, fenêtre de mesure et nuits touchées", () => {
    expect(candidateIssues(base({ rollbackPlan: " " }), "PB-01").join()).toContain("retour arrière");
    expect(candidateIssues(base({ measurementWindowDays: 0 }), "PB-01").join()).toContain("fenêtre de mesure");
    expect(candidateIssues(base({ nightsTouched: 0 }), "PB-01").join()).toContain("au moins une nuit");
  });
  it("« ne rien faire » ne touche aucune nuit et n'a pas besoin de retour arrière", () => {
    expect(candidateIssues(noAction(), "PB-01")).toEqual([]);
    expect(candidateIssues({ ...noAction(), nightsTouched: 3 }, "PB-01").join()).toContain("aucune nuit");
  });
});

describe("conformité d'un dossier", () => {
  const opp = (cands: Candidate[], selected: number): DetectedOpportunity => ({ playbook: "PB-01", title: "Dossier test", candidates: cands, selected } as unknown as DetectedOpportunity);
  it("un dossier conforme est rendu tel quel", () => {
    const o = opp([base(), noAction()], 0);
    const r = conformOpportunity(o);
    expect(r.opportunity).toBe(o);
    expect(r.issues).toEqual([]);
  });
  it("retire la candidate non conforme et garde l'option retenue quand elle est conforme", () => {
    const bad = base({ label: "Mauvaise", rollbackPlan: "" });
    const r = conformOpportunity(opp([bad, base({ label: "Bonne" }), noAction()], 1));
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].candidate).toBe("Mauvaise");
    expect(r.opportunity!.candidates.map((c) => c.label)).toEqual(["Bonne", "Ne rien faire"]);
    expect(r.opportunity!.candidates[r.opportunity!.selected].label).toBe("Bonne");
  });
  it("si l'option retenue est retirée, on retient « ne rien faire »", () => {
    const r = conformOpportunity(opp([base({ rollbackPlan: "" }), base({ label: "Autre" }), noAction()], 0));
    expect(r.opportunity!.candidates[r.opportunity!.selected].type).toBe("NO_ACTION");
  });
  it("un dossier sous veto n'est jamais écarté en silence", () => {
    const o = { ...opp([base({ rollbackPlan: "" })], 0), veto: true } as DetectedOpportunity;
    const r = conformOpportunity(o);
    expect(r.opportunity).toBe(o);
    expect(r.issues).toHaveLength(1);
  });
  it("sans « ne rien faire », le repli évite une candidate rejetée par l'auditeur", () => {
    const rejected = base({ label: "Rejetée", audit: { verdict: "REJECT", rules: [] } });
    const r = conformOpportunity(opp([base({ label: "Retirée", rollbackPlan: "" }), rejected, base({ label: "Valide" })], 0));
    expect(r.opportunity!.candidates[r.opportunity!.selected].label).toBe("Valide");
  });
  it("sans aucune candidate conforme, le dossier n'est pas proposé", () => {
    const r = conformOpportunity(opp([base({ rollbackPlan: "" })], 0));
    expect(r.opportunity).toBeNull();
    expect(r.issues).toHaveLength(1);
  });
});

const seen = { playbooks: new Set<string>(), types: new Set<string>(), total: 0 };
describe("le moteur ne produit que des candidates conformes", () => {
  for (const day of ["2026-11-12", "2026-03-15", "2026-07-10"]) for (const key of ["chatillon", "evry"]) for (const isDemo of [true, false]) {
    it(`${key} au ${day}${isDemo ? " (démonstration, écriture simulée)" : " (réel, sans écriture, majorations)"}`, () => {
      const p = buildDemo(day).find((x) => x.key === key)!; const now = new Date(day + "T07:00:00Z");
      const i: EngineInput = {
        today: day, now, property: { id: "p", name: p.name, isDemo }, model: p.economics, strategy: p.strategy, days: p.days, resas: p.reservations.map((r) => ({ ...r, status: "CONFIRMED" })),
        promos: p.promos.map((x, k) => ({ id: "p" + k, channel: x.channel, kind: x.kind, label: x.label, discountPct: x.discountPct, stayFrom: x.fromOffset === null ? null : addDays(day, x.fromOffset), stayTo: x.toOffset === null ? null : addDays(day, x.toOffset), verifiedAt: new Date(+now - x.verifiedDaysAgo * 86400000) })),
        capabilities: capabilityFlags({ isDemo, killSwitch: {} }), activeRanges: [], markups: isDemo ? undefined : { AIRBNB: 23, BOOKING: 0 },
      };
      const r = reviewProperty(i);
      expect(r.conformity).toEqual([]);
      for (const o of r.opportunities) { seen.playbooks.add(o.playbook); for (const c of o.candidates) { seen.types.add(c.type); seen.total++; expect(candidateIssues(c, o.playbook), `${o.playbook} ${c.type}`).toEqual([]); } }
    });
  }
  it("les scénarios couvrent assez de playbooks et de types pour que la vérification compte", () => {
    expect(seen.total).toBeGreaterThan(20);
    for (const pb of ["PB-01", "PB-03", "PB-05", "PB-06"]) expect([...seen.playbooks], pb).toContain(pb);
    for (const t of ["PRICE_OVERRIDE", "CHANNEL_PROMO", "PROMO_REMOVAL", "NO_ACTION"]) expect([...seen.types], t).toContain(t);
  });
});
