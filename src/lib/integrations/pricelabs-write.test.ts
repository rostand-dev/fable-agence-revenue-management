import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "../dates";
import { HttpPriceLabs, PriceLabsError } from "./pricelabs";
import { FakePriceLabs } from "./pricelabs-fake";
import { startFakePriceLabsServer, type FakeServer } from "./pricelabs-fake-server";
import { buildScenario, type ScenarioName } from "./pricelabs-scenarios";
import { API_WRITE_TYPES, apiWriteSupports, fromUnits, HttpPriceLabsWriter, mapOverride, planWrite, pricelabsWriteEnabled, requestHash, stableJson, toUnits, unwrapOverrides } from "./pricelabs-write";
import { FakePriceLabsWriter } from "./pricelabs-write-fake";
import type { PriceLabsWritePort } from "./pricelabs-write-port";

const TODAY = "2026-11-21";
const D1 = addDays(TODAY, 30), D2 = addDays(TODAY, 31), D3 = addDays(TODAY, 32);

describe("verrou d'environnement", () => {
  it("n'ouvre l'écriture que pour « true »", () => {
    expect(pricelabsWriteEnabled(undefined)).toBe(false);
    for (const v of ["", "false", "0", "1", "yes", "oui", "TRUEE"]) expect(pricelabsWriteEnabled(v), v).toBe(false);
    for (const v of ["true", "TRUE", "  True "]) expect(pricelabsWriteEnabled(v), v).toBe(true);
  });
  it("ne couvre pas le séjour minimum daté sur un logement réel, mais le simule en démonstration", () => {
    expect([...API_WRITE_TYPES].sort()).toEqual(["BASE_PRICE_CHANGE", "MIN_PRICE_CHANGE", "PRICE_OVERRIDE", "RULE_EXCLUSION"]);
    expect(apiWriteSupports("MIN_STAY_OVERRIDE", false)).toBe(false);
    expect(apiWriteSupports("MIN_STAY_OVERRIDE", true)).toBe(true);
    expect(apiWriteSupports("MIN_PRICE_CHANGE", false)).toBe(true);
    expect(apiWriteSupports(undefined, false)).toBe(false);
  });
});

describe("plan d'écriture d'une action", () => {
  it("prix minimum et prix de base : une valeur absolue sur l'annonce", () => {
    expect(planWrite({ type: "MIN_PRICE_CHANGE", parameters: { minPriceCents: 9500 } })).toEqual({ kind: "LISTING_LIMITS", limits: { minCents: 9500 } });
    expect(planWrite({ type: "BASE_PRICE_CHANGE", parameters: { basePriceCents: 12180, changePct: 5, dates: [D1] } })).toEqual({ kind: "LISTING_LIMITS", limits: { baseCents: 12180 } });
  });
  it("refuse un prix cible absent, nul, décimal ou négatif", () => {
    for (const v of [null, undefined, 0, -100, 99.5, "9500"]) {
      expect(planWrite({ type: "MIN_PRICE_CHANGE", parameters: { minPriceCents: v } }).kind, String(v)).toBe("UNSUPPORTED");
      expect(planWrite({ type: "BASE_PRICE_CHANGE", parameters: { basePriceCents: v } }).kind, String(v)).toBe("UNSUPPORTED");
    }
  });
  it("prix daté à prix fixe : une valeur par date, triée, sans doublon", () => {
    const p = planWrite({ type: "PRICE_OVERRIDE", parameters: { nightlyCents: 11000, restoresFloor: true, dates: [D2, D1, D1] } });
    expect(p).toEqual({ kind: "OVERRIDES", items: [{ date: D1, priceCents: 11000 }, { date: D2, priceCents: 11000 }] });
  });
  it("exclusion de règle : prix fixe aussi", () => {
    expect(planWrite({ type: "RULE_EXCLUSION", parameters: { rule: "Dernière minute -10 %", restoresFloor: true, nightlyCents: 9000, dates: [D1] } })).toEqual({ kind: "OVERRIDES", items: [{ date: D1, priceCents: 9000 }] });
  });
  it("variation en % : calculée sur le prix courant relu, arrondie à l'euro, comme la simulation", () => {
    const p = planWrite({ type: "PRICE_OVERRIDE", parameters: { changePct: 5, dates: [D1, D2] } }, { [D1]: 10000, [D2]: 11333 });
    expect(p).toEqual({ kind: "OVERRIDES", items: [{ date: D1, priceCents: 10500 }, { date: D2, priceCents: 11900 }] });
    const down = planWrite({ type: "PRICE_OVERRIDE", parameters: { changePct: -5, dates: [D1] } }, { [D1]: 10000 });
    expect(down).toEqual({ kind: "OVERRIDES", items: [{ date: D1, priceCents: 9500 }] });
  });
  it("applique le plafond et le plancher de la stratégie aux prix calculés en %", () => {
    const up = planWrite({ type: "PRICE_OVERRIDE", parameters: { changePct: 20, dates: [D1] } }, { [D1]: 10000 }, { maxCents: 11000 });
    expect(up).toEqual({ kind: "OVERRIDES", items: [{ date: D1, priceCents: 11000 }] });
    const down = planWrite({ type: "PRICE_OVERRIDE", parameters: { changePct: -30, dates: [D1] } }, { [D1]: 10000 }, { minCents: 8000 });
    expect(down).toEqual({ kind: "OVERRIDES", items: [{ date: D1, priceCents: 8000 }] });
  });
  it("refuse sans écrire dès qu'un prix courant est inconnu ou que les paramètres sont incomplets", () => {
    expect(planWrite({ type: "PRICE_OVERRIDE", parameters: { changePct: 5, dates: [D1, D2] } }, { [D1]: 10000, [D2]: null })).toMatchObject({ kind: "UNSUPPORTED" });
    expect(planWrite({ type: "PRICE_OVERRIDE", parameters: { changePct: 5, dates: [D1] } }, {})).toMatchObject({ kind: "UNSUPPORTED" });
    expect(planWrite({ type: "PRICE_OVERRIDE", parameters: { dates: [D1] } }, { [D1]: 10000 })).toMatchObject({ kind: "UNSUPPORTED" });
    expect(planWrite({ type: "PRICE_OVERRIDE", parameters: { nightlyCents: 9000, restoresFloor: true, dates: [] } })).toMatchObject({ kind: "UNSUPPORTED" });
    expect(planWrite({ type: "RULE_EXCLUSION", parameters: { restoresFloor: true, dates: [D1] } })).toMatchObject({ kind: "UNSUPPORTED" });
  });
  it("refuse plus de 31 dates et tout type non écrit par l'API", () => {
    const many = Array.from({ length: 32 }, (_, i) => addDays(TODAY, i));
    expect(planWrite({ type: "PRICE_OVERRIDE", parameters: { nightlyCents: 9000, restoresFloor: true, dates: many } })).toMatchObject({ kind: "UNSUPPORTED" });
    for (const t of ["MIN_STAY_OVERRIDE", "CHANNEL_PROMO", "NO_ACTION", "INVESTIGATION", ""]) expect(planWrite({ type: t, parameters: { minStay: 2, dates: [D1] } }).kind, t).toBe("UNSUPPORTED");
  });
});

describe("conversions et empreintes", () => {
  it("centimes ↔ unités de l'API", () => {
    expect(toUnits(12250)).toBe(122.5); expect(toUnits(8300)).toBe(83);
    expect(fromUnits("122")).toBe(12200); expect(fromUnits(144)).toBe(14400); expect(fromUnits("99,5")).toBe(9950);
    for (const v of [null, undefined, "", "abc", NaN]) expect(fromUnits(v as any)).toBeNull();
  });
  it("JSON stable : l'ordre des clés ne change pas l'empreinte, une valeur différente la change", () => {
    expect(stableJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(stableJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
    expect(requestHash({ a: 1, b: 2 })).toBe(requestHash({ b: 2, a: 1 }));
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }));
    expect(requestHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
  it("relecture des prix datés : forme interne, dates techniques écartées, entrée illisible refusée", () => {
    const o = mapOverride({ date: "2026-12-01", created_at: "x", updated_at: "y", price: "144", price_type: "fixed", currency: "EUR", min_stay: 5, reason: "r" })!;
    expect(o).toMatchObject({ date: "2026-12-01", priceCents: 14400, priceType: "fixed", minStay: 5 });
    expect(o.raw).toEqual({ date: "2026-12-01", price: "144", price_type: "fixed", currency: "EUR", min_stay: 5, reason: "r" });
    expect(mapOverride({ date: "pas une date" })).toBeNull(); expect(mapOverride(null)).toBeNull();
    expect(unwrapOverrides({ overrides: [{ date: "2026-12-01", price: "10" }, { nope: 1 }] })).toHaveLength(1);
    // échec fermé : pas de liste = erreur, jamais « aucune dérogation »
    for (const bad of [null, {}, { overrides: "x" }, [], "texte"]) expect(() => unwrapOverrides(bad), JSON.stringify(bad)).toThrow(PriceLabsError);
  });
});

// Même contrat sur l'adaptateur en mémoire et sur l'adaptateur HTTP (contre le faux serveur) : ce que l'un fait, l'autre le fait.
let server: FakeServer;
beforeAll(async () => { server = await startFakePriceLabsServer({ now: () => new Date(TODAY + "T10:00:00Z") }); process.env.PRICELABS_API_BASE = server.url; });
afterAll(async () => { delete process.env.PRICELABS_API_BASE; await server.close(); });
let n = 0;
const key = (s: ScenarioName) => `fake-${s}-${String(++n).padStart(8, "0")}`;
type Bench = { writer: PriceLabsWritePort; reader: { listListings: () => Promise<any[]> }; id: string; setFailure?: (status: number, times?: number) => void };
const BENCHES: [string, (s: ScenarioName) => Promise<Bench>][] = [
  ["FAKE (mémoire)", async (s) => { const read = new FakePriceLabs(buildScenario(s, TODAY)); const w = new FakePriceLabsWriter(read); return { writer: w, reader: read, id: (await read.listListings())[0].id, setFailure: (status, times) => { w.failWrites = { status, times }; } }; }],
  ["HTTP (faux serveur)", async (s) => { const k = key(s), reader = new HttpPriceLabs(k, { sleep: async () => {} }); return { writer: new HttpPriceLabsWriter(k, { sleep: async () => {} }), reader, id: (await reader.listListings())[0].id }; }],
];

describe.each(BENCHES)("contrat du port d'écriture PriceLabs : %s", (_l, make) => {
  it("pose le prix minimum et le prix de base, que la lecture retrouve ; le maximum n'est pas touché", async () => {
    const { writer, reader, id } = await make("nominal");
    const r = await writer.setListingLimits(id, "superhote", { minCents: 9500, baseCents: 12000 });
    expect(r).toMatchObject({ method: "POST", endpoint: "/listings", status: 200 });
    expect(r.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await reader.listListings())[0]).toMatchObject({ minCents: 9500, baseCents: 12000, maxCents: 25000 });
  });
  it("pose des prix fixes datés, relus à l'identique (même devise)", async () => {
    const { writer, id } = await make("nominal");
    const r = await writer.setPriceOverrides(id, "superhote", [{ date: D1, priceCents: 11000 }, { date: D2, priceCents: 11250 }], { currency: "EUR", reason: "test" });
    expect(r).toMatchObject({ method: "POST", status: 200 });
    const back = await writer.getOverrides(id, "superhote", D1, D3);
    expect(back.map((o) => [o.date, o.priceCents, o.priceType])).toEqual([[D1, 11000, "fixed"], [D2, 11250, "fixed"]]);
    expect(back[0].raw).toMatchObject({ price: "110", currency: "EUR" });
  });
  it("relire une plage vide donne une liste vide, jamais une erreur", async () => {
    const { writer, id } = await make("nominal");
    expect(await writer.getOverrides(id, "superhote", D1, D3)).toEqual([]);
  });
  it("supprime des prix datés (204) : PriceLabs reprend son calcul", async () => {
    const { writer, id } = await make("nominal");
    await writer.setPriceOverrides(id, "superhote", [{ date: D1, priceCents: 11000 }, { date: D2, priceCents: 11000 }], { currency: null, reason: "test" });
    const r = await writer.deleteOverrides(id, "superhote", [D1]);
    expect(r).toMatchObject({ method: "DELETE", status: 204 });
    expect((await writer.getOverrides(id, "superhote", D1, D3)).map((o) => o.date)).toEqual([D2]);
  });
  it("remet des prix datés relus tels quels (retour arrière d'un prix qui en remplaçait un autre)", async () => {
    const { writer, id } = await make("nominal");
    await writer.setPriceOverrides(id, "superhote", [{ date: D1, priceCents: 11000 }], { currency: "EUR", reason: "avant" });
    const before = await writer.getOverrides(id, "superhote", D1, D1);
    await writer.setPriceOverrides(id, "superhote", [{ date: D1, priceCents: 9000 }], { currency: "EUR", reason: "après" });
    await writer.restoreOverrides(id, "superhote", before);
    expect((await writer.getOverrides(id, "superhote", D1, D1))[0]).toMatchObject({ priceCents: 11000, raw: { reason: "avant" } });
  });
  it("une annonce inconnue est refusée sans rien enregistrer", async () => {
    const { writer } = await make("nominal");
    await expect(writer.setListingLimits("fake-9999", "superhote", { minCents: 9000 })).rejects.toBeInstanceOf(PriceLabsError);
    await expect(writer.setPriceOverrides("fake-9999", "superhote", [{ date: D1, priceCents: 9000 }], { currency: null, reason: "t" })).rejects.toBeInstanceOf(PriceLabsError);
  });
  it("refuse une valeur non positive : tout ou rien", async () => {
    const { writer, id } = await make("nominal");
    await expect(writer.setPriceOverrides(id, "superhote", [{ date: D1, priceCents: 11000 }, { date: D2, priceCents: 0 }], { currency: null, reason: "t" })).rejects.toMatchObject({ status: 400 });
    expect(await writer.getOverrides(id, "superhote", D1, D3)).toEqual([]);
    await expect(writer.setListingLimits(id, "superhote", { minCents: 0 })).rejects.toBeDefined();
  });
});

describe("adaptateur HTTP d'écriture : pannes et sécurité", () => {
  const http = (s: ScenarioName) => { const k = key(s); return { k, writer: new HttpPriceLabsWriter(k, { sleep: async () => {} }), reader: new HttpPriceLabs(k, { sleep: async () => {} }) }; };
  it("clé sans droit d'écriture (403) : message clair, rien de modifié", async () => {
    const { writer, reader } = http("write-forbidden");
    const id = (await reader.listListings())[0].id;
    await expect(writer.setListingLimits(id, "superhote", { minCents: 9500 })).rejects.toMatchObject({ status: 403 });
    expect((await reader.listListings())[0].minCents).toBe(8300);
  });
  it("panne chez PriceLabs (500) : l'écriture échoue, la lecture reste intacte", async () => {
    const { writer, reader } = http("write-down");
    const id = (await reader.listListings())[0].id;
    await expect(writer.setPriceOverrides(id, "superhote", [{ date: D1, priceCents: 9000 }], { currency: null, reason: "t" })).rejects.toMatchObject({ status: 500 });
  });
  it("429 puis succès : reprise automatique, une seule dérogation au final (valeur absolue, donc rejouable)", async () => {
    const { writer, reader, k } = http("write-flaky");
    const id = (await reader.listListings())[0].id;
    server.calls.length = 0;
    await writer.setPriceOverrides(id, "superhote", [{ date: D1, priceCents: 9000 }], { currency: "EUR", reason: "t" });
    const posts = server.calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.status)).toEqual([429, 200]);
    expect((await writer.getOverrides(id, "superhote", D1, D1))).toHaveLength(1);
    expect(k).toBeTruthy();
  });
  it("le reçu ne contient jamais la clé API", async () => {
    const { writer, reader, k } = http("nominal");
    const id = (await reader.listListings())[0].id;
    const r = await writer.setListingLimits(id, "superhote", { minCents: 9500 });
    expect(JSON.stringify(r)).not.toContain(k);
    expect(Object.keys(r).sort()).toEqual(["adapter", "endpoint", "method", "requestHash", "sentAt", "status", "summary"]);
  });
  it("le faux serveur consigne chaque écriture avec write: true, et seulement elles", async () => {
    const { writer, reader } = http("nominal");
    const id = (await reader.listListings())[0].id;
    server.calls.length = 0;
    await writer.getOverrides(id, "superhote", D1, D3);
    expect(server.calls.filter((c) => c.write)).toHaveLength(0);
    await writer.setListingLimits(id, "superhote", { baseCents: 12000 });
    await writer.setPriceOverrides(id, "superhote", [{ date: D1, priceCents: 9000 }], { currency: null, reason: "t" });
    await writer.deleteOverrides(id, "superhote", [D1]);
    expect(server.calls.filter((c) => c.write).map((c) => `${c.method} ${c.path.replace(id, ":id")}`)).toEqual(["POST /listings", "POST /listings/:id/overrides", "DELETE /listings/:id/overrides"]);
  });
  it("l'état écrit est propre à chaque clé : deux clés ne se voient pas", async () => {
    const a = http("nominal"), b = http("nominal");
    const ida = (await a.reader.listListings())[0].id;
    await a.writer.setListingLimits(ida, "superhote", { minCents: 9100 });
    expect((await a.reader.listListings())[0].minCents).toBe(9100);
    expect((await b.reader.listListings())[0].minCents).toBe(8300);
  });
});

describe("adaptateur en mémoire : simulation de pannes", () => {
  it("refuse les N prochaines écritures puis reprend, et consigne chaque appel", async () => {
    const read = new FakePriceLabs(buildScenario("nominal", TODAY)), w = new FakePriceLabsWriter(read);
    const id = (await read.listListings())[0].id;
    w.failWrites = { status: 503, times: 1 };
    await expect(w.setListingLimits(id, "superhote", { minCents: 9000 })).rejects.toMatchObject({ status: 503 });
    await w.setListingLimits(id, "superhote", { minCents: 9000 });
    expect(w.calls.map((c) => c.method)).toEqual(["setListingLimits", "setListingLimits"]);
    expect((await read.listListings())[0].minCents).toBe(9000);
  });
  it("une relecture hors contrat lève une erreur (échec fermé)", async () => {
    const read = new FakePriceLabs(buildScenario("nominal", TODAY)), w = new FakePriceLabsWriter(read);
    w.brokenOverrideRead = true;
    await expect(w.getOverrides("x", "superhote", D1, D2)).rejects.toThrow();
  });
});

describe("l'écriture reste hors de portée des agents et du moteur", () => {
  const SRC = path.join(__dirname, "..");
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = path.join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const sources = (dir: string) => walk(path.join(SRC, dir)).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f));
  it("aucun module d'agent n'importe le client ni le port d'écriture", () => {
    for (const f of sources("agents")) expect(readFileSync(f, "utf8"), f).not.toMatch(/pricelabs-write|services\/pricelabs-write/);
  });
  it("le moteur n'importe que la liste pure des types d'action écrits par l'API", () => {
    for (const f of sources("engine")) for (const m of readFileSync(f, "utf8").matchAll(/from "([^"]*pricelabs-write[^"]*)"/g)) expect(m[1], f).toMatch(/pricelabs-write-types$/);
  });
});
