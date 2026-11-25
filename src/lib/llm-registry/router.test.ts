import { describe, expect, it } from "vitest";
import { CATALOG, type ProviderKey } from "./catalog";
import { PROFILES, profileFor } from "./profiles";
import type { PriceBook } from "./pricebook";
import { route, type Qualification, type RouteInput, type RouteModel } from "./router";

const price = (i: number, o: number) => ({ snapshotId: "snap", price: { inputPerMtok: i, outputPerMtok: o, long: null } });
// prix du plan (USD par million de jetons) : Haiku 1/5, Luna 0.2/1.6, Mistral Small 0.1/0.3, Terra 2/12, Sonnet 3/15
const BOOK: PriceBook = new Map([["claude-haiku-5-5", price(1, 5)], ["gpt-6-luna", price(0.2, 1.6)], ["mistral-small-2603", price(0.1, 0.3)], ["gpt-6.1-terra", price(2, 12)], ["claude-sonnet-5-5", price(3, 15)]]);
const MODELS: RouteModel[] = CATALOG.map((m) => ({ modelId: m.modelId, provider: m.provider, tier: m.tier, routable: true }));
const Q = (ids: string[], score = 0.97): Map<string, Qualification> => new Map(ids.map((id) => [id, { status: "QUALIFIED", score }]));
const ALL = ["claude-haiku-5-5", "gpt-6-luna", "mistral-small-2603", "gpt-6.1-terra", "claude-sonnet-5-5"];

const base = (over: Partial<RouteInput> = {}): RouteInput => ({
  profile: PROFILES["direction.explain_action"], manualModel: null, manualProvider: null,
  ownerProviders: new Set<ProviderKey>(["anthropic", "openai", "mistral"]), ownerModels: {}, models: MODELS, qualifications: Q(ALL), priceBook: BOOK,
  latencyMs: new Map(), defaultModel: "claude-sonnet-5-5", capRemainingUsd: null, ...over,
});
const ids = (r: ReturnType<typeof route>) => r.targets.map((t) => t.modelId);

describe("routeur : le moins cher qui convient", () => {
  it("choisit le moins cher, puis monte de niveau : au plus 3 cibles de niveaux croissants", () => {
    const r = route(base());
    expect(r.reason).toBe("auto_moins_cher");
    expect(ids(r)).toEqual(["mistral-small-2603", "gpt-6.1-terra", "claude-sonnet-5-5"]);
    expect(r.targets.map((t) => t.tier)).toEqual(["eco", "intermediaire", "premium"]);
    expect(r.targets[0].estimatedCostUsd).toBeLessThan(r.targets[2].estimatedCostUsd!);
  });

  it("sans clé OpenAI ni Mistral, seul Anthropic est candidat : Haiku puis Sonnet", () => {
    const r = route(base({ ownerProviders: new Set<ProviderKey>(["anthropic"]) }));
    expect(ids(r)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
  });

  it("jamais de modèle d'un fournisseur sans clé du propriétaire (aucune clé du serveur n'existe)", () => {
    const r = route(base({ ownerProviders: new Set<ProviderKey>() }));
    expect(r.targets).toEqual([]);
    expect(r.reason).toBe("aucune_cle");
    const onlyOpenai = route(base({ ownerProviders: new Set<ProviderKey>(["openai"]) }));
    expect(ids(onlyOpenai).every((id) => id.startsWith("gpt-"))).toBe(true);
  });

  it("le choix manuel gagne toujours : une seule cible, sans montée de niveau, même non qualifié ou plus cher", () => {
    const r = route(base({ manualModel: "claude-sonnet-5-5", manualProvider: "anthropic", qualifications: new Map() }));
    expect(r.reason).toBe("choix_manuel");
    expect(ids(r)).toEqual(["claude-sonnet-5-5"]);
  });

  it("un choix manuel d'un fournisseur sans clé est ignoré (le routeur automatique reprend)", () => {
    const r = route(base({ manualModel: "gpt-6-luna", manualProvider: "openai", ownerProviders: new Set<ProviderKey>(["anthropic"]) }));
    expect(r.reason).toBe("auto_moins_cher");
    expect(ids(r)).not.toContain("gpt-6-luna");
  });

  it("Victor (audit) n'est jamais rétrogradé : seul le niveau premium, aucune montée", () => {
    const r = route(base({ profile: PROFILES["audit.independent_review"], qualifications: Q(ALL) }));
    expect(ids(r)).toEqual(["claude-sonnet-5-5"]);
    // même si les modèles économiques sont qualifiés et moins chers
    const onlyCheap = route(base({ profile: PROFILES["audit.independent_review"], qualifications: Q(["claude-haiku-5-5", "mistral-small-2603"]) }));
    expect(onlyCheap.reason).toBe("demarrage_sans_regression");
    expect(ids(onlyCheap)).toEqual(["claude-sonnet-5-5"]);
  });

  it("le chat : économique, une seule cible, Anthropic seulement", () => {
    const r = route(base({ profile: PROFILES.chat }));
    expect(ids(r)).toEqual(["claude-haiku-5-5"]);
    expect(route(base({ profile: PROFILES.chat, ownerProviders: new Set<ProviderKey>(["openai", "mistral"]), qualifications: Q(ALL) })).targets).toEqual([]);
  });

  it("un modèle sans prix, retiré ou alias (non routable) n'est jamais retenu", () => {
    const models = MODELS.map((m) => (m.modelId === "mistral-small-2603" ? { ...m, routable: false } : m));
    expect(ids(route(base({ models })))).not.toContain("mistral-small-2603");
    const noPrice: PriceBook = new Map([...BOOK].filter(([k]) => k !== "gpt-6-luna"));
    // sans prix dans le livre : le registre l'a déjà écarté ; par prudence le routeur l'ignore aussi
    expect(ids(route(base({ priceBook: noPrice })))).not.toContain("gpt-6-luna");
  });

  it("seuls les modèles QUALIFIÉS sont candidats : un modèle suspendu ou non évalué est écarté", () => {
    const q = Q(["claude-haiku-5-5", "claude-sonnet-5-5"]);
    q.set("mistral-small-2603", { status: "SUSPENDED", score: 0.5 });
    expect(ids(route(base({ qualifications: q })))).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
  });

  it("démarrage sans régression : aucun modèle qualifié = modèle par défaut avec la clé Anthropic du propriétaire", () => {
    const r = route(base({ qualifications: new Map(), defaultModel: "claude-sonnet-5-5" }));
    expect(r.reason).toBe("demarrage_sans_regression");
    expect(r.targets.map((t) => [t.provider, t.modelId])).toEqual([["anthropic", "claude-sonnet-5-5"]]);
    // sans clé Anthropic : pas de repli vers un autre fournisseur, mode déterministe
    const noAnthropic = route(base({ qualifications: new Map(), ownerProviders: new Set<ProviderKey>(["openai"]) }));
    expect(noAnthropic.targets).toEqual([]);
    expect(noAnthropic.reason).toBe("aucun_modele");
  });

  it("démarrage sans régression : le modèle par défaut suspendu ou absent de la liste de la clé n'est pas appelé", () => {
    const susp = new Map<string, Qualification>([["claude-sonnet-5-5", { status: "SUSPENDED", score: 0.5 }]]);
    expect(route(base({ qualifications: susp })).targets).toEqual([]);
    expect(route(base({ qualifications: new Map(), ownerModels: { anthropic: new Set(["claude-haiku-5-5"]) } })).targets).toEqual([]);
  });

  it("le modèle doit être listé par la clé du propriétaire quand sa liste est connue", () => {
    const r = route(base({ ownerModels: { mistral: new Set(["autre-modele"]), openai: new Set(["gpt-6.1-terra"]) } }));
    expect(ids(r)).not.toContain("mistral-small-2603");
    expect(ids(r)).not.toContain("gpt-6-luna");
    expect(ids(r)).toContain("gpt-6.1-terra");
  });

  it("égalité de coût : le plus fiable, puis le plus rapide", () => {
    const book: PriceBook = new Map([...BOOK, ["gpt-6-luna", price(1, 5)]]);
    const a = route(base({ priceBook: book, ownerProviders: new Set<ProviderKey>(["anthropic", "openai"]), qualifications: new Map([...Q(ALL), ["gpt-6-luna", { status: "QUALIFIED" as const, score: 0.99 }]]) }));
    expect(ids(a)[0]).toBe("gpt-6-luna"); // plus fiable (0,99 contre 0,97)
    const b = route(base({ priceBook: book, ownerProviders: new Set<ProviderKey>(["anthropic", "openai"]), latencyMs: new Map([["claude-haiku-5-5", 900], ["gpt-6-luna", 400]]) }));
    expect(ids(b)[0]).toBe("gpt-6-luna"); // même fiabilité : le plus rapide
  });

  it("le risque d'échec compte : un modèle un peu moins cher mais bien moins fiable passe derrière", () => {
    const book: PriceBook = new Map([...BOOK, ["mistral-small-2603", price(0.9, 4.5)]]);
    const q = Q(ALL); q.set("mistral-small-2603", { status: "QUALIFIED", score: 0.95 });
    expect(ids(route(base({ priceBook: book, qualifications: q })))[0]).toBe("gpt-6-luna");
  });

  it("plafond mensuel : plus rien de restant = repli déterministe ; une cible trop chère est écartée", () => {
    const none = route(base({ capRemainingUsd: 0 }));
    expect(none.targets).toEqual([]);
    expect(none.reason).toBe("plafond_mensuel");
    const some = route(base({ capRemainingUsd: 0.002 }));
    expect(ids(some)).toEqual(["mistral-small-2603"]);
    expect(route(base({ manualModel: "claude-sonnet-5-5", manualProvider: "anthropic", capRemainingUsd: 0 })).reason).toBe("plafond_mensuel");
    expect(route(base({ qualifications: new Map(), capRemainingUsd: 0 })).reason).toBe("plafond_mensuel");
  });

  it("un profil par agent à base de modèle", () => {
    expect(profileFor("direction").task).toBe("direction.explain_action");
    expect(profileFor("audit").neverDowngrade).toBe(true);
    expect(profileFor("marche").escalate).toBe(true);
    expect(profileFor("inconnu").task).toBe("direction.explain_action");
    expect(profileFor("direction", "chat").task).toBe("chat");
  });
});
