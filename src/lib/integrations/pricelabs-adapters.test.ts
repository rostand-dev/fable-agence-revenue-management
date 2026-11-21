import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addDays } from "../dates";
import { HttpPriceLabs, PriceLabsError, priceLabsFor, usePriceLabsAdapter } from "./pricelabs";
import { FakePriceLabs, ReplayPriceLabs } from "./pricelabs-fake";
import { startFakePriceLabsServer, type FakeServer } from "./pricelabs-fake-server";
import { mapListing, mapMarket, mapPrices, mapReservations } from "./pricelabs-map";
import type { PriceLabsPort } from "./pricelabs-port";
import { anonymizeScenario } from "./pricelabs-record";
import { buildScenario, FAKE_LISTING_ID, SCENARIO_NAMES, type ScenarioName } from "./pricelabs-scenarios";

// US-044 : une même série de vérifications (« contrat ») passe sur les trois adaptateurs : faux en mémoire, rejeu de fixture, HTTP contre le faux serveur.
const TODAY = "2026-11-21";
const FIXTURE = path.join(process.cwd(), "src/test/fixtures/pricelabs/nominal-2026-11-21.json");
let server: FakeServer;
beforeAll(async () => {
  server = await startFakePriceLabsServer({ now: () => new Date(TODAY + "T10:00:00Z") });
  process.env.PRICELABS_API_BASE = server.url;
});
afterAll(async () => { delete process.env.PRICELABS_API_BASE; await server.close(); });

let n = 0;
const key = (scenario: ScenarioName) => `fake-${scenario}-${String(++n).padStart(8, "0")}`;
type Make = (scenario: ScenarioName) => PriceLabsPort;
/** Le faux serveur suffixe l'identifiant d'annonce par la fin de la clé : on lit l'identifiant au lieu de le supposer. */
const idOf = async (port: PriceLabsPort) => (await port.listListings())[0].id;
const ADAPTERS: [string, Make, ScenarioName[]][] = [
  ["FAKE (mémoire)", (s) => new FakePriceLabs(buildScenario(s, TODAY)), [...SCENARIO_NAMES]],
  ["HTTP (faux serveur)", (s) => new HttpPriceLabs(key(s)), [...SCENARIO_NAMES]],
  // le rejeu ne contient que le scénario nominal : il ne sait pas simuler une panne
  ["REPLAY (fixture)", () => ReplayPriceLabs.fromFile(FIXTURE), ["nominal"]],
];

describe.each(ADAPTERS)("contrat du port PriceLabs : %s", (_label, make, scenarios) => {
  it("lit l'annonce, ses bornes de prix et sa synchronisation", async () => {
    const [l] = await make("nominal").listListings();
    expect(l.id).toMatch(/^fake-1001/);
    expect(l).toMatchObject({ pms: "superhote", bedrooms: 2, currency: "EUR", minCents: 8300, baseCents: 11600, maxCents: 25000, pushEnabled: true });
  });

  it("lit la grille D+0 à D+90 : nuits libres, réservées et bloquées", async () => {
    const port = make("nominal"), id = await idOf(port);
    const item = await port.getPrices(id, "superhote", TODAY, addDays(TODAY, 90));
    const days = mapPrices(item);
    expect(days).toHaveLength(91);
    expect(days[0]).toMatchObject({ date: TODAY, state: "FREE" });
    expect(days.filter((d) => d.state === "BOOKED").map((d) => d.date)).toEqual([addDays(TODAY, 3), addDays(TODAY, 4), addDays(TODAY, 5), ...Array.from({ length: 6 }, (_, i) => addDays(TODAY, 20 + i))]);
    expect(days.filter((d) => d.state === "BLOCKED").map((d) => d.date)).toEqual([addDays(TODAY, 12), addDays(TODAY, 13)]);
    expect(days.filter((d) => d.state === "FREE").every((d) => (d.priceCents ?? 0) >= 8300 && d.minStay !== null)).toBe(true);
  });

  it("ne renvoie que la période demandée", async () => {
    const port = make("nominal"), item = await port.getPrices(await idOf(port), "superhote", addDays(TODAY, 10), addDays(TODAY, 14));
    expect(mapPrices(item).map((d) => d.date)).toEqual([10, 11, 12, 13, 14].map((i) => addDays(TODAY, i)));
  });

  it("lit le marché, indexé par date", async () => {
    const port = make("nominal"), id = await idOf(port);
    const days = mapPrices(await port.getPrices(id, "superhote", TODAY, addDays(TODAY, 90)));
    const m = mapMarket(await port.getNeighborhood(id, "superhote"), 2, days);
    expect(m).toMatchObject({ category: "2", listingsUsed: 120, source: "Nearby Listings" });
    expect(m.market).toHaveLength(91);
    expect(m.market.every((d) => d.marketOccupancy !== null && d.marketAdrCents !== null)).toBe(true);
  });

  it("lit les réservations : deux à venir, une passée, une annulée", async () => {
    const port = make("nominal"), id = await idOf(port);
    const rows = await port.getReservations(id, "superhote", addDays(TODAY, -365), addDays(TODAY, 366));
    const resas = mapReservations(rows, null);
    expect(resas.map((r) => r.status)).toEqual(["CONFIRMED", "CANCELLED", "CONFIRMED", "CONFIRMED"]);
    expect(resas.filter((r) => r.channel === "BOOKING").every((r) => r.commissionCents !== null)).toBe(true);
    // la période de départ filtre sur la date d'arrivée
    expect(await port.getReservations(id, "superhote", TODAY, addDays(TODAY, 10))).toHaveLength(1);
  });

  it("n'expose aucune méthode d'écriture : seulement les quatre lectures", () => {
    const port = make("nominal"), names = new Set<string>();
    for (let o = Object.getPrototypeOf(port); o && o !== Object.prototype; o = Object.getPrototypeOf(o)) for (const m of Object.getOwnPropertyNames(o)) if (m !== "constructor" && typeof (port as any)[m] === "function") names.add(m);
    for (const m of names) expect(m, "méthode publique ou interne du port").toMatch(/^(listListings|getPrices|getNeighborhood|getReservations|call|gate)$/);
    expect([...names].filter((m) => /^(set|put|post|update|apply|delete|create|write|push)/i.test(m))).toEqual([]);
  });

  if (scenarios.length > 1) {
    it.each([["unauthorized", 401], ["forbidden", 403], ["rate-limited", 429]] as [ScenarioName, number][])("scénario %s : l'erreur porte le statut %i et un message lisible", async (name, status) => {
      const err = await make(name).listListings().catch((e) => e);
      expect(err).toBeInstanceOf(PriceLabsError);
      expect(err.status).toBe(status);
      expect(err.message).toMatch(/PriceLabs/);
    });
    it("scénario toggle-off : la synchronisation désactivée est expliquée", async () => {
      const port = make("toggle-off");
      await expect(port.getPrices(await idOf(port), "superhote", TODAY, addDays(TODAY, 90))).rejects.toThrow(/désactivée dans PriceLabs/);
    });
    it("scénario market-down : le marché échoue (500) alors que la grille répond", async () => {
      const port = make("market-down"), id = await idOf(port);
      await expect(port.getNeighborhood(id, "superhote")).rejects.toMatchObject({ status: 500 });
      expect(mapPrices(await port.getPrices(id, "superhote", TODAY, addDays(TODAY, 90)))).toHaveLength(91);
    });
    it("scénario market-sparse : occupation seule, aucun centile, compset étroit", async () => {
      const port = make("market-sparse"), id = await idOf(port), days = mapPrices(await port.getPrices(id, "superhote", TODAY, addDays(TODAY, 90)));
      const m = mapMarket(await port.getNeighborhood(id, "superhote"), 2, days);
      expect(m.listingsUsed).toBe(3);
      expect(m.market.every((d) => d.marketOccupancy !== null && d.marketAdrCents === null && d.pricePercentile === null)).toBe(true);
    });
    it("scénario partial-grid : 60 jours et des prix absents (inconnus, jamais zéro)", async () => {
      const port = make("partial-grid"), days = mapPrices(await port.getPrices(await idOf(port), "superhote", TODAY, addDays(TODAY, 90)));
      expect(days).toHaveLength(60);
      expect(days.filter((d) => d.recommendedPriceCents === null).length).toBe(6);
    });
    it("scénario min-above-base : minimum supérieur au prix de base, tel que PriceLabs le déclare", async () => {
      const [l] = await make("min-above-base").listListings();
      expect(l.minCents).toBe(14000); expect(l.baseCents).toBe(11600);
    });
    it("scénario two-listings : deux annonces sur le compte", async () => {
      expect((await make("two-listings").listListings()).map((l) => l.id.slice(0, 9))).toEqual(["fake-1001", "fake-1002"]);
    });
    it("scénario flaky : la première lecture échoue (503), la suivante réussit", async () => {
      const port = make("flaky");
      await expect(port.listListings()).rejects.toMatchObject({ status: 503 });
      expect(await port.listListings()).toHaveLength(1);
    });
    it("couvre tous les scénarios nommés", async () => {
      for (const s of scenarios) { const sc = buildScenario(s, TODAY); expect(sc.listings.length).toBeGreaterThan(0); expect(JSON.parse(JSON.stringify(sc))).toEqual(sc); } // sérialisable : rejouable
    });
  }
});

describe("faux serveur HTTP PriceLabs", () => {
  const get = (p: string, k: string | null, init: RequestInit = {}) => fetch(server.url + p, { ...init, headers: { ...(k ? { "X-API-Key": k } : {}) } });
  it("refuse une clé inconnue ou absente (401)", async () => {
    expect((await get("/listings", null)).status).toBe(401);
    expect((await get("/listings", "pas-une-cle-fake-000000")).status).toBe(401);
    expect((await get("/listings", "fake-inconnu-00000000")).status).toBe(401);
  });
  it("refuse et consigne toute écriture : méthode autre que GET/POST, ou chemin inconnu", async () => {
    server.calls.length = 0;
    const k = key("nominal");
    expect((await get("/listings", k, { method: "PUT", body: "{}" })).status).toBe(405);
    expect((await get("/listings", k, { method: "DELETE" })).status).toBe(405);
    expect((await get("/listings/fake-1001/prices", k, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await get("/update_listings", k)).status).toBe(404);
    expect(server.calls.filter((c) => c.write)).toHaveLength(4);
  });
  it("un parcours de lecture complet ne consigne aucune tentative d'écriture", async () => {
    server.calls.length = 0;
    const port = new HttpPriceLabs(key("nominal"));
    const id = await idOf(port);
    await port.getPrices(id, "superhote", TODAY, addDays(TODAY, 90)); await port.getNeighborhood(id, "superhote"); await port.getReservations(id, "superhote", addDays(TODAY, -365), addDays(TODAY, 366));
    expect(server.calls.length).toBeGreaterThanOrEqual(4);
    expect(server.calls.filter((c) => c.write)).toHaveLength(0);
    expect(new Set(server.calls.map((c) => c.method))).toEqual(new Set(["GET", "POST"]));
  });
  it("expose /__calls et /__health sans les compter comme appels PriceLabs", async () => {
    server.calls.length = 0;
    expect((await fetch(server.url.replace("/v1", "") + "/__health")).status).toBe(200);
    expect(await (await fetch(server.url.replace("/v1", "") + "/__calls")).json()).toEqual([]);
  });
  it("deux clés désignent deux annonces distinctes (l'identifiant porte le suffixe de la clé)", async () => {
    const [a] = await new HttpPriceLabs("fake-nominal-aaaaaaaa").listListings(), [b] = await new HttpPriceLabs("fake-nominal-bbbbbbbb").listListings();
    expect([a.id, b.id]).toEqual(["fake-1001-aaaaaaaa", "fake-1001-bbbbbbbb"]);
  });
});

describe("adaptateur HTTP : pagination des réservations", () => {
  it("lit toutes les pages et s'arrête quand PriceLabs n'en annonce plus", async () => {
    const rows = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => ({ reservation_id: String(a + i) }));
    const pages = [{ data: rows(0, 100), next_page: true }, { data: rows(100, 130), next_page: false }];
    let i = 0;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(pages[i++]), { status: 200 }));
    try {
      const out = await new HttpPriceLabs("k".repeat(24)).getReservations("1", "p", TODAY, addDays(TODAY, 1));
      expect(out).toHaveLength(130); expect(spy).toHaveBeenCalledTimes(2);
      expect(String(spy.mock.calls[1][0])).toContain("offset=100");
    } finally { spy.mockRestore(); }
  });
  it("traduit une réponse illisible et une coupure réseau en erreurs lisibles", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("pas du json", { status: 200 })).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    try {
      const p = new HttpPriceLabs("k".repeat(24));
      await expect(p.listListings()).rejects.toThrow("Réponse PriceLabs illisible.");
      await expect(p.listListings()).rejects.toThrow("injoignable");
    } finally { spy.mockRestore(); }
  });
});

describe("sélection de l'adaptateur", () => {
  it("par défaut, l'application lit l'API HTTP ; un adaptateur de test peut le remplacer, jamais en production", () => {
    expect(priceLabsFor("k".repeat(24))).toBeInstanceOf(HttpPriceLabs);
    const fake = new FakePriceLabs(buildScenario("nominal", TODAY));
    usePriceLabsAdapter(() => fake);
    try { expect(priceLabsFor("x")).toBe(fake); } finally { usePriceLabsAdapter(null); }
    expect(priceLabsFor("k".repeat(24))).toBeInstanceOf(HttpPriceLabs);
    vi.stubEnv("NODE_ENV", "production");
    try { expect(() => usePriceLabsAdapter(() => fake)).toThrow(/réservé aux tests/); } finally { vi.unstubAllEnvs(); }
  });
  it("la fixture rejouée est refusée si elle n'a pas de jeu de données", () => {
    expect(() => new ReplayPriceLabs({ meta: { recordedAt: "", note: "" } } as any)).toThrow(/Fixture PriceLabs invalide/);
  });
});

describe("enregistreur : anonymisation", () => {
  it("remplace noms, groupes, étiquettes et identifiants de façon cohérente, et garde dates et montants", () => {
    const raw = buildScenario("nominal", TODAY);
    raw.listings[0] = { ...raw.listings[0], id: "REAL-77", name: "Chez Mme Dupont", group: "Clients", tags: ["vip"], notes: "code 1234", latitude: 48.8 };
    raw.prices["REAL-77"] = { ...raw.prices[FAKE_LISTING_ID], id: "REAL-77" }; delete raw.prices[FAKE_LISTING_ID];
    raw.neighborhood["REAL-77"] = raw.neighborhood[FAKE_LISTING_ID]; delete raw.neighborhood[FAKE_LISTING_ID];
    raw.reservations["REAL-77"] = raw.reservations[FAKE_LISTING_ID].map((r) => ({ ...r, listing_id: "REAL-77", guest_name: "Jean" })); delete raw.reservations[FAKE_LISTING_ID];
    const out = anonymizeScenario(raw), text = JSON.stringify(out);
    for (const secret of ["REAL-77", "Dupont", "Clients", "vip", "1234", "Jean"]) expect(text).not.toContain(secret);
    expect(out.listings[0]).toMatchObject({ id: "fake-1001", min: 83, base: 116 });
    expect(Object.keys(out.prices)).toEqual(["fake-1001"]); expect(out.prices["fake-1001"].id).toBe("fake-1001");
    expect(out.reservations["fake-1001"].map((r) => r.reservation_id)).toEqual(["FAKE-R1", "FAKE-R2", "FAKE-R3", "FAKE-R4"]);
    expect(out.reservations["fake-1001"][0].total_cost).toBe(raw.reservations["REAL-77"][0].total_cost);
    expect(mapListing(out.listings[0]).name).toMatch(/anonymisé/);
  });
});
