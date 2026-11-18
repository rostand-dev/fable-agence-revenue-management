import { describe, expect, it } from "vitest";
import { advance, funnelView, launchBlockers, resumeStep, type FunnelFacts } from "./onboarding";

const base: FunnelFacts = { identityOk: false, superhoteLinked: false, pricelabsLinked: false, economicsMissing: 7, onboarding: null };

describe("parcours de création d'un logement", () => {
  it("reprend à l'étape enregistrée", () => {
    expect(resumeStep({ ...base, identityOk: true, onboarding: { step: "pricelabs" } })).toBe("pricelabs");
  });
  it("sans état enregistré (logement créé avant le funnel), reprend à la première étape incomplète", () => {
    expect(resumeStep(base)).toBe("logement");
    expect(resumeStep({ ...base, identityOk: true })).toBe("superhote");
    expect(resumeStep({ ...base, identityOk: true, superhoteLinked: true, pricelabsLinked: true })).toBe("regles");
  });
  it("une étape reportée n'est pas une étape terminée", () => {
    const f: FunnelFacts = { ...base, identityOk: true, onboarding: { step: "pricelabs", skipped: ["superhote"] } };
    const v = funnelView(f, "pricelabs");
    expect(v.find((s) => s.key === "superhote")!.status).toBe("skipped");
    expect(v.find((s) => s.key === "logement")!.status).toBe("done");
    expect(v.find((s) => s.key === "pricelabs")!.status).toBe("current");
    expect(v.find((s) => s.key === "regles")!.reachable).toBe(false);
  });
  it("une étape reportée puis connectée devient terminée", () => {
    const f: FunnelFacts = { ...base, identityOk: true, superhoteLinked: true, onboarding: { step: "verification", skipped: ["superhote"] } };
    expect(funnelView(f, "verification").find((s) => s.key === "superhote")!.status).toBe("done");
  });
  it("revenir en arrière garde accessibles les étapes déjà atteintes", () => {
    const f: FunnelFacts = { ...base, identityOk: true, onboarding: { step: "regles", skipped: ["superhote", "pricelabs"] } };
    const v = funnelView(f, "logement");
    expect(v.find((s) => s.key === "regles")!.reachable).toBe(true);
    expect(v.find((s) => s.key === "couts")!.reachable).toBe(false);
  });
  it("le lancement est bloqué sans PriceLabs, mais pas sans SuperHote", () => {
    const ready: FunnelFacts = { ...base, identityOk: true, pricelabsLinked: true, economicsMissing: 0 };
    expect(launchBlockers(ready)).toEqual([]);
    expect(launchBlockers({ ...ready, pricelabsLinked: false })).toEqual(["pricelabs"]);
    expect(launchBlockers({ ...ready, economicsMissing: 2 })).toEqual(["couts"]);
  });
  it("continuer valide l'étape et passe à la suivante ; reporter la marque à faire plus tard", () => {
    const now = new Date("2026-11-18T19:00:00Z");
    const a = advance(null, "regles", "next", now);
    expect(a).toMatchObject({ step: "couts", done: ["regles"], skipped: [], savedAt: now.toISOString() });
    const b = advance(advance(null, "logement", "next", now), "superhote", "skip", now);
    expect(b.skipped).toEqual(["superhote"]);
    expect(b.step).toBe("pricelabs");
    const c = advance(b, "superhote", "next", now);
    expect(c.skipped).toEqual([]);
    expect(c.step).toBe("pricelabs");
    expect(advance(c, "couts", "stay", now).step).toBe("couts");
  });
  it("après correction d'une étape antérieure, on revient à l'étape la plus avancée déjà atteinte", () => {
    const atVerif = { step: "verification", reached: "verification", skipped: ["pricelabs"] };
    const back = advance(atVerif, "pricelabs", "next");
    expect(back.step).toBe("verification");
    expect(back.skipped).toEqual([]);
    // « quitter » sur une étape antérieure enregistre cette étape sans oublier le plus loin atteint
    const quit = advance(atVerif, "logement", "stay");
    expect(quit).toMatchObject({ step: "logement", reached: "verification" });
    const f: FunnelFacts = { ...base, identityOk: true, onboarding: quit };
    expect(funnelView(f, "logement").find((s) => s.key === "verification")!.reachable).toBe(true);
  });
  it("garde la question de « Coûts et seuils » où reprendre d'une étape à l'autre", () => {
    expect(advance({ step: "couts", costQ: 4 }, "couts", "stay").costQ).toBe(4);
    expect(advance({ step: "couts", costQ: 4 }, "logement", "next").costQ).toBe(4);
    expect(advance(null, "logement", "next")).not.toHaveProperty("costQ");
  });
});
