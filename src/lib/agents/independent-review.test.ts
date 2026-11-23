import { describe, expect, it } from "vitest";
import { applyReview, fromReviewModel, noReview, reviewable, reviewContext, reviewHashOf, reviewPrompt, reviewSchema } from "./independent-review";
import type { Candidate, DetectedOpportunity } from "../engine/types";

const cand = (verdict: "APPROVE" | "REJECT" | "NEEDS_HUMAN", extra: object = {}): Candidate => ({
  type: "PRICE_DATED", label: "Baisse datée", detail: "Prix daté sur 3 nuits", agent: "pricing", target: { system: "PRICELABS" }, parameters: { nightlyCents: 12000 }, nightsTouched: 3, priceChangePct: -8,
  current: null, proposed: null, expectedDeltaCents: 12000, hypothesis: "Hypothèse : 2 nuits supplémentaires vendues", rollbackPlan: "Retirer le prix daté sous 24 h", executionMode: "API_PRICELABS", risk: "LOW",
  audit: { verdict, rules: verdict === "REJECT" ? [{ code: "HARD_FLOOR", label: "x", outcome: "FAIL", detail: "Sous le plancher" }] : [{ code: "SCOPE", label: "x", outcome: "PASS", detail: "ok" }] }, measurementWindowDays: 7, ...extra,
} as unknown as Candidate);
const mk = (c: Candidate) => ({
  stayFrom: "2026-10-03", stayTo: "2026-10-09", signalText: "Occupation de 43 % contre 67 % pour le marché", selected: 0, candidates: [c],
  diagnosis: { evidence: [
    { label: "Occupation du logement", value: "43 %", source: "Calendrier", kind: "fait" },
    { label: "Prix du marché", value: "inconnu", source: "PriceLabs", kind: "fait" },
  ] },
}) as unknown as DetectedOpportunity;
const o = mk(cand("APPROVE"));
const schema = reviewSchema(reviewContext(o));
const issues = (v: unknown) => { const r = schema.safeParse(v); return r.success ? [] : r.error.issues.map((i) => i.message); };
const concern = (reason: string, evidence = ["E2"]) => ({ concern: true, reason, evidence });
const ok = { concern: true, reason: "Le prix du marché est inconnu alors que l'option repose sur lui.", evidence: ["E2"] };

describe("seconde lecture : contrôles (US-073)", () => {
  it("l'invite ne contient ni verdict des règles ni avis d'un autre poste", () => {
    const p = reviewPrompt(mk(cand("NEEDS_HUMAN")));
    expect(p).not.toMatch(/verdict|APPROVE|NEEDS_HUMAN|REJECT|avis|synthèse/i);
    expect(p).toContain("E1 [fait] Occupation du logement");
    expect(p).toContain("C1 Baisse datée");
  });
  it("sans réserve : ni texte ni preuve ; avec réserve : conforme", () => {
    expect(issues({ concern: false, reason: "", evidence: [] })).toEqual([]);
    expect(issues({ concern: false, reason: "Tout va bien.", evidence: [] }).length).toBeGreaterThan(0);
    expect(issues(ok)).toEqual([]);
  });
  it("une réserve cite une preuve existante, sans doublon, et nomme seulement des preuves citées", () => {
    expect(issues(concern(ok.reason, [])).join()).toContain("au moins une preuve");
    expect(issues(concern(ok.reason, ["E9"])).join()).toContain("E9");
    expect(issues(concern(ok.reason, ["E2", "E2"])).join()).toContain("deux fois");
    expect(issues(concern("Le prix du marché inconnu (E1) fragilise l'option relue.", ["E2"])).join()).toContain("E1");
  });
  it("refuse un chiffre inventé, une action proposée, un nombre en lettres, un lien", () => {
    expect(issues(concern("Le prix du marché est inconnu, l'écart de 999 € est suspect.")).join()).toContain("chiffre");
    expect(issues(concern("Il faut baisser le prix du marché pour cette option.")).join()).toContain("aucune action");
    expect(issues(concern("Le prix du marché est inconnu sur cent nuits de cette option.")).join()).toContain("chiffres");
    expect(issues(concern("Le prix du marché est inconnu, voir https://exemple.fr pour cette option.")).join()).toContain("lien");
  });
  it("un chiffre de l'option relue est accepté, y compris un montant en centimes écrit en euros", () => {
    expect(issues(concern("L'écart de 120 € dépend d'un prix du marché inconnu, avec un prix daté de 120 € pour 3 nuits.")).join()).not.toContain("chiffre");
  });
});

describe("seconde lecture : effet (US-073)", () => {
  const rev = (c: Candidate) => fromReviewModel(mk(c), ok, { model: "m", promptVersion: "v1" });
  it("une réserve fait passer une option approuvée à valider, avec la règle INDEPENDENT_REVIEW, sans modifier les entrées", () => {
    const c = cand("APPROVE"); const before = JSON.stringify(c);
    const out = applyReview([c], 0, rev(c));
    expect(out[0].audit.verdict).toBe("NEEDS_HUMAN");
    expect(out[0].audit.rules.at(-1)).toMatchObject({ code: "INDEPENDENT_REVIEW", outcome: "WARN" });
    expect(out[0].audit.humanCodes).toContain("INDEPENDENT_REVIEW");
    expect(out[0].expectedDeltaCents).toBe(12000);
    expect(JSON.stringify(c)).toBe(before);
  });
  it("jamais de levée de veto : une option rejetée reste rejetée, intacte", () => {
    const c = cand("REJECT");
    expect(applyReview([c], 0, rev(c))).toEqual([c]);
    expect(reviewable(mk(c))).toBe(false);
  });
  it("sans réserve, sans modèle, ou pour une autre option : aucun changement ; une réserve n'est appliquée qu'une fois", () => {
    const c = cand("APPROVE");
    expect(applyReview([c], 0, noReview(mk(c)))).toEqual([c]);
    expect(applyReview([c], 0, undefined)).toEqual([c]);
    expect(applyReview([c], 0, { ...rev(c), reviewed: "Autre option" })).toEqual([c]);
    const once = applyReview([c], 0, rev(c));
    expect(applyReview(once, 0, rev(c))[0].audit.rules.filter((r) => r.code === "INDEPENDENT_REVIEW")).toHaveLength(1);
  });
  it("seule une option exécutable non rejetée est relue ; l'empreinte dépend des faits et du prompt", () => {
    expect(reviewable(o)).toBe(true);
    expect(reviewable(mk(cand("APPROVE", { type: "NO_ACTION" })))).toBe(false);
    expect(reviewHashOf(o, "a")).not.toBe(reviewHashOf(o, "b"));
    expect(reviewHashOf(o, "a")).not.toBe(reviewHashOf(mk(cand("APPROVE", { detail: "Prix daté sur 4 nuits" })), "a"));
    // le verdict des règles n'entre pas dans l'empreinte : l'auditeur ne le connaît pas
    expect(reviewHashOf(o, "a")).toBe(reviewHashOf(mk(cand("NEEDS_HUMAN")), "a"));
  });
});
