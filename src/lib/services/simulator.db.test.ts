import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, newId, schema } from "@/db";
import { makeTenant } from "@/test/db";
import { createProperty, PortfolioError } from "./portfolio";
import { parseSimQuery, simulateForProperty } from "./simulator";

type T = Awaited<ReturnType<typeof makeTenant>>;
let a: T, b: T;
beforeAll(async () => { a = await makeTenant("A-sim"); b = await makeTenant("B-sim"); });
const ECON = { cleaningFeeChargedCents: 5000, cleaningCostCents: 4000, linenCostCents: 1000, nightlyVariableCostCents: 500, hardContributionPerNightCents: 3000, strategyContributionPerNightCents: 4000, channels: { AIRBNB: { commissionPct: 15, paymentFeePct: 0 }, BOOKING: { commissionPct: 17, paymentFeePct: 1 } } };
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { if (e instanceof PortfolioError) return e.code + ": " + e.message; throw e; } throw new Error("aurait dû échouer"); };
const qs = (s: string) => new URLSearchParams(s);
async function make(t: T, name: string, over: Record<string, unknown> = {}) {
  const { id } = await createProperty(t.actor, { name, city: "Lille", kind: "T2" });
  await db.update(schema.properties).set({ economics: ECON as never, strategy: { basePriceCents: 12000, minPriceCents: 6000, maxPriceCents: 20000, minStay: 2, maxDiscountStackPct: 30, maxPriceChangePct: 20 } as never, ...over }).where(eq(schema.properties.id, id));
  return id;
}
const NOW = new Date("2026-11-22T10:00:00Z");

describe("lecture des paramètres du simulateur (US-053)", () => {
  it("accepte une requête valide ; la virgule décimale ; le type de promotion en minuscules", () => {
    const q = parseSimQuery(qs("channel=BOOKING&nights=3&price=15000&from=2026-07-10&promo=genius:10&promo=MOBILE:2.5"), "2026-11-22");
    expect(q).toMatchObject({ channel: "BOOKING", nights: 3, from: "2026-07-10", publishedNightlyCents: 15000 });
    expect(q.promos).toEqual([{ kind: "GENIUS", label: "Genius (tarif réservé aux membres)", discountPct: 10 }, { kind: "MOBILE", label: "Tarif mobile", discountPct: 2.5 }]);
    expect(parseSimQuery(qs("channel=AIRBNB&nights=1&price=1"), "2026-11-22").from).toBe("2026-11-22");
    expect(parseSimQuery(qs("channel=AIRBNB&nights=1&price=1&los=5,5"), "2026-11-22").losDiscountPct).toBe(5.5);
  });
  it("refuse canal, durée, prix, date, remise et promotions invalides", () => {
    for (const bad of ["nights=2&price=100", "channel=DIRECT&nights=2&price=100", "channel=AIRBNB&nights=0&price=100", "channel=AIRBNB&nights=91&price=100", "channel=AIRBNB&nights=2&price=-5", "channel=AIRBNB&nights=2&price=1e3", "channel=AIRBNB&nights=2&price=100&from=2026-02-30", "channel=AIRBNB&nights=2&price=100&los=0", "channel=AIRBNB&nights=2&price=100&los=100", "channel=BOOKING&nights=2&price=100&los=5", "channel=AIRBNB&nights=2&price=100&promo=LOS:5", "channel=AIRBNB&nights=2&price=100&from=9999-12-30", "channel=AIRBNB&nights=2&price=100&from=2031-01-01", "channel=AIRBNB&nights=2&price=100&promo=CUSTOM", "channel=AIRBNB&nights=2&price=100&promo=CUSTOM:abc"]) {
      expect(() => parseSimQuery(qs(bad), "2026-11-22"), bad).toThrow(PortfolioError);
    }
    expect(() => parseSimQuery(qs("channel=AIRBNB&nights=2&price=100" + "&promo=CUSTOM:5".repeat(7)), "2026-11-22")).toThrow(/six promotions/);
  });
});

describe("simulation d'un logement (US-053)", () => {
  it("renvoie la cascade expliquée, les planchers de la saison et le verdict", async () => {
    const id = await make(a, "Simulé", { economics: { ...ECON, seasons: [{ id: "ete", label: "Été", from: "07-01", to: "08-31", strategyContributionPerNightCents: 6000 }] } });
    const v = await simulateForProperty(a.tenantId, id, qs("channel=AIRBNB&nights=2&price=7000&from=2026-07-10"), NOW);
    expect(v).toMatchObject({ propertyId: id, reconciles: true, verdict: "WARN", maxDiscountStackPct: 30, registryStale: false });
    expect(v.floors).toMatchObject({ hardCents: 4559, strategyCents: 8089 });
    expect(v.floors.season?.id).toBe("ete");
    expect(v.steps.at(-1)).toMatchObject({ key: "contribution", cents: v.result.contributionCents });
    expect((await simulateForProperty(a.tenantId, id, qs("channel=AIRBNB&nights=2&price=7000&from=2026-03-10"), NOW)).verdict).toBe("OK");
  });
  it("registre périmé (promotion non vérifiée depuis plus de 7 jours) : décision humaine ; vérifiée récemment : non", async () => {
    const id = await make(a, "Registre");
    const promo = (verifiedAt: Date | null) => db.insert(schema.promotions).values({ id: newId("promo"), tenantId: a.tenantId, propertyId: id, channel: "AIRBNB", kind: "CUSTOM", label: "Promo", discountPct: 5, verifiedAt, status: "ACTIVE" });
    await promo(new Date(NOW.getTime() - 9 * 86_400_000));
    const stale = await simulateForProperty(a.tenantId, id, qs("channel=AIRBNB&nights=2&price=12000"), NOW);
    expect(stale).toMatchObject({ registryStale: true, verdict: "NEEDS_HUMAN" });
    await db.delete(schema.promotions).where(eq(schema.promotions.propertyId, id));
    await promo(new Date(NOW.getTime() - 86_400_000));
    expect((await simulateForProperty(a.tenantId, id, qs("channel=AIRBNB&nights=2&price=12000"), NOW)).registryStale).toBe(false);
  });
  it("refuse : modèle incomplet, canal non déclaré, plafond inconnu, autre espace ; rien n'est écrit", async () => {
    const inc = await make(a, "Incomplet", { economics: { ...ECON, cleaningCostCents: null } });
    expect(await code(simulateForProperty(a.tenantId, inc, qs("channel=AIRBNB&nights=2&price=10000"), NOW))).toMatch(/INVALID: Simulation impossible : il manque coût du ménage/);
    const one = await make(a, "Un canal", { economics: { ...ECON, channels: { AIRBNB: ECON.channels.AIRBNB } } });
    expect(await code(simulateForProperty(a.tenantId, one, qs("channel=BOOKING&nights=2&price=10000"), NOW))).toMatch(/INVALID: .*commission Booking/);
    const nomax = await make(a, "Sans plafond", { strategy: {} });
    expect(await code(simulateForProperty(a.tenantId, nomax, qs("channel=AIRBNB&nights=2&price=10000"), NOW))).toMatch(/plafond de cumul/);
    const ok = await make(a, "Chez A");
    expect(await code(simulateForProperty(b.tenantId, ok, qs("channel=AIRBNB&nights=2&price=10000"), NOW))).toMatch(/NOT_FOUND/);
    expect((await db.select().from(schema.properties).where(eq(schema.properties.id, ok)))[0].economicsVersion).toBe(0);
  });
});
