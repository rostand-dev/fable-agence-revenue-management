import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, schema } from "@/db";
import { withTenant } from "@/db/tenant";
import { makeProperty, makeTenant } from "@/test/db";
import { addDays } from "../dates";
import { usePriceLabsAdapter } from "../integrations/pricelabs";
import { FakePriceLabs } from "../integrations/pricelabs-fake";
import { buildScenario, FAKE_LISTING_ID } from "../integrations/pricelabs-scenarios";
import { connectPriceLabs, selectListing, syncPriceLabs } from "./pricelabs-sync";
import { getSnapshotPayload, getSnapshotState } from "./snapshots";

// US-043 : snapshots immuables, déduplication par empreinte, fraîcheur et lineage des projections.
const TODAY = "2026-11-21", KEY = "fake-nominal-0000000000000000";
beforeAll(() => { process.env.APP_SECRET = "test-secret-0123456789abcdef"; vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(TODAY + "T10:00:00Z")); });
afterAll(() => { vi.useRealTimers(); });
beforeEach(() => vi.setSystemTime(new Date(TODAY + "T10:00:00Z"))); // chaque test repart de la même heure : `later()` avance depuis là
afterEach(() => usePriceLabsAdapter(null));

const { sourceSnapshots, calendarDays, marketDays } = schema;
async function setup(label: string) {
  const t = await makeTenant(label), prop = await makeProperty(t.tenantId, "Logement " + label);
  const fake = new FakePriceLabs(buildScenario("nominal", TODAY));
  usePriceLabsAdapter(() => fake);
  await connectPriceLabs(t.tenantId, prop, KEY, "user:t");
  await selectListing(t.tenantId, prop, FAKE_LISTING_ID, "user:t");
  return { t, prop, fake };
}
const snaps = (prop: string) => db.select().from(sourceSnapshots).where(eq(sourceSnapshots.propertyId, prop)).orderBy(sourceSnapshots.createdAt);
const later = (h: number) => vi.setSystemTime(new Date(new Date(TODAY + "T10:00:00Z").getTime() + h * 3_600_000));

describe("snapshots PriceLabs", () => {
  it("la première lecture crée un snapshot de prix et un de marché, avec origine, validité et qualité", async () => {
    const { prop } = await setup("snap-first");
    const rows = await snaps(prop);
    expect(rows.map((r) => r.kind).sort()).toEqual(["CONFIG", "MARKET", "PRICING"]);
    const price = rows.find((r) => r.kind === "PRICING")!;
    expect(price).toMatchObject({ source: "PRICELABS", adapter: "FAKE", validFrom: TODAY, validTo: addDays(TODAY, 90), unchangedOf: null });
    expect(price.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(price.qualityScore).toBeGreaterThan(0);
    expect(price.payload).toBeTruthy();
    expect(price.lineage).toMatchObject({ listingId: FAKE_LISTING_ID, pms: "superhote" });
    expect(JSON.stringify(price.payload)).not.toContain(KEY);
  });
  it("la relecture à l'identique n'ajoute que des lignes légères qui pointent la première", async () => {
    const { t, prop } = await setup("snap-dedupe");
    const first = await snaps(prop);
    later(1);
    await syncPriceLabs(t.tenantId, prop);
    const all = await snaps(prop);
    expect(all).toHaveLength(6);
    const again = all.filter((r) => r.unchangedOf);
    expect(again).toHaveLength(3);
    for (const r of again) {
      expect(r.payload).toBeNull();
      expect(first.find((f) => f.kind === r.kind)!.id).toBe(r.unchangedOf);
      expect(r.observedAt.getTime()).toBeGreaterThan(first[0].observedAt.getTime()); // la fraîcheur avance
    }
    // la réponse brute reste lisible via le snapshot léger
    const got = await getSnapshotPayload(t.tenantId, again[0].id);
    expect(got?.payload).toEqual(first.find((f) => f.id === again[0].unchangedOf)!.payload);
  });
  it("un changement de prix chez PriceLabs crée un nouveau snapshot complet, l'ancien reste intact", async () => {
    const { t, prop, fake } = await setup("snap-change");
    const [oldPrice] = (await snaps(prop)).filter((r) => r.kind === "PRICING");
    const item = Object.values(fake.scenario.prices)[0] as any;
    const day = item.data.find((d: any) => d.price > 0 && d.user_price !== -1) ?? item.data[0];
    day.price = Number(day.price) + 7;
    later(2);
    await syncPriceLabs(t.tenantId, prop);
    const prices = (await snaps(prop)).filter((r) => r.kind === "PRICING");
    expect(prices).toHaveLength(2);
    expect(prices[1].unchangedOf).toBeNull();
    expect(prices[1].contentHash).not.toBe(oldPrice.contentHash);
    const [still] = await db.select().from(sourceSnapshots).where(eq(sourceSnapshots.id, oldPrice.id));
    expect(still.payload).toEqual(oldPrice.payload);
    expect(still.contentHash).toBe(oldPrice.contentHash);
  });
  it("lineage : chaque jour de calendrier et de marché pointe le snapshot de sa lecture", async () => {
    const { t, prop } = await setup("snap-lineage");
    const rows = await snaps(prop);
    const price = rows.find((r) => r.kind === "PRICING")!, market = rows.find((r) => r.kind === "MARKET")!;
    expect((await db.select().from(calendarDays).where(eq(calendarDays.propertyId, prop))).every((d) => d.snapshotId === price.id)).toBe(true);
    expect((await db.select().from(marketDays).where(eq(marketDays.propertyId, prop))).every((d) => d.snapshotId === market.id)).toBe(true);
    later(3);
    await syncPriceLabs(t.tenantId, prop);
    const newest = (await snaps(prop)).filter((r) => r.kind === "PRICING").at(-1)!;
    expect((await db.select().from(calendarDays).where(eq(calendarDays.propertyId, prop))).every((d) => d.snapshotId === newest.id)).toBe(true);
  });
  it("marché indisponible : pas de snapshot de marché inventé, la grille est quand même conservée", async () => {
    const t = await makeTenant("snap-nomarket"), prop = await makeProperty(t.tenantId, "Logement nomarket");
    const fake = new FakePriceLabs(buildScenario("market-down", TODAY));
    usePriceLabsAdapter(() => fake);
    await connectPriceLabs(t.tenantId, prop, KEY, "user:t");
    await selectListing(t.tenantId, prop, FAKE_LISTING_ID, "user:t");
    expect((await snaps(prop)).map((r) => r.kind).sort()).toEqual(["CONFIG", "PRICING"]);
    const state = await getSnapshotState(t.tenantId, prop);
    expect(state.latest.MARKET).toBeNull();
    expect(state.freshness.MARKET.state).toBe("MISSING");
  });
  it("lecture en échec : aucun snapshot n'est écrit", async () => {
    const { t, prop, fake } = await setup("snap-fail");
    fake.scenario.failures = { prices: 500 };
    later(1);
    await syncPriceLabs(t.tenantId, prop).catch(() => {});
    expect(await snaps(prop)).toHaveLength(3);
  });
  it("fraîcheur : à jour juste après la lecture, périmée après les seuils (prix 24 h, marché 48 h)", async () => {
    const { t, prop } = await setup("snap-fresh");
    let s = await getSnapshotState(t.tenantId, prop);
    expect(s.freshness.PRICING.state).toBe("FRESH"); expect(s.freshness.MARKET.state).toBe("FRESH");
    later(25);
    s = await getSnapshotState(t.tenantId, prop);
    expect(s.freshness.PRICING.state).toBe("STALE"); expect(s.freshness.MARKET.state).toBe("FRESH");
    later(49);
    s = await getSnapshotState(t.tenantId, prop);
    expect(s.freshness.MARKET.state).toBe("STALE");
  });
  it("l'état n'expose jamais le payload brut, et refuse un logement d'un autre locataire", async () => {
    const { t, prop } = await setup("snap-meta");
    const s = await getSnapshotState(t.tenantId, prop);
    expect(JSON.stringify(s)).not.toContain('"payload"');
    const other = await makeTenant("snap-meta-autre");
    await expect(getSnapshotState(other.tenantId, prop)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const id = (await snaps(prop))[0].id;
    expect(await getSnapshotPayload(other.tenantId, id)).toBeNull();
  });
});

describe("snapshots : cas limites (relecture US-043)", () => {
  it("seul un champ volatil (last_refreshed_at) change : lecture légère, pas de nouveau payload", async () => {
    const { t, prop, fake } = await setup("snap-volatile");
    const item = Object.values(fake.scenario.prices)[0] as any;
    item.last_refreshed_at = "2026-11-22T03:00:00Z";
    later(2);
    await syncPriceLabs(t.tenantId, prop);
    const prices = (await snaps(prop)).filter((r) => r.kind === "PRICING");
    expect(prices).toHaveLength(2);
    expect(prices[1].unchangedOf).toBe(prices[0].id);
  });
  it("A puis B puis A : le retour à A est un nouveau snapshot complet (la dédup compare au dernier seulement)", async () => {
    const { t, prop, fake } = await setup("snap-aba");
    const item = Object.values(fake.scenario.prices)[0] as any;
    const day = item.data.find((d: any) => d.price > 0 && d.user_price !== -1) ?? item.data[0], orig = day.price;
    day.price = orig + 5; later(1); await syncPriceLabs(t.tenantId, prop);
    day.price = orig; later(2); await syncPriceLabs(t.tenantId, prop);
    const prices = (await snaps(prop)).filter((r) => r.kind === "PRICING");
    expect(prices.map((r) => !!r.unchangedOf)).toEqual([false, false, false]);
    expect(prices[2].contentHash).toBe(prices[0].contentHash);
  });
  it("le lineage indique d'où vient le prix affiché", async () => {
    const { prop } = await setup("snap-lineage-src");
    const price = (await snaps(prop)).find((r) => r.kind === "PRICING")!;
    expect(price.lineage).toMatchObject({ priceSource: "PRICELABS", pricesFromSuperhote: 0, blockedNights: expect.any(Number) });
  });
  it("marché illisible plusieurs lectures de suite : le dernier snapshot de marché reste visible, périmé et non « jamais lu »", async () => {
    const { t, prop, fake } = await setup("snap-oldmarket");
    fake.scenario.failures = { neighborhood: 500 };
    for (const h of [1, 2, 3, 4, 5, 6, 7]) { later(h * 10); await syncPriceLabs(t.tenantId, prop); }
    const s = await getSnapshotState(t.tenantId, prop, { limit: 3 });
    expect(s.history).toHaveLength(3);
    expect(s.latest.MARKET).not.toBeNull();
    expect(s.freshness.MARKET.state).toBe("STALE");
  });
  it("la limite d'historique est bornée", async () => {
    const { t, prop } = await setup("snap-limit");
    for (const n of [0, -4, 1.5, Number.NaN, 5000]) expect((await getSnapshotState(t.tenantId, prop, { limit: n })).history.length).toBeLessThanOrEqual(100);
    expect((await getSnapshotState(t.tenantId, prop, { limit: 1 })).history).toHaveLength(1);
  });
  it("deux lectures concurrentes : pas de doublon ni de snapshot à rebours", async () => {
    const { t, prop } = await setup("snap-race");
    later(1);
    await Promise.all([syncPriceLabs(t.tenantId, prop), syncPriceLabs(t.tenantId, prop)]);
    const prices = (await snaps(prop)).filter((r) => r.kind === "PRICING");
    expect(prices).toHaveLength(3);
    expect(prices.filter((r) => !r.unchangedOf)).toHaveLength(1);
    const times = prices.map((r) => r.observedAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

describe("snapshots : immuabilité et isolation par la base", () => {
  it("le rôle applicatif ne peut ni modifier ni supprimer un snapshot, ni lire ceux d'un autre locataire", async () => {
    const { t, prop } = await setup("snap-rls");
    const other = await makeTenant("snap-rls-autre");
    await expect(withTenant(t.tenantId, (tx) => tx.execute(sql`update source_snapshots set quality_score = 0`), { enforce: true })).rejects.toThrow();
    await expect(withTenant(t.tenantId, (tx) => tx.execute(sql`delete from source_snapshots`), { enforce: true })).rejects.toThrow();
    const seen = await withTenant(other.tenantId, (tx) => tx.select().from(sourceSnapshots).where(eq(sourceSnapshots.propertyId, prop)), { enforce: true });
    expect(seen).toHaveLength(0);
    const own = await withTenant(t.tenantId, (tx) => tx.select().from(sourceSnapshots).where(eq(sourceSnapshots.propertyId, prop)), { enforce: true });
    expect(own.length).toBeGreaterThan(0);
  });
  it("même le propriétaire de la table ne peut ni modifier ni supprimer directement un snapshot (déclencheur)", async () => {
    const { prop } = await setup("snap-trigger");
    await expect(db.execute(sql`update source_snapshots set quality_score = 1 where property_id = ${prop}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from source_snapshots where property_id = ${prop}`)).rejects.toThrow();
    expect((await snaps(prop)).length).toBeGreaterThan(0);
  });
  it("la suppression du logement emporte ses snapshots", async () => {
    const { prop } = await setup("snap-cascade");
    await db.delete(schema.properties).where(eq(schema.properties.id, prop));
    expect(await snaps(prop)).toHaveLength(0);
  });
});

describe("US-041 : configuration et contrôle de la grille", () => {
  const audits = (tenantId: string, type: string) => db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.tenantId, tenantId), eq(schema.auditEvents.type, type)));
  const prop_ = async (id: string) => (await db.select().from(schema.properties).where(eq(schema.properties.id, id)))[0];
  it("la configuration lue est conservée en snapshot (sans clé), puis relue sans changement : lecture légère et aucune alerte", async () => {
    const { t, prop } = await setup("cfg-first");
    const cfg = (await snaps(prop)).find((r) => r.kind === "CONFIG")!;
    expect(cfg.payload).toMatchObject({ basePriceCents: 11600, minPriceCents: 8300, maxPriceCents: 25000, pushEnabled: true, currency: "EUR" });
    expect(JSON.stringify(cfg.payload)).not.toContain(KEY);
    expect(cfg.qualityScore).toBe(100);
    later(1); await syncPriceLabs(t.tenantId, prop);
    expect((await snaps(prop)).filter((r) => r.kind === "CONFIG" && r.unchangedOf)).toHaveLength(1);
    expect((await audits(t.tenantId, "integration.pricelabs_config_changed")).length).toBe(0);
  });
  it("un minimum et une synchronisation modifiés chez PriceLabs : nouveau snapshot de configuration et alerte avec avant/après", async () => {
    const { t, prop, fake } = await setup("cfg-change");
    fake.scenario.listings[0].min = 90; fake.scenario.listings[0].push_enabled = false;
    later(2); await syncPriceLabs(t.tenantId, prop);
    const cfgs = (await snaps(prop)).filter((r) => r.kind === "CONFIG");
    expect(cfgs).toHaveLength(2); expect(cfgs[1].unchangedOf).toBeNull();
    const [a] = await audits(t.tenantId, "integration.pricelabs_config_changed");
    expect(a.summary).toContain("Prix minimum 83 € → 90 €");
    expect((a.payload as any).changes.map((c: any) => c.key)).toEqual(["minPriceCents", "pushEnabled"]);
    expect((await audits(t.tenantId, "integration.pricelabs_config_changed")).length).toBe(1);
    // l'ancienne configuration reste lisible
    expect(cfgs[0].payload).toMatchObject({ minPriceCents: 8300 });
  });
  it("le rapport de grille est mémorisé avec la lecture : nominal propre", async () => {
    const { prop } = await setup("cfg-grid-ok");
    expect((await prop_(prop)).pricelabs!.lastSync.gridReport).toMatchObject({ expected: 91, received: 91, missing: 0, score: 100, issues: [] });
  });
  it("grille partielle et minimum incohérent : la lecture réussit et les anomalies sont signalées, jamais corrigées", async () => {
    const t = await makeTenant("cfg-bad"), prop = await makeProperty(t.tenantId, "Logement cfg-bad");
    const fake = new FakePriceLabs(buildScenario("partial-grid", TODAY)); usePriceLabsAdapter(() => fake);
    await connectPriceLabs(t.tenantId, prop, KEY, "user:t"); await selectListing(t.tenantId, prop, FAKE_LISTING_ID, "user:t");
    const rep = (await prop_(prop)).pricelabs!.lastSync.gridReport;
    expect(rep.missing).toBe(31); expect(rep.score).toBeLessThan(100);
    expect(rep.issues.map((i: any) => i.code)).toEqual(["MISSING_DAYS", "UNKNOWN_PRICES"]);
    const days = await db.select().from(calendarDays).where(eq(calendarDays.propertyId, prop));
    expect(days.filter((d) => d.state === "FREE" && d.priceCents === null).length).toBe(rep.unknownPrices); // inconnu reste inconnu
  });
  it("la fraîcheur de la configuration est exposée avec les prix et le marché", async () => {
    const { t, prop } = await setup("cfg-fresh");
    let s = await getSnapshotState(t.tenantId, prop);
    expect(s.freshness.CONFIG.state).toBe("FRESH");
    later(25);
    s = await getSnapshotState(t.tenantId, prop);
    expect(s.freshness.CONFIG.state).toBe("STALE");
  });
});
