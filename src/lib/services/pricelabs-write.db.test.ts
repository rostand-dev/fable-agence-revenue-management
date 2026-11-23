import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db, newId, schema } from "@/db";
import { makeProperty, makeTenant } from "@/test/db";
import { addDays } from "../dates";
import { usePriceLabsAdapter } from "../integrations/pricelabs";
import { FakePriceLabs } from "../integrations/pricelabs-fake";
import { buildScenario, FAKE_LISTING_ID } from "../integrations/pricelabs-scenarios";
import { usePriceLabsWriter } from "../integrations/pricelabs-write";
import { FakePriceLabsWriter } from "../integrations/pricelabs-write-fake";
import * as D from "./decisions";
import { connectPriceLabs, selectListing } from "./pricelabs-sync";
import { preparePriceLabsWrite, readBackPriceLabsWrite, sendPriceLabsWrite, targetOf, WriteError, writesOfAction } from "./pricelabs-write";

// US-090 : écriture PriceLabs d'une action, de bout en bout sur une base réelle, avec les faux adaptateurs (aucun réseau).
const TODAY = "2026-11-21", KEY = "fake-nominal-0000000000000000", D1 = addDays(TODAY, 30), D2 = addDays(TODAY, 31);
beforeAll(() => { process.env.APP_SECRET = "test-secret-0123456789abcdef"; vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(TODAY + "T10:00:00Z")); });
afterAll(() => { vi.useRealTimers(); });
afterEach(() => { usePriceLabsAdapter(null); usePriceLabsWriter(null); });

const { properties, revenueActions, externalWrites } = schema;
async function setup(label: string) {
  const t = await makeTenant(label), propId = await makeProperty(t.tenantId, "Logement " + label);
  const read = new FakePriceLabs(buildScenario("nominal", TODAY)), writer = new FakePriceLabsWriter(read);
  usePriceLabsAdapter(() => read); usePriceLabsWriter(() => writer);
  await connectPriceLabs(t.tenantId, propId, KEY, "user:t");
  await selectListing(t.tenantId, propId, FAKE_LISTING_ID, "user:t");
  const prop = (await db.select().from(properties).where(eq(properties.id, propId)))[0];
  return { t, prop, read, writer };
}
/** Une vraie action en base (le journal d'écriture y est rattaché par clé étrangère). */
async function action(t: { tenantId: string }, propertyId: string, type: string, parameters: Record<string, any>) {
  const oppId = newId("opp"), id = newId("act");
  await db.insert(schema.opportunities).values({ id: oppId, tenantId: t.tenantId, propertyId, code: "OPP-" + oppId.slice(-6), playbook: "TEST", reasonCode: "TEST", title: "Dossier de test", stayFrom: D1, stayTo: D2, dedupeKey: oppId, signals: {}, diagnosis: {}, candidates: [], expiresAt: "2027-01-01" });
  await db.insert(revenueActions).values({ id, tenantId: t.tenantId, propertyId, opportunityId: oppId, type, label: "Action de test", target: {}, parameters, simulation: {}, audit: {}, status: "DRAFT", riskLevel: "LOW", rollbackPlan: "test", idempotencyKey: id });
  return { id, tenantId: t.tenantId, type, parameters };
}

describe("écriture PriceLabs d'une action (journal, relecture, idempotence)", () => {
  it("prix minimum : écrit, relu, journalisé CONFIRMED, sans clé API dans le journal", async () => {
    const { t, prop, read } = await setup("min");
    const a = await action(t, prop.id, "MIN_PRICE_CHANGE", { minPriceCents: 9500, previousMinPriceCents: 8300 });
    const w = await preparePriceLabsWrite(prop, a);
    expect(w.plan).toEqual({ kind: "LISTING_LIMITS", limits: { minCents: 9500 } });
    const out = await sendPriceLabsWrite(w);
    expect(out.before.limits.minCents).toBe(8300);
    expect(out.after.limits.minCents).toBe(9500);
    expect((await read.listListings())[0].minCents).toBe(9500);
    const rows = await db.select().from(externalWrites).where(eq(externalWrites.tenantId, t.tenantId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: out.writeId, status: "CONFIRMED", phase: "APPLY", kind: "LISTING_LIMITS", idempotencyKey: `${a.id}:APPLY`, adapter: "FAKE" });
    expect(JSON.stringify(rows[0])).not.toContain(KEY);
  });

  it("une seconde écriture pour la même action est refusée : jamais deux envois", async () => {
    const { t, prop, writer } = await setup("idem");
    const a = await action(t, prop.id, "MIN_PRICE_CHANGE", { minPriceCents: 9500, previousMinPriceCents: 8300 });
    await sendPriceLabsWrite(await preparePriceLabsWrite(prop, a));
    const sent = writer.calls.filter((c) => c.method === "setListingLimits").length;
    await expect(preparePriceLabsWrite(prop, a)).rejects.toMatchObject({ code: "IDEMPOTENT" }); // refusé dès la préparation
    expect(writer.calls.filter((c) => c.method === "setListingLimits")).toHaveLength(sent);
    expect(await writesOfAction(t.tenantId, a.id)).toHaveLength(1);
  });

  it("prix daté à prix fixe : un prix manuel déjà posé bloque l'écriture (précondition), le même prix est un rejeu inoffensif", async () => {
    const { t, prop, writer } = await setup("ov");
    await writer.setPriceOverrides(FAKE_LISTING_ID, "superhote", [{ date: D1, priceCents: 15000 }], { currency: "EUR", reason: "manuel" });
    const a = await action(t, prop.id, "PRICE_OVERRIDE", { nightlyCents: 11000, restoresFloor: true, dates: [D1, D2] });
    await expect(preparePriceLabsWrite(prop, a)).rejects.toMatchObject({ code: "PRECONDITION", message: expect.stringContaining("porte déjà un prix daté") });
    await writer.setPriceOverrides(FAKE_LISTING_ID, "superhote", [{ date: D1, priceCents: 11000 }], { currency: "EUR", reason: "manuel" });
    const out = await sendPriceLabsWrite(await preparePriceLabsWrite(prop, a));
    expect(out.after.overrides.map((o) => [o.date, o.priceCents])).toEqual([[D1, 11000], [D2, 11000]]);
    expect(out.previousOverrides).toHaveLength(1);
  });

  it("refus à la préparation : rien n'est envoyé ni journalisé", async () => {
    const { t, prop, writer } = await setup("refus");
    const calls = () => writer.calls.filter((c) => c.method !== "getOverrides").length;
    for (const [type, parameters] of [["MIN_STAY_OVERRIDE", { minStay: 2, dates: [D1] }], ["MIN_PRICE_CHANGE", {}], ["PRICE_OVERRIDE", { dates: [D1] }]] as const) {
      await expect(preparePriceLabsWrite(prop, { id: newId("act"), tenantId: t.tenantId, type, parameters: parameters as any }), type).rejects.toBeInstanceOf(WriteError);
    }
    expect(calls()).toBe(0);
    expect(await db.select().from(externalWrites).where(eq(externalWrites.tenantId, t.tenantId))).toHaveLength(0);
  });

  it("un logement de démonstration ou sans annonce rattachée n'écrit jamais", async () => {
    const t = await makeTenant("demo"), id = await makeProperty(t.tenantId);
    const [bare] = await db.select().from(properties).where(eq(properties.id, id));
    expect(() => targetOf(bare)).toThrow(WriteError);
    expect(() => targetOf({ ...bare, isDemo: true, pricelabs: { apiKeyEnc: "x", listingId: "1", pms: "p" } })).toThrow(/démonstration/);
  });

  it("refus de PriceLabs (403) : journal FAILED, valeur inchangée, message clair", async () => {
    const { t, prop, read, writer } = await setup("403");
    const a = await action(t, prop.id, "MIN_PRICE_CHANGE", { minPriceCents: 9500, previousMinPriceCents: 8300 });
    const w = await preparePriceLabsWrite(prop, a);
    writer.failWrites = { status: 403 };
    await expect(sendPriceLabsWrite(w)).rejects.toMatchObject({ code: "SEND", message: expect.stringContaining("Rien n'a été modifié") });
    expect((await writesOfAction(t.tenantId, a.id))[0]).toMatchObject({ status: "FAILED" });
    expect((await read.listListings())[0].minCents).toBe(8300);
  });

  it("écriture envoyée mais relecture impossible : échec « non confirmée », jamais un succès supposé", async () => {
    const { t, prop, writer } = await setup("noconf");
    const a = await action(t, prop.id, "PRICE_OVERRIDE", { nightlyCents: 11000, restoresFloor: true, dates: [D1] });
    const w = await preparePriceLabsWrite(prop, a);
    const real = writer.getOverrides.bind(writer);
    let n = 0;
    writer.getOverrides = async (...args) => { if (++n > 0) writer.brokenOverrideRead = true; return real(...args); };
    await expect(sendPriceLabsWrite(w)).rejects.toMatchObject({ code: "CONFIRM", message: expect.stringContaining("non confirmée") });
    expect((await writesOfAction(t.tenantId, a.id))[0]).toMatchObject({ status: "SENT", receipt: expect.objectContaining({ method: "POST" }) });
  });

  it("le coupe-circuit levé pendant la préparation bloque l'envoi après le journal : rien n'est écrit", async () => {
    const { t, prop, read, writer } = await setup("recheck");
    const a = await action(t, prop.id, "MIN_PRICE_CHANGE", { minPriceCents: 9500, previousMinPriceCents: 8300 });
    const w = await preparePriceLabsWrite(prop, a);
    await expect(sendPriceLabsWrite(w, { recheck: async () => { throw new WriteError("Coupe-circuit activé."); } })).rejects.toMatchObject({ message: expect.stringContaining("Coupe-circuit") });
    expect(writer.calls.some((c) => c.method === "setListingLimits")).toBe(false);
    expect((await read.listListings())[0].minCents).toBe(8300);
    expect((await writesOfAction(t.tenantId, a.id))[0].status).toBe("FAILED");
  });

  it("vérification ultérieure : conforme, puis écart détecté si PriceLabs a changé entre-temps", async () => {
    const { t, prop, read } = await setup("verify");
    const a = await action(t, prop.id, "MIN_PRICE_CHANGE", { minPriceCents: 9500, previousMinPriceCents: 8300 });
    const out = await sendPriceLabsWrite(await preparePriceLabsWrite(prop, a));
    expect((await readBackPriceLabsWrite(prop, out.plan)).mismatches).toEqual([]);
    (read.scenario.listings[0] as any).min = 80; // quelqu'un modifie le minimum dans PriceLabs
    const r = await readBackPriceLabsWrite(prop, out.plan);
    expect(r.mismatches).toHaveLength(1);
    expect(r.mismatches[0]).toContain("prix minimum relu");
  });

  it("l'état d'avant est inscrit au journal avant l'envoi, sans clé API", async () => {
    const { t, prop, writer } = await setup("avant");
    await writer.setPriceOverrides(FAKE_LISTING_ID, "superhote", [{ date: D1, priceCents: 11000 }], { currency: "EUR", reason: "manuel" });
    const a = await action(t, prop.id, "PRICE_OVERRIDE", { nightlyCents: 11000, restoresFloor: true, dates: [D1] });
    await sendPriceLabsWrite(await preparePriceLabsWrite(prop, a));
    const [row] = await writesOfAction(t.tenantId, a.id);
    expect((row.plan as any).before.limits.minCents).toBe(8300);
    expect((row.plan as any).before.overrides[0]).toMatchObject({ date: D1, price: "110" });
    expect(JSON.stringify(row)).not.toContain(KEY);
  });

  it("réponse ambiguë (500 après reprises) : journal « envoyée », message honnête, jamais « rien n'a été modifié »", async () => {
    const { t, prop, writer } = await setup("ambigu");
    const a = await action(t, prop.id, "MIN_PRICE_CHANGE", { minPriceCents: 9500, previousMinPriceCents: 8300 });
    const w = await preparePriceLabsWrite(prop, a);
    writer.failWrites = { status: 503 };
    const err = await sendPriceLabsWrite(w).catch((e) => e);
    expect(err).toBeInstanceOf(WriteError);
    expect(err.message).toContain("incertaine");
    expect(err.message).not.toContain("Rien n'a été modifié");
    expect(err.sent).toBe(true); expect(err.writeId).toBeTruthy();
    expect((await writesOfAction(t.tenantId, a.id))[0]).toMatchObject({ status: "SENT" });
  });

  it("deux envois simultanés pour la même action : un seul part, l'autre est refusé", async () => {
    const { t, prop, writer } = await setup("course");
    const a = await action(t, prop.id, "MIN_PRICE_CHANGE", { minPriceCents: 9500, previousMinPriceCents: 8300 });
    const [w1, w2] = [await preparePriceLabsWrite(prop, a), await preparePriceLabsWrite(prop, a)];
    const res = await Promise.allSettled([sendPriceLabsWrite(w1), sendPriceLabsWrite(w2)]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((res.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "IDEMPOTENT" });
    expect(writer.calls.filter((c) => c.method === "setListingLimits")).toHaveLength(1);
  });

  it("isolation : le journal d'un espace n'est pas lisible depuis un autre (filtre applicatif)", async () => {
    const { t, prop } = await setup("rls");
    const a = await action(t, prop.id, "MIN_PRICE_CHANGE", { minPriceCents: 9500, previousMinPriceCents: 8300 });
    await sendPriceLabsWrite(await preparePriceLabsWrite(prop, a));
    const other = await makeTenant("autre");
    expect(await writesOfAction(other.tenantId, a.id)).toHaveLength(0);
  });
});

// Parcours complet execute() / verify() / rollback() sur un logement réel branché (adaptateurs en mémoire, base réelle).
async function approved(t: Awaited<ReturnType<typeof makeTenant>>, propertyId: string, type: string, parameters: Record<string, any>) {
  const a = await action(t, propertyId, type, parameters);
  await db.update(revenueActions).set({ simulation: { executionMode: "API_PRICELABS", measurementWindowDays: 7 }, target: { system: "PRICELABS" }, label: "Test" }).where(eq(revenueActions.id, a.id));
  for (const st of ["SIMULATED", "AUDITED", "PENDING_APPROVAL", "APPROVED"]) await db.update(revenueActions).set({ status: st }).where(eq(revenueActions.id, a.id));
  return a;
}
describe("execute / verify / rollback d'une action sur un logement réel", () => {
  const withGate = (v: string | undefined) => { if (v === undefined) delete process.env.PRICELABS_WRITE_ENABLED; else process.env.PRICELABS_WRITE_ENABLED = v; };
  afterEach(() => withGate(undefined));
  const status = async (id: string) => (await db.select().from(revenueActions).where(eq(revenueActions.id, id)))[0];

  it("précondition non remplie : action laissée APPROUVÉE, rien d'envoyé, refus tracé dans le journal d'audit", async () => {
    withGate("true");
    const { t, prop, read, writer } = await setup("exec-precond");
    const a = await approved(t, prop.id, "MIN_PRICE_CHANGE", { minPriceCents: 9500, previousMinPriceCents: 7000 }); // la simulation partait de 70 €, PriceLabs est à 83 €
    await expect(D.execute(t.actor, a.id, undefined)).rejects.toThrow(/Précondition non remplie/);
    expect((await status(a.id)).status).toBe("APPROVED");
    expect(writer.calls.filter((c) => c.method === "setListingLimits")).toHaveLength(0);
    expect((await read.listListings())[0].minCents).toBe(8300);
    expect(await writesOfAction(t.tenantId, a.id)).toHaveLength(0);
    const ev = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.tenantId, t.tenantId));
    expect(ev.some((e) => e.type === "action.precondition_failed" && e.entityId === a.id)).toBe(true);
  });

  it("rejeu d'une action dont l'écriture est déjà partie : IDEMPOTENT, pas une fausse précondition", async () => {
    const { t, prop } = await setup("rejeu");
    const a = await action(t, prop.id, "MIN_PRICE_CHANGE", { minPriceCents: 9500, previousMinPriceCents: 7000 });
    await sendPriceLabsWrite(await preparePriceLabsWrite(prop, { ...a, parameters: { minPriceCents: 9500, previousMinPriceCents: 8300 } }));
    await expect(preparePriceLabsWrite(prop, a)).rejects.toMatchObject({ code: "IDEMPOTENT" });
  });

  it("logement de démonstration : jamais de lecture chez PriceLabs ni d'audit de précondition", async () => {
    const t = await makeTenant("demo-precond"), id = await makeProperty(t.tenantId);
    await db.update(properties).set({ isDemo: true }).where(eq(properties.id, id));
    const [p] = await db.select().from(properties).where(eq(properties.id, id));
    await expect(preparePriceLabsWrite(p, { id: newId("act"), tenantId: t.tenantId, type: "MIN_PRICE_CHANGE", parameters: { minPriceCents: 9500 } })).rejects.toThrow(/démonstration/);
  });

  it("verrou fermé : refus clair, action laissée APPROUVÉE, rien d'envoyé", async () => {
    const { t, prop, writer } = await setup("exec-ferme");
    const a = await approved(t, prop.id, "MIN_PRICE_CHANGE", { minPriceCents: 9500, previousMinPriceCents: 8300 });
    await expect(D.execute(t.actor, a.id, undefined)).rejects.toThrow(/PRICELABS_WRITE_ENABLED|Désactivée|désactivée/);
    expect((await status(a.id)).status).toBe("APPROVED");
    expect(writer.calls.filter((c) => c.method === "setListingLimits")).toHaveLength(0);
    expect(await writesOfAction(t.tenantId, a.id)).toHaveLength(0);
  });

  it("verrou ouvert : écriture, reçu, vérification conforme ; le retour arrière automatique est refusé (US-093)", async () => {
    withGate("true");
    const { t, prop, read } = await setup("exec-ouvert");
    const a = await approved(t, prop.id, "MIN_PRICE_CHANGE", { minPriceCents: 9500, previousMinPriceCents: 8300 });
    await D.execute(t.actor, a.id, undefined);
    const row = await status(a.id);
    expect(row.status).toBe("EXECUTED");
    expect(row.execution).toMatchObject({ mode: "PRICELABS_API", adapter: "FAKE", receipt: { method: "POST", endpoint: "/listings" }, remoteBefore: { limits: { minCents: 8300 } }, remoteAfter: { limits: { minCents: 9500 } } });
    expect(JSON.stringify(row.execution)).not.toContain(KEY);
    expect((await read.listListings())[0].minCents).toBe(9500);
    await D.verify(t.actor, a.id);
    expect((await status(a.id)).status).toBe("MEASURING");
    await expect(D.rollback(t.actor, a.id, "test")).rejects.toThrow(/pas encore disponible/);
    expect((await status(a.id)).status).toBe("MEASURING");
  });

  it("coupe-circuit actif : rien n'est écrit", async () => {
    withGate("true");
    const { t, prop, writer } = await setup("exec-kill");
    await db.insert(schema.integrations).values({ id: newId("int"), tenantId: t.tenantId, provider: "pricelabs", status: "CONNECTED", capabilities: {}, killSwitch: true } as any).onConflictDoNothing();
    const a = await approved(t, prop.id, "MIN_PRICE_CHANGE", { minPriceCents: 9500, previousMinPriceCents: 8300 });
    await expect(D.execute(t.actor, a.id, undefined)).rejects.toThrow(/coupe-circuit/i);
    expect((await status(a.id)).status).toBe("APPROVED");
    expect(writer.calls.filter((c) => c.method === "setListingLimits")).toHaveLength(0);
  });

  it("écriture envoyée mais non confirmée : action FAILED avec le journal, et le retour arrière « fantôme » est refusé", async () => {
    withGate("true");
    const { t, prop, writer } = await setup("exec-fantome");
    const a = await approved(t, prop.id, "PRICE_OVERRIDE", { nightlyCents: 11000, restoresFloor: true, dates: [D1] });
    const real = writer.getOverrides.bind(writer);
    let reads = 0;
    writer.getOverrides = async (...args) => { if (++reads > 1) writer.brokenOverrideRead = true; return real(...args); }; // la lecture d'avant passe, celle de confirmation échoue
    await expect(D.execute(t.actor, a.id, undefined)).rejects.toThrow(/non confirmée/);
    const row = await status(a.id);
    expect(row.status).toBe("FAILED");
    expect(row.execution).toMatchObject({ writeId: expect.any(String) });
    await expect(D.rollback(t.actor, a.id, "test")).rejects.toThrow(/pas encore disponible/);
    expect((await status(a.id)).status).toBe("FAILED");
  });

  it("un type non écrit par l'API (séjour minimum daté) est refusé sur un logement réel", async () => {
    withGate("true");
    const { t, prop } = await setup("exec-minstay");
    const a = await approved(t, prop.id, "MIN_STAY_OVERRIDE", { minStay: 3, dates: [D1] });
    await expect(D.execute(t.actor, a.id, undefined)).rejects.toThrow(/procédure manuelle/);
    expect((await status(a.id)).status).toBe("APPROVED");
  });
});
