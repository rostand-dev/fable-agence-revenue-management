import { describe, expect, it, vi } from "vitest";
import { addDays } from "../dates";
import { HttpPriceLabs, PriceLabsError, retryDelayMs } from "./pricelabs";
import { listingDrift, runConnectionCheck } from "./pricelabs-check";
import { FakePriceLabs } from "./pricelabs-fake";
import { buildScenario, type ScenarioName } from "./pricelabs-scenarios";

const TODAY = "2026-11-21";
const NOW = new Date(TODAY + "T10:00:00Z");
const fake = (s: ScenarioName) => new FakePriceLabs(buildScenario(s, TODAY));
const target = (p: FakePriceLabs) => ({ listingId: p.scenario.listings[0].id, pms: p.scenario.listings[0].pms });
const status = (r: Awaited<ReturnType<typeof runConnectionCheck>>, id: string) => r.checks.find((c) => c.id === id)?.status;

describe("test de connexion PriceLabs", () => {
  it("nominal : tout est disponible et les quatre capacités sont connues", async () => {
    const p = fake("nominal");
    const r = await runConnectionCheck(p, target(p), NOW, TODAY);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.status)).toEqual(["OK", "OK", "OK", "OK", "OK", "OK"]);
    expect(r.capabilities).toEqual({ listings: "AVAILABLE", prices: "AVAILABLE", market: "AVAILABLE", reservations: "AVAILABLE" });
    expect(r.adapter).toBe("FAKE");
  });
  it("ne lit qu'un petit échantillon et n'appelle jamais autre chose que des lectures", async () => {
    const p = fake("nominal");
    await runConnectionCheck(p, target(p), NOW, TODAY);
    expect(p.calls.map((c) => c.endpoint)).toEqual(["listings", "prices", "neighborhood", "reservations"]);
    expect(p.calls[1].args.slice(2)).toEqual([TODAY, addDays(TODAY, 6)]);
  });
  it("clé refusée (401) : échec, le reste n'est pas vérifié", async () => {
    const p = fake("unauthorized");
    const r = await runConnectionCheck(p, target(p), NOW, TODAY);
    expect(r.ok).toBe(false);
    expect(status(r, "key")).toBe("FAIL");
    expect(r.checks.slice(1).every((c) => c.status === "SKIPPED")).toBe(true);
    expect(r.capabilities.prices).toBe("UNKNOWN");
    expect(p.calls).toHaveLength(1);
  });
  it("sans annonce rattachée : la clé est validée, le reste attend", async () => {
    const p = fake("nominal");
    const r = await runConnectionCheck(p, null, NOW, TODAY);
    expect(status(r, "key")).toBe("OK");
    expect(r.ok).toBeNull(); // clé valide : ce n'est pas un échec
    expect(status(r, "listing")).toBe("SKIPPED");
    expect(p.calls).toHaveLength(1);
  });
  it("une erreur technique inattendue n'est jamais recopiée telle quelle dans le résultat", async () => {
    const p = fake("nominal");
    p.getPrices = async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:5432 secret"); };
    const r = await runConnectionCheck(p, target(p), NOW, TODAY);
    expect(JSON.stringify(r)).not.toContain("10.0.0.5");
    expect(r.checks.find((c) => c.id === "prices")?.detail).toBe("Erreur technique pendant le test.");
  });
  it("annonce disparue du compte : échec explicite, pas de lecture de prix", async () => {
    const p = fake("nominal");
    const r = await runConnectionCheck(p, { listingId: "autre", pms: "superhote" }, NOW, TODAY);
    expect(status(r, "listing")).toBe("FAIL");
    expect(r.ok).toBe(false);
    expect(p.calls.map((c) => c.endpoint)).toEqual(["listings"]);
  });
  it("marché indisponible : non bloquant, la capacité marché est signalée indisponible", async () => {
    const p = fake("market-down");
    const r = await runConnectionCheck(p, target(p), NOW, TODAY);
    expect(r.ok).toBe(true);
    expect(status(r, "market")).toBe("WARN");
    expect(r.capabilities.market).toBe("UNAVAILABLE");
    expect(r.capabilities.prices).toBe("AVAILABLE");
  });
  it("synchronisation désactivée chez PriceLabs : la grille est refusée avec une explication claire", async () => {
    const p = fake("toggle-off");
    const r = await runConnectionCheck(p, target(p), NOW, TODAY);
    expect(status(r, "prices")).toBe("FAIL");
    expect(r.checks.find((c) => c.id === "prices")?.detail).toContain("désactivée");
    expect(r.ok).toBe(false);
  });
  it("indicateur de synchronisation absent ou faux : avertissement", async () => {
    const p = fake("nominal");
    p.scenario.listings[0].push_enabled = false;
    expect(status(await runConnectionCheck(p, target(p), NOW, TODAY), "sync")).toBe("WARN");
    delete p.scenario.listings[0].push_enabled;
    expect(status(await runConnectionCheck(p, target(p), NOW, TODAY), "sync")).toBe("WARN");
  });
  it("panne de prix : l'essentiel n'est pas disponible", async () => {
    const p = fake("nominal");
    p.scenario.failures = { prices: 500 };
    const r = await runConnectionCheck(p, target(p), NOW, TODAY);
    expect(status(r, "prices")).toBe("FAIL");
    expect(r.ok).toBe(false);
    expect(r.capabilities.prices).toBe("UNAVAILABLE");
  });
  it("réservations en panne : non bloquant", async () => {
    const p = fake("nominal");
    p.scenario.failures = { reservations: 500 };
    const r = await runConnectionCheck(p, target(p), NOW, TODAY);
    expect(status(r, "reservations")).toBe("WARN");
    expect(r.ok).toBe(true);
  });
});

describe("changement de l'annonce rattachée", () => {
  const prev = { name: "Studio", city: "Châtillon", bedrooms: 1 };
  it("rien à signaler tant que rien ne change, ni à la première lecture", () => {
    expect(listingDrift(prev, { ...prev })).toEqual([]);
    expect(listingDrift(null, { name: "X", city: "Y", bedrooms: 3 })).toEqual([]);
  });
  it("décrit chaque écart en clair", () => {
    expect(listingDrift(prev, { name: "Studio", city: "Évry", bedrooms: 2 })).toEqual(["Ville : Châtillon → Évry", "Chambres : 1 → 2"]);
    expect(listingDrift(prev, { name: "Studio rénové", city: "Châtillon", bedrooms: 1 })).toEqual(["Nom : Studio → Studio rénové"]);
    expect(listingDrift(prev, { name: "Studio", city: null as any, bedrooms: null as any }).join(" ")).toContain("inconnu");
  });
});

describe("nouvelle tentative sur panne passagère", () => {
  const ok = () => new Response(JSON.stringify({ listings: [] }), { status: 200 });
  const make = (retries?: number) => { const sleep = vi.fn(async () => {}); return { sleep, port: new HttpPriceLabs("k".repeat(24), { sleep, retries }) }; };
  it("délai : exponentiel, plafonné à 5 s, aligné sur Retry-After", () => {
    expect([0, 1, 2].map((a) => retryDelayMs(a, null))).toEqual([400, 1200, 3600]);
    expect(retryDelayMs(5, null)).toBe(5000);
    expect(retryDelayMs(0, "2")).toBe(2000);
    expect(retryDelayMs(0, "999")).toBe(5000);
    expect(retryDelayMs(0, "demain")).toBe(400);
  });
  it("503 puis succès : une seule attente, résultat renvoyé", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("", { status: 503 })).mockResolvedValueOnce(ok());
    const { port, sleep } = make();
    try { await expect(port.listListings()).resolves.toEqual([]); expect(spy).toHaveBeenCalledTimes(2); expect(sleep).toHaveBeenCalledWith(400); } finally { spy.mockRestore(); }
  });
  it("429 avec Retry-After : l'attente demandée est respectée", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "2" } })).mockResolvedValueOnce(ok());
    const { port, sleep } = make();
    try { await port.listListings(); expect(sleep).toHaveBeenCalledWith(2000); } finally { spy.mockRestore(); }
  });
  it("panne persistante : abandonne après les tentatives prévues avec l'erreur du statut", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 503 }));
    const { port, sleep } = make(2);
    try {
      const err = await port.listListings().catch((e) => e);
      expect(err).toBeInstanceOf(PriceLabsError); expect(err.status).toBe(503);
      expect(spy).toHaveBeenCalledTimes(3); expect(sleep).toHaveBeenCalledTimes(2);
    } finally { spy.mockRestore(); }
  });
  it.each([401, 403, 404, 500])("%i : jamais de nouvelle tentative", async (code) => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: code }));
    const { port, sleep } = make();
    try { await expect(port.listListings()).rejects.toBeInstanceOf(PriceLabsError); expect(spy).toHaveBeenCalledTimes(1); expect(sleep).not.toHaveBeenCalled(); } finally { spy.mockRestore(); }
  });
  it("coupure réseau : retentée, puis rapportée « injoignable »", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce(ok());
    const { port } = make();
    try { await expect(port.listListings()).resolves.toEqual([]); } finally { spy.mockRestore(); }
  });
  it("délai dépassé : pas de nouvelle tentative", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(abort);
    const { port, sleep } = make();
    try { await expect(port.listListings()).rejects.toThrow("à temps"); expect(spy).toHaveBeenCalledTimes(1); expect(sleep).not.toHaveBeenCalled(); } finally { spy.mockRestore(); }
  });
});
