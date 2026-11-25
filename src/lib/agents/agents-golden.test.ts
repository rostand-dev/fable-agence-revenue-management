import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { addDays } from "../dates";
import { capabilityFlags } from "../integrations/capabilities";
import { buildDemo } from "../engine/demo";
import { reviewProperty, type EngineInput } from "../engine/detect";
import type { Candidate, DetectedOpportunity } from "../engine/types";
import { generateJson, scriptedProvider, type GatewayTarget } from "./gateway";
import { e2eFakeReply } from "./fake-llm-responder";
import { PROMPTS, type PromptId } from "./prompts";
import { analysisContext, analysisPrompt, analysisSchema, deterministicAnalysis, fromModel } from "./market-analysis";
import { deterministicOpinion, fromOpinionModel, opinionContext, opinionPrompt, opinionSchema, ownedOptions, type StrategistId } from "./strategist-opinions";
import { applyReview, fromReviewModel, reviewable, reviewContext, reviewPrompt, reviewSchema } from "./independent-review";

/**
 * US-075 — Golden cases des agents, rejoués en CI SANS réseau ni écriture externe.
 *
 * Les logements de démonstration passent dans le moteur (déterministe), puis chaque agent « répond » par un fournisseur SCRIPTÉ (aucun appel HTTP :
 * `fetch` est piégé). On fige, dans `__golden__/agents-*.json`, ce que chaque agent produit une fois ses garde-fous passés, et la façon dont les
 * sorties fautives (chiffre inventé, action proposée, veto « levé », pièce inconnue…) sont refusées. Toute évolution des prompts, des contrôles ou du
 * moteur qui change ces résultats fait échouer ce test : le changement doit être voulu, relu, puis le fichier régénéré
 * (`npx vitest run -u src/lib/agents/agents-golden.test.ts`).
 */
let fetchCalls = 0;
const ENV_KEYS = ["ANTHROPIC_API_BASE", "OPENAI_API_BASE", "MISTRAL_API_BASE"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeAll(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  vi.stubGlobal("fetch", () => { fetchCalls++; throw new Error("Réseau interdit dans les golden cases des agents."); });
});
afterEach(() => expect(fetchCalls, "un golden case a tenté un appel réseau").toBe(0));
afterAll(() => { vi.unstubAllGlobals(); for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; } });

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

/** Fournisseur scripté : répond comme le faux serveur de modèle des E2E (réponses valides, sans chiffre inventé), sans aucun réseau. */
const target = (respond: (system: string, user: string) => string): GatewayTarget & { provider: ReturnType<typeof scriptedProvider> } =>
  ({ provider: scriptedProvider((req) => respond(req.system, req.user)), apiKey: "cle-de-test", model: "scripte", source: "utilisateur" });
const faithful = (system: string, user: string) => { const r = e2eFakeReply({ system, user, body: {} } as never); return typeof r === "string" ? r : JSON.stringify(r); };

async function ask<T>(prompt: PromptId, user: string, schema: Parameters<typeof generateJson<T>>[1]["schema"], respond = faithful) {
  const t = target(respond);
  const r = await generateJson<T>([t], { task: prompt, system: PROMPTS[prompt].system, user, schema, maxTokens: PROMPTS[prompt].maxTokens });
  return { r, calls: t.provider.calls.length };
}

const withoutAudit = (cs: Candidate[]) => cs.map((c) => ({ ...c, audit: undefined }));

async function digest(key: string) {
  const out = [];
  for (const o of reviewProperty(inputFor(key)).opportunities) {
    const before = JSON.stringify({ s: o.selected, c: withoutAudit(o.candidates) });
    const verdictsBefore = o.candidates.map((c) => c.audit.verdict);

    const a = await ask("marche.market_analysis", analysisPrompt(o), analysisSchema(analysisContext(o)));
    const analysis = a.r.ok ? fromModel(o, a.r.data as never, { model: "scripte", promptVersion: PROMPTS["marche.market_analysis"].version }) : deterministicAnalysis(o);

    const opinions: Record<string, unknown> = {};
    for (const agent of ["pricing", "distribution"] as StrategistId[]) {
      if (ownedOptions(o, agent).length === 0) continue;
      const p = await ask(`${agent}.option_opinion` as PromptId, opinionPrompt(o, agent), opinionSchema(opinionContext(o, agent)));
      opinions[agent] = p.r.ok ? fromOpinionModel(o, agent, p.r.data as never, { promptVersion: "x" }).items : { refused: true, fallback: deterministicOpinion(o, agent).items.map((i) => i.stance) };
    }

    let second: unknown = "non relue (option rejetée ou sans écriture)";
    let verdictsAfter = verdictsBefore;
    if (reviewable(o)) {
      const s = await ask("audit.independent_review", reviewPrompt(o), reviewSchema(reviewContext(o)));
      const rev = s.r.ok ? fromReviewModel(o, s.r.data as never, { promptVersion: "x" }) : undefined;
      second = rev ? { concern: rev.concern, reason: rev.reason } : "refusée";
      // une réserve fictive : l'effet sur les verdicts est figé (jamais de levée de veto)
      const forced = fromReviewModel(o, { concern: true, reason: "Les pièces citées ne soutiennent pas clairement l'option retenue.", evidence: ["E1"] }, { promptVersion: "x" });
      verdictsAfter = applyReview(o.candidates, o.selected, forced).map((c) => c.audit.verdict);
    }
    // invariants : ni l'option retenue ni un montant ne bougent, quoi que disent les agents
    expect(JSON.stringify({ s: o.selected, c: withoutAudit(o.candidates) })).toBe(before);
    o.candidates.forEach((c, i) => { if (verdictsBefore[i] === "REJECT") expect(verdictsAfter[i], `${o.title} : un veto a été levé`).toBe("REJECT"); });

    out.push({
      playbook: o.playbook, title: o.title, selected: o.selected,
      analyse: { mode: analysis.mode, constats: analysis.findings.map((f) => ({ texte: f.statement, preuves: f.evidence, confiance: f.confidence })), inconnus: analysis.unknowns },
      avis: opinions, secondeLecture: second, verdictsAvant: verdictsBefore, verdictsApresReserve: verdictsAfter, appels: a.calls,
    });
  }
  return out;
}

describe("agents : golden cases sur les logements de démonstration (scripté, sans réseau)", () => {
  for (const key of ["chatillon", "evry"]) {
    it(`agents ${key} figés`, async () => {
      const d = await digest(key);
      expect(d.length).toBeGreaterThan(0);
      await expect(JSON.stringify(d, null, 1) + "\n").toMatchFileSnapshot(`./__golden__/agents-${key}.json`);
    });
  }
});

// ───────────────────────── Sorties fautives : toujours refusées ─────────────────────────

const cand = (verdict: Candidate["audit"]["verdict"], agent = "pricing", label = "Baisse datée"): Candidate => ({
  type: "PRICE_DATED", label, detail: "Prix daté sur 3 nuits", agent, target: { system: "PRICELABS" }, parameters: { nightlyCents: 12000 }, nightsTouched: 3, priceChangePct: -8,
  current: null, proposed: null, expectedDeltaCents: 12000, hypothesis: "Hypothèse : 2 nuits supplémentaires vendues", rollbackPlan: "Retirer le prix daté sous 24 h", executionMode: "API_PRICELABS", risk: "LOW",
  audit: { verdict, rules: verdict === "REJECT" ? [{ code: "HARD_FLOOR", label: "x", outcome: "FAIL", detail: "Sous le plancher" }] : [] }, measurementWindowDays: 7,
} as unknown as Candidate);
const fixture = (verdict: Candidate["audit"]["verdict"]) => ({
  stayFrom: "2026-10-03", stayTo: "2026-10-09", signalText: "Occupation de 43 % contre 67 % pour le marché", hypothesisText: "Rythme inférieur au marché.", selected: 0, candidates: [cand(verdict)],
  diagnosis: { primary: "DEMAND_WEAK", primaryLabel: "Demande faible", confidence: 0.78, confidenceNote: "", tree: [], alternatives: [{ cause: "PRICE_HIGH", label: "Prix trop haut", why: "Prix au 38e percentile" }],
    evidence: [{ label: "Occupation du logement", value: "43 %", source: "Calendrier", kind: "fait" }, { label: "Prix du marché", value: "inconnu", source: "PriceLabs", kind: "fait" }] },
}) as unknown as DetectedOpportunity;

type Bad = { id: string; prompt: PromptId; verdict: Candidate["audit"]["verdict"]; output: unknown; ctx: (o: DetectedOpportunity) => { user: string; schema: any }; why: RegExp };
const analyst = (o: DetectedOpportunity) => ({ user: analysisPrompt(o), schema: analysisSchema(analysisContext(o)) });
const strat = (o: DetectedOpportunity) => ({ user: opinionPrompt(o, "pricing"), schema: opinionSchema(opinionContext(o, "pricing")) });
const audit = (o: DetectedOpportunity) => ({ user: reviewPrompt(o), schema: reviewSchema(reviewContext(o)) });
const op = (stance: string, rationale = "Option simulée sur 3 nuits, validée par le moteur et son auditeur.") => ({ opinions: [{ option: "O1", stance, rationale, watchpoints: [] }] });
const finding = (statement: string, evidence = ["E1"]) => ({ findings: [{ statement, evidence, confidence: "HAUTE" }], unknowns: [], hypotheses: [] });

const BAD: Bad[] = [
  { id: "analyste : chiffre inventé", prompt: "marche.market_analysis", verdict: "APPROVE", output: finding("L'occupation du logement est de 99 % sur la période."), ctx: analyst, why: /ne figure dans aucune des preuves citées/ },
  { id: "analyste : action proposée", prompt: "marche.market_analysis", verdict: "APPROVE", output: finding("Il faut baisser le prix de la nuit sur la période."), ctx: analyst, why: /ne propose aucune action/ },
  { id: "analyste : preuve inexistante", prompt: "marche.market_analysis", verdict: "APPROVE", output: finding("Les pièces décrivent la situation observée.", ["E42"]), ctx: analyst, why: /E42 n'existe pas/ },
  { id: "analyste : constat sans preuve", prompt: "marche.market_analysis", verdict: "APPROVE", output: finding("Les pièces décrivent la situation observée.", []), ctx: analyst, why: /findings\.0\.evidence/ },
  { id: "analyste : texte non JSON", prompt: "marche.market_analysis", verdict: "APPROVE", output: "Voici mon analyse : tout va bien.", ctx: analyst, why: /Aucun objet JSON/ },
  { id: "stratège : option inventée", prompt: "pricing.option_opinion", verdict: "APPROVE", output: { opinions: [{ ...op("FAVORABLE").opinions[0], option: "O9" }] }, ctx: strat, why: /O9 n'existe pas/ },
  { id: "stratège : montant inventé", prompt: "pricing.option_opinion", verdict: "APPROVE", output: op("FAVORABLE", "Un gain de 987 654 € est attendu sur cette option simulée."), ctx: strat, why: /ne figure dans aucun fait de l'option/ },
  { id: "stratège : autre action proposée", prompt: "pricing.option_opinion", verdict: "APPROVE", output: op("RESERVES", "Il faudrait plutôt ajouter une promotion sur cette option simulée."), ctx: strat, why: /ne propose aucune autre action/ },
  { id: "stratège : option rejetée jugée favorable (veto contourné)", prompt: "pricing.option_opinion", verdict: "REJECT", output: op("FAVORABLE"), ctx: strat, why: /plus favorable que le verdict de l'auditeur/ },
  { id: "stratège : option à valider jugée favorable", prompt: "pricing.option_opinion", verdict: "NEEDS_HUMAN", output: op("FAVORABLE"), ctx: strat, why: /plus favorable que le verdict de l'auditeur/ },
  { id: "auditeur : réserve sans preuve", prompt: "audit.independent_review", verdict: "APPROVE", output: { concern: true, reason: "Les pièces ne soutiennent pas clairement l'option.", evidence: [] }, ctx: audit, why: /au moins une preuve/ },
  { id: "auditeur : chiffre inventé", prompt: "audit.independent_review", verdict: "APPROVE", output: { concern: true, reason: "L'écart de 987 654 € annoncé n'est pas établi par les pièces.", evidence: ["E1"] }, ctx: audit, why: /ne figure dans aucune des preuves citées/ },
  { id: "auditeur : action proposée", prompt: "audit.independent_review", verdict: "APPROVE", output: { concern: true, reason: "Il faut baisser le prix avant d'approuver cette option.", evidence: ["E1"] }, ctx: audit, why: /aucune action/ },
  { id: "auditeur : « sans réserve » avec un texte", prompt: "audit.independent_review", verdict: "APPROVE", output: { concern: false, reason: "Tout va bien.", evidence: [] }, ctx: audit, why: /Sans réserve, ni texte ni preuve/ },
];

describe("agents : les sorties fautives sont refusées, avec une seule correction (golden)", () => {
  it.each(BAD.map((b) => [b.id, b] as const))("%s", async (_id, b) => {
    const o = fixture(b.verdict);
    const c = b.ctx(o);
    const { r, calls } = await ask(b.prompt, c.user, c.schema, () => (typeof b.output === "string" ? b.output : JSON.stringify(b.output)));
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.kind).toBe("INVALID_OUTPUT"); expect(r.message, `${b.id} : refus pour une autre raison`).toMatch(b.why); }
    expect(calls).toBe(2); // l'appel initial et UNE correction, jamais plus
  });

  // Témoins : avec les MÊMES fixtures, une sortie valide passe du premier coup. Sinon les refus ci-dessus pourraient venir d'une fixture cassée.
  it.each([
    ["marche.market_analysis", "APPROVE", analyst, finding("L'occupation du logement est de 43 %, selon la pièce citée.")],
    ["pricing.option_opinion", "APPROVE", strat, op("FAVORABLE")],
    ["pricing.option_opinion", "REJECT", strat, op("DEFAVORABLE")],
    ["audit.independent_review", "APPROVE", audit, { concern: true, reason: "Le prix du marché est inconnu alors que l'option repose sur lui.", evidence: ["E2"] }],
    ["audit.independent_review", "APPROVE", audit, { concern: false, reason: "", evidence: [] }],
  ] as const)("témoin : %s (%s), sortie valide acceptée en un appel", async (prompt, verdict, ctx, output) => {
    const c = ctx(fixture(verdict));
    const { r, calls } = await ask(prompt as PromptId, c.user, c.schema as never, () => JSON.stringify(output));
    expect(r.ok, r.ok ? "" : r.message).toBe(true);
    expect(calls).toBe(1);
  });

  it("un veto n'est jamais levé : une réserve appliquée à une option rejetée ne change rien, et une option approuvée devient « à valider » seulement", () => {
    const rej = fixture("REJECT"), ok = fixture("APPROVE");
    const reserve = (o: DetectedOpportunity) => fromReviewModel(o, { concern: true, reason: "Les pièces citées ne soutiennent pas clairement l'option retenue.", evidence: ["E1"] }, { promptVersion: "x" });
    expect(applyReview(rej.candidates, 0, reserve(rej))[0].audit).toEqual(rej.candidates[0].audit);
    expect(applyReview(ok.candidates, 0, reserve(ok))[0].audit.verdict).toBe("NEEDS_HUMAN");
  });
});
