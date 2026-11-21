import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db, schema } from "@/db";
import { makeProperty, makeTenant } from "@/test/db";
import { addDays } from "../dates";
import { usePriceLabsAdapter } from "../integrations/pricelabs";
import { FakePriceLabs, ReplayPriceLabs } from "../integrations/pricelabs-fake";
import { buildScenario, FAKE_LISTING_ID, type ScenarioName } from "../integrations/pricelabs-scenarios";
import { connectPriceLabs, detachListing, disconnectPriceLabs, selectListing, SyncError, syncPriceLabs, testPriceLabsConnection } from "./pricelabs-sync";
import path from "node:path";

// US-044 : le service de lecture PriceLabs est testé de bout en bout (base réelle) avec le faux adaptateur, sans réseau.
// Ces tests fixent le comportement de la lecture avant les évolutions des US-040 à US-043 : ils servent de filet de non-régression.
const TODAY = "2026-11-21", KEY = "fake-nominal-0000000000000000";
beforeAll(() => { process.env.APP_SECRET = "test-secret-0123456789abcdef"; vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(TODAY + "T10:00:00Z")); });
afterAll(() => { vi.useRealTimers(); });
afterEach(() => usePriceLabsAdapter(null));

const { properties, calendarDays, marketDays, reservations, agentRuns, auditEvents } = schema;
async function setup(label: string, scenario: ScenarioName | FakePriceLabs = "nominal") {
  const t = await makeTenant(label), prop = await makeProperty(t.tenantId, "Logement " + label);
  const fake = typeof scenario === "string" ? new FakePriceLabs(buildScenario(scenario, TODAY)) : scenario;
  usePriceLabsAdapter(() => fake);
  return { t, prop, fake };
}
const link = async (t: { tenantId: string }, prop: string) => { await connectPriceLabs(t.tenantId, prop, KEY, "user:t"); await selectListing(t.tenantId, prop, FAKE_LISTING_ID, "user:t"); };
const getProp = async (id: string) => (await db.select().from(properties).where(eq(properties.id, id)))[0];
const cal = (id: string) => db.select().from(calendarDays).where(eq(calendarDays.propertyId, id)).orderBy(asc(calendarDays.date));
const mkt = (id: string) => db.select().from(marketDays).where(eq(marketDays.propertyId, id)).orderBy(asc(marketDays.date));
const audits = (tenantId: string, type: string) => db.select().from(auditEvents).where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.type, type)));

describe("lecture PriceLabs d'un logement (adaptateur fake)", () => {
  it("connecte la clé sans rattacher d'annonce, puis rattache sur confirmation et lit la grille, le marché et les réservations", async () => {
    const { t, prop, fake } = await setup("nominal");
    const r = await connectPriceLabs(t.tenantId, prop, KEY, "user:t");
    expect(r).toEqual({ listings: 1 });
    let p = await getProp(prop);
    expect(p.pricelabs).toMatchObject({ listingId: null, keyHint: expect.stringContaining("0000") });
    expect(p.pricelabs!.apiKeyEnc).not.toContain(KEY); // chiffrée, jamais en clair
    expect(await cal(prop)).toHaveLength(0); // rien n'est lu avant la confirmation

    await selectListing(t.tenantId, prop, FAKE_LISTING_ID, "user:t");
    p = await getProp(prop);
    expect(p.pricelabs).toMatchObject({ listingId: FAKE_LISTING_ID, pms: "superhote", listingName: "Châtillon (jeu fictif)" });

    const days = await cal(prop);
    expect(days).toHaveLength(91);
    expect(days[0]).toMatchObject({ date: TODAY, state: "FREE" });
    expect(days.filter((d) => d.state === "BOOKED")).toHaveLength(9);
    expect(days.filter((d) => d.state === "BLOCKED").map((d) => d.date)).toEqual([addDays(TODAY, 12), addDays(TODAY, 13)]);
    expect(days.filter((d) => d.state !== "FREE").every((d) => d.priceCents === null)).toBe(true);
    expect(days.filter((d) => d.state === "FREE").every((d) => (d.priceCents ?? 0) >= 8300 && d.recommendedPriceCents === d.priceCents)).toBe(true);

    const market = await mkt(prop);
    expect(market).toHaveLength(91);
    expect(market.every((m) => m.marketOccupancy !== null && m.marketAdrCents !== null)).toBe(true);

    const resas = await db.select().from(reservations).where(eq(reservations.propertyId, prop));
    expect(resas.map((x) => x.status).sort()).toEqual(["CANCELLED", "CONFIRMED", "CONFIRMED", "CONFIRMED"]);
    expect(resas.every((x) => x.source === "PRICELABS")).toBe(true);

    expect(p.pricelabs!.lastSync).toMatchObject({ ok: true, days: 91, reservations: 3, cancelled: 1, ownerBlocks: 0, marketDays: 91, marketCategory: "2", marketListings: 120, marketError: null, priceSource: "PRICELABS", reservationsSource: "PRICELABS", unknownPrices: 0, pushEnabled: true, currency: "EUR" });
    // la stratégie suit les réglages PriceLabs (base, minimum, maximum) et chaque changement est une version tracée
    expect(p.strategy).toMatchObject({ basePriceCents: 11600, minPriceCents: 8300, maxPriceCents: 25000 });
    expect((await audits(t.tenantId, "property.strategy_synced")).length).toBe(1);
    for (const type of ["integration.pricelabs_connected", "integration.pricelabs_listing_linked"]) expect((await audits(t.tenantId, type)).length).toBe(1);
    const runs = await db.select().from(agentRuns).where(eq(agentRuns.tenantId, t.tenantId));
    expect(runs.find((x) => x.operation === "syncPriceLabs")?.summary).toMatch(/PriceLabs lu — 91 jours de grille, 3 réservations/);
    // lecture seule : seules des lectures ont été demandées
    expect(new Set(fake.calls.map((c) => c.endpoint))).toEqual(new Set(["listings", "prices", "neighborhood", "reservations"]));
  });

  it("une seconde lecture est idempotente : mêmes lignes, aucune réservation en double, pas de nouvelle version de stratégie", async () => {
    const { t, prop } = await setup("idem");
    await link(t, prop);
    const before = { cal: await cal(prop), market: await mkt(prop), version: (await getProp(prop)).strategyVersion };
    vi.setSystemTime(new Date(TODAY + "T12:00:00Z"));
    await syncPriceLabs(t.tenantId, prop);
    expect((await cal(prop)).map((d) => [d.date, d.state, d.priceCents])).toEqual(before.cal.map((d) => [d.date, d.state, d.priceCents]));
    expect(await mkt(prop)).toHaveLength(91);
    expect(await db.select().from(reservations).where(eq(reservations.propertyId, prop))).toHaveLength(4);
    expect((await getProp(prop)).strategyVersion).toBe(before.version);
    vi.setSystemTime(new Date(TODAY + "T10:00:00Z"));
  });

  it("rejoue la fixture enregistrée : mêmes résultats que le jeu généré", async () => {
    const fx = ReplayPriceLabs.fromFile(path.join(process.cwd(), "src/test/fixtures/pricelabs/nominal-2026-11-21.json"));
    const { t, prop } = await setup("replay", fx as unknown as FakePriceLabs);
    await link(t, prop);
    expect((await getProp(prop)).pricelabs!.lastSync).toMatchObject({ ok: true, days: 91, reservations: 3, marketDays: 91 });
  });

  it("une lecture en échec garde les données précédentes et consigne l'erreur", async () => {
    const { t, prop, fake } = await setup("keep");
    await link(t, prop);
    fake.scenario.prices[FAKE_LISTING_ID] = { id: FAKE_LISTING_ID, pms: "superhote", error_status: "LISTING_TOGGLE_OFF" };
    await expect(syncPriceLabs(t.tenantId, prop)).rejects.toThrow(/désactivée dans PriceLabs/);
    expect(await cal(prop)).toHaveLength(91); // intactes
    expect((await getProp(prop)).pricelabs!.lastSync).toMatchObject({ ok: false, error: expect.stringContaining("désactivée dans PriceLabs") });
    const failed = (await db.select().from(agentRuns).where(eq(agentRuns.tenantId, t.tenantId))).filter((x) => x.error);
    expect(failed).toHaveLength(1);
  });

  it("une clé refusée (401) interrompt la connexion avec un message lisible, sans rien enregistrer", async () => {
    const { t, prop } = await setup("unauth", "unauthorized");
    await expect(connectPriceLabs(t.tenantId, prop, KEY, "user:t")).rejects.toThrow(/Clé API refusée/);
    expect((await getProp(prop)).pricelabs).toBeNull();
  });

  it("une clé trop courte est refusée avant tout appel à PriceLabs", async () => {
    const { t, prop, fake } = await setup("short");
    await expect(connectPriceLabs(t.tenantId, prop, "court", "user:t")).rejects.toBeInstanceOf(SyncError);
    expect(fake.calls).toHaveLength(0);
  });

  it("une annonce déjà rattachée à un autre logement du même propriétaire est refusée", async () => {
    const { t, prop } = await setup("taken");
    await link(t, prop);
    const other = await makeProperty(t.tenantId, "Autre logement");
    await connectPriceLabs(t.tenantId, other, KEY, "user:t");
    await expect(selectListing(t.tenantId, other, FAKE_LISTING_ID, "user:t")).rejects.toThrow(/déjà rattachée à votre logement/);
  });

  it("un autre propriétaire ne peut pas lire ce logement", async () => {
    const { t, prop } = await setup("owner");
    await link(t, prop);
    const intruder = await makeTenant("intrus");
    await expect(syncPriceLabs(intruder.tenantId, prop)).rejects.toThrow("Logement introuvable.");
    await expect(connectPriceLabs(intruder.tenantId, prop, KEY, "user:x")).rejects.toThrow("Logement introuvable.");
  });

  it("détacher l'annonce conserve la clé et les données lues ; supprimer la clé conserve les données", async () => {
    const { t, prop } = await setup("detach");
    await link(t, prop);
    await detachListing(t.tenantId, prop, "user:t");
    let p = await getProp(prop);
    expect(p.pricelabs).toMatchObject({ listingId: null }); expect(p.pricelabs!.lastSync).toBeUndefined(); expect(p.pricelabs!.apiKeyEnc).toBeTruthy();
    expect(await cal(prop)).toHaveLength(91);
    await disconnectPriceLabs(t.tenantId, prop, "user:t");
    p = await getProp(prop);
    expect(p.pricelabs).toBeNull(); expect(await cal(prop)).toHaveLength(91);
  });

  it("[comportement actuel, modifié par US-042] un marché en panne n'empêche pas la lecture et laisse les signaux de marché inconnus", async () => {
    const { t, prop } = await setup("mktdown", "market-down");
    await link(t, prop);
    const ls = (await getProp(prop)).pricelabs!.lastSync;
    expect(ls).toMatchObject({ ok: true, days: 91, marketDays: 0, marketError: expect.stringContaining("HTTP 500") });
    expect((await mkt(prop)).every((m) => m.marketOccupancy === null)).toBe(true);
  });

  it("une grille partielle (60 jours, prix absents) est lue telle quelle : prix inconnus comptés, jamais zéro", async () => {
    const { t, prop } = await setup("partial", "partial-grid");
    await link(t, prop);
    const ls = (await getProp(prop)).pricelabs!.lastSync;
    expect(ls).toMatchObject({ ok: true, days: 60 });
    expect(ls.unknownPrices).toBeGreaterThan(0);
    expect((await cal(prop)).filter((d) => d.state === "FREE").every((d) => d.priceCents === null || d.priceCents > 0)).toBe(true);
  });
});

describe("US-040 : test de connexion et changements d'annonce", () => {
  it("le test lit un échantillon, mémorise son résultat et ne touche ni la grille, ni le marché, ni les réservations", async () => {
    const { t, prop, fake } = await setup("check-nominal");
    await link(t, prop);
    const before = { cal: await cal(prop), mkt: await mkt(prop), resas: await db.select().from(reservations).where(eq(reservations.propertyId, prop)) };
    const nb = fake.calls.length;
    const r = await testPriceLabsConnection(t.tenantId, prop, "user:t");
    expect(r.ok).toBe(true);
    expect(r.capabilities).toEqual({ listings: "AVAILABLE", prices: "AVAILABLE", market: "AVAILABLE", reservations: "AVAILABLE" });
    expect(fake.calls.length - nb).toBe(4);
    expect((await getProp(prop)).pricelabs!.lastCheck).toMatchObject({ ok: true, adapter: "FAKE" });
    expect({ cal: await cal(prop), mkt: await mkt(prop), resas: await db.select().from(reservations).where(eq(reservations.propertyId, prop)) }).toEqual(before);
    expect((await audits(t.tenantId, "integration.pricelabs_tested")).length).toBe(1);
  });
  it("le résultat du test ne contient jamais la clé API", async () => {
    const { t, prop } = await setup("check-secret");
    await link(t, prop);
    await testPriceLabsConnection(t.tenantId, prop, "user:t");
    expect(JSON.stringify((await getProp(prop)).pricelabs!.lastCheck)).not.toContain(KEY);
  });
  it("un test en échec est mémorisé avec la raison, sans exception", async () => {
    const { t, prop, fake } = await setup("check-fail");
    await link(t, prop);
    fake.scenario.failures = { prices: 500 };
    const r = await testPriceLabsConnection(t.tenantId, prop, "user:t");
    expect(r.ok).toBe(false);
    expect((await getProp(prop)).pricelabs!.lastCheck).toMatchObject({ ok: false });
  });
  it("sans clé enregistrée, le test est refusé clairement", async () => {
    const { t, prop } = await setup("check-nokey");
    await expect(testPriceLabsConnection(t.tenantId, prop, "user:t")).rejects.toBeInstanceOf(SyncError);
  });
  it("un autre locataire ne peut pas tester la connexion de ce logement", async () => {
    const { t, prop } = await setup("check-tenant");
    await link(t, prop);
    const other = await makeTenant("check-tenant-autre");
    await expect(testPriceLabsConnection(other.tenantId, prop, "user:x")).rejects.toThrow();
  });
  it("un changement de ville ou de chambres chez PriceLabs est journalisé et visible dans la lecture", async () => {
    const { t, prop, fake } = await setup("drift");
    await link(t, prop);
    expect((await getProp(prop)).pricelabs!.lastSync.listingChanges).toEqual([]);
    expect((await audits(t.tenantId, "integration.pricelabs_listing_changed")).length).toBe(0);
    fake.scenario.listings[0].city_name = "Évry"; fake.scenario.listings[0].no_of_bedrooms = 3;
    await syncPriceLabs(t.tenantId, prop);
    const p = await getProp(prop);
    expect(p.pricelabs!.lastSync.listingChanges).toEqual(["Ville : Châtillon → Évry", "Chambres : 2 → 3"]);
    expect((await audits(t.tenantId, "integration.pricelabs_listing_changed")).length).toBe(1);
    // relu sans nouveau changement : aucune nouvelle alerte
    await syncPriceLabs(t.tenantId, prop);
    expect((await getProp(prop)).pricelabs!.lastSync.listingChanges).toEqual([]);
    expect((await audits(t.tenantId, "integration.pricelabs_listing_changed")).length).toBe(1);
  });
  it("sans annonce rattachée, le test dit « clé valide » et ne bloque pas", async () => {
    const { t, prop } = await setup("check-unlinked");
    await connectPriceLabs(t.tenantId, prop, KEY, "user:t");
    const r = await testPriceLabsConnection(t.tenantId, prop, "user:t");
    expect(r.ok).toBeNull();
    expect(r.capabilities).toMatchObject({ listings: "AVAILABLE", prices: "UNKNOWN" });
  });
  it("si la clé est supprimée pendant le test, rien n'est ressuscité", async () => {
    const { t, prop, fake } = await setup("check-race");
    await link(t, prop);
    const real = fake.getPrices.bind(fake);
    fake.getPrices = async (...a: Parameters<typeof real>) => { await disconnectPriceLabs(t.tenantId, prop, "user:t"); return real(...a); };
    await expect(testPriceLabsConnection(t.tenantId, prop, "user:t")).rejects.toBeInstanceOf(SyncError);
    expect((await getProp(prop)).pricelabs).toBeNull();
    expect((await audits(t.tenantId, "integration.pricelabs_tested")).length).toBe(0);
  });
  it("le journal du test ne contient jamais la clé", async () => {
    const { t, prop } = await setup("check-audit");
    await link(t, prop);
    await testPriceLabsConnection(t.tenantId, prop, "user:t");
    expect(JSON.stringify(await audits(t.tenantId, "integration.pricelabs_tested"))).not.toContain(KEY);
  });
  it("une relecture qui échoue ne détruit pas le résultat du dernier test", async () => {
    const { t, prop, fake } = await setup("check-keep");
    await link(t, prop);
    await testPriceLabsConnection(t.tenantId, prop, "user:t");
    fake.scenario.failures = { prices: 500 };
    await syncPriceLabs(t.tenantId, prop).catch(() => {});
    expect((await getProp(prop)).pricelabs!.lastCheck).toMatchObject({ ok: true });
  });
});
