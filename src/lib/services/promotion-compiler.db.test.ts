import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { emptyEconomics } from "@/lib/engine/economics";
import type { EconomicModel } from "@/lib/engine/types";
import { makeProperty, makeTenant } from "@/test/db";
import { compileForProperty } from "./promotion-compiler";
import { declarePromotion, PromotionError, endPromotion } from "./promotion-registry";

type T = Awaited<ReturnType<typeof makeTenant>>;
let a: T, b: T, propA: string, propBare: string, propB: string;
const NOW = new Date("2026-11-24T09:00:00Z");
const model: EconomicModel = { ...emptyEconomics(), cleaningFeeChargedCents: 5000, cleaningCostCents: 4000, linenCostCents: 1000, nightlyVariableCostCents: 500, hardContributionPerNightCents: 3000, strategyContributionPerNightCents: 4000, channels: { AIRBNB: { commissionPct: 15, paymentFeePct: 0 }, BOOKING: { commissionPct: 17, paymentFeePct: 1 } } };
const RAW = { intent: "STIMULATE_NEAR_TERM_DEMAND", stayFrom: "2026-12-10", stayTo: "2026-12-20", maxDiscountPct: "10", channel_AIRBNB: "on", channel_BOOKING: "on", price_AIRBNB: "200", price_BOOKING: "200" };

beforeAll(async () => {
  a = await makeTenant("A-comp"); b = await makeTenant("B-comp");
  propA = await makeProperty(a.tenantId, "Châtillon"); propBare = await makeProperty(a.tenantId, "Sans coûts"); propB = await makeProperty(b.tenantId, "Autre espace");
  await db.update(schema.properties).set({ economics: model, strategy: { maxDiscountStackPct: 30 } as never }).where(eq(schema.properties.id, propA));
});

describe("compilation d'une intention sur un logement (US-101)", () => {
  it("registre vide : proposition conservée mais décision humaine (le registre est tenu à la main), rien d'enregistré", async () => {
    const before = await db.select().from(schema.promotions).where(eq(schema.promotions.tenantId, a.tenantId));
    const r = await compileForProperty(a.tenantId, propA, RAW, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.outcomes.map((o) => [o.channel, o.status])).toEqual([["AIRBNB", "NEEDS_HUMAN"], ["BOOKING", "NEEDS_HUMAN"]]);
    expect(await db.select().from(schema.promotions).where(eq(schema.promotions.tenantId, a.tenantId))).toHaveLength(before.length);
  });
  it("saisie invalide : erreur lisible, pas d'exception", async () => {
    expect(await compileForProperty(a.tenantId, propA, { ...RAW, maxDiscountPct: "0" }, NOW)).toMatchObject({ ok: false });
  });
  it("logement d'un autre espace ou inconnu : introuvable", async () => {
    await expect(compileForProperty(a.tenantId, propB, RAW, NOW)).rejects.toBeInstanceOf(PromotionError);
    await expect(compileForProperty(a.tenantId, "inconnu", RAW, NOW)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("modèle économique et stratégie absents : refus explicite MISSING_DATA", async () => {
    const r = await compileForProperty(a.tenantId, propBare, RAW, NOW);
    expect(r.ok && r.result.outcomes.every((o) => o.status === "NO_SAFE_EQUIVALENT" && o.code === "MISSING_DATA")).toBe(true);
  });
  it("lit le registre : même type actif = refus ; autre type jamais relu = décision humaine ; promotion terminée ignorée", async () => {
    const actor = { ...a.actor, role: "OWNER" as const };
    const mobile = await declarePromotion(actor, propA, { channel: "BOOKING", kind: "MOBILE", discountPct: "8", stayFrom: "2026-12-01", stayTo: "2026-12-31" }, NOW);
    let r = await compileForProperty(a.tenantId, propA, RAW, NOW);
    expect(r.ok && r.result.outcomes.find((o) => o.channel === "BOOKING")).toMatchObject({ code: "ALREADY_ACTIVE" });
    await endPromotion(actor, mobile.id, "test", NOW);
    r = await compileForProperty(a.tenantId, propA, RAW, NOW);
    expect(r.ok && r.result.outcomes.find((o) => o.channel === "BOOKING")?.status).toBe("NEEDS_HUMAN"); // registre de nouveau vide
    // une promotion Genius active, relue il y a 10 jours : cumul inconnu et registre périmé
    const genius = await declarePromotion(actor, propA, { channel: "BOOKING", kind: "GENIUS", discountPct: "10" }, NOW);
    await db.update(schema.promotions).set({ verifiedAt: new Date("2026-11-14T09:00:00Z") }).where(eq(schema.promotions.id, genius.id));
    r = await compileForProperty(a.tenantId, propA, RAW, NOW);
    const o = r.ok ? r.result.outcomes.find((x) => x.channel === "BOOKING")! : null;
    expect(o?.status).toBe("NEEDS_HUMAN");
    if (o?.status === "NEEDS_HUMAN") expect(o.humanReasons.join(" ")).toMatch(/non vérifié récemment|cumul inconnue/);
    // un registre à jour sans cumul inconnu : COMPILED. Airbnb : une promotion TOP_RATED vérifiée à l'instant se cumule avec la dernière minute.
    await declarePromotion(actor, propA, { channel: "AIRBNB", kind: "TOP_RATED", discountPct: "5" }, NOW);
    r = await compileForProperty(a.tenantId, propA, RAW, NOW);
    expect(r.ok && r.result.outcomes.find((x) => x.channel === "AIRBNB")?.status).toBe("COMPILED");
  });
});
