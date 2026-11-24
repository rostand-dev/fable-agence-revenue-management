import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, newId, schema } from "@/db";
import { makeTenant } from "@/test/db";
import { addDays, todayISO } from "../dates";
import { loadEngineInput } from "./review";
import { seedDemo } from "./seed";

const { opportunities, properties } = schema;
let t: Awaited<ReturnType<typeof makeTenant>>;
let propId: string;
beforeAll(async () => {
  t = await makeTenant("pb12");
  await seedDemo(t.tenantId);
  propId = (await db.select().from(properties).where(eq(properties.tenantId, t.tenantId)))[0].id;
  // aucun dossier de rythme n'existe au départ pour ce test
}, 120_000);

const day = (n: number) => addDays(todayISO(new Date()), n);
const row = (playbook: string, status: string, createdAt: Date, o: { signals?: Record<string, unknown>; expiresAt?: string; reasonCode?: string } = {}) =>
  db.insert(opportunities).values({
    id: newId("opp"), tenantId: t.tenantId, propertyId: propId, code: newId("c"), playbook, reasonCode: o.reasonCode ?? (playbook === "PB-01" ? "PACE_BELOW_MARKET" : "PACE_BELOW_MARKET_PERSISTENT"), title: "t", stayFrom: "2026-12-01", stayTo: "2026-12-05", dedupeKey: newId("k"),
    signals: o.signals ?? {}, diagnosis: {}, candidates: [], status, createdAt, expiresAt: o.expiresAt ?? day(7),
  } as any);
// la revue du jeu de démonstration a pu écrire l'historique daté : ce fichier teste la lecture des DOSSIERS seuls
const clear = async () => { await db.delete(opportunities).where(and(eq(opportunities.tenantId, t.tenantId), eq(opportunities.propertyId, propId))); await db.delete(schema.marketGapHistory).where(eq(schema.marketGapHistory.propertyId, propId)); };
const lag = async () => (await loadEngineInput(t.tenantId, propId, todayISO(new Date())))!.lagSince;
const ago = (n: number) => new Date(Date.now() - n * 86400000);

describe("PB-12 · ancienneté du retard lue en base", () => {
  it("aucun dossier de rythme : durée inconnue (null), jamais zéro", async () => {
    await clear();
    expect(await lag()).toBeNull();
  });
  it("le plus ancien dossier PB-01 suivi donne la date", async () => {
    await row("PB-01", "OPEN", ago(10));
    await row("PB-01", "DECIDED", ago(30));
    expect(await lag()).toBe(day(-30));
    await clear();
  });
  it("l'ancienneté d'origine voyage dans `signals.lagSince` d'un dossier au suivant (PB-01 → PB-12)", async () => {
    await row("PB-12", "OPEN", new Date(), { signals: { lagSince: day(-50) } });
    expect(await lag()).toBe(day(-50));
    await clear();
  });
  it("un dossier expiré depuis peu garde l'ancienneté (interruption tolérée) ; au-delà de la tolérance, elle repart de zéro", async () => {
    await row("PB-01", "EXPIRED", ago(40), { signals: { lagSince: day(-40) }, expiresAt: day(-5) });
    expect(await lag()).toBe(day(-40));
    await clear();
    await row("PB-01", "EXPIRED", ago(60), { signals: { lagSince: day(-60) }, expiresAt: day(-30) });
    expect(await lag()).toBeNull();
    await clear();
  });
  it("un dossier tranché depuis longtemps ne prolonge pas un retard résolu", async () => {
    await row("PB-01", "DECIDED", ago(120), { expiresAt: day(-100) });
    expect(await lag()).toBeNull();
    await clear();
  });
  it("un PB-01 qui ne vient pas d'une cause de prix (marché faible, fenêtre non ouverte) ne compte pas", async () => {
    await row("PB-01", "OPEN", ago(30), { reasonCode: "PACE_BELOW_MARKET_EXPECTED" });
    expect(await lag()).toBeNull();
    await clear();
  });
});
