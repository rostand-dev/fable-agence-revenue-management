import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db, newId, schema } from "@/db";
import { makeProperty, makeTenant } from "@/test/db";
import { addDays } from "../dates";
import { usePriceLabsAdapter } from "../integrations/pricelabs";
import { FakePriceLabs } from "../integrations/pricelabs-fake";
import { buildScenario, FAKE_LISTING_ID } from "../integrations/pricelabs-scenarios";
import { usePriceLabsWriter } from "../integrations/pricelabs-write";
import { FakePriceLabsWriter } from "../integrations/pricelabs-write-fake";
import { emailConfigured, sendEmail } from "../email/resend";
import * as D from "./decisions";
import { acknowledgeAlert, listAlerts, openAlertCount, raiseAlert, runExecutionWatch } from "./execution-alerts";
import { connectPriceLabs, selectListing } from "./pricelabs-sync";

vi.mock("../email/resend", () => ({ emailConfigured: vi.fn(() => false), sendEmail: vi.fn(async () => true) }));

// US-094 : alertes d'exécution PriceLabs, sur une base réelle, avec les faux adaptateurs (aucun réseau).
const TODAY = "2026-11-21", KEY = "fake-nominal-0000000000000000", D1 = addDays(TODAY, 30), D2 = addDays(TODAY, 31);
const NOW = new Date(TODAY + "T10:00:00Z");
beforeAll(() => { process.env.APP_SECRET = "test-secret-0123456789abcdef"; vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterAll(() => { vi.useRealTimers(); });
afterEach(() => { usePriceLabsAdapter(null); usePriceLabsWriter(null); delete process.env.PRICELABS_WRITE_ENABLED; vi.mocked(emailConfigured).mockReturnValue(false); vi.mocked(sendEmail).mockClear(); });

const { properties, revenueActions, externalWrites, executionAlerts } = schema;
async function setup(label: string) {
  const t = await makeTenant(label), propId = await makeProperty(t.tenantId, "Logement " + label);
  const read = new FakePriceLabs(buildScenario("nominal", TODAY)), writer = new FakePriceLabsWriter(read);
  usePriceLabsAdapter(() => read); usePriceLabsWriter(() => writer);
  await connectPriceLabs(t.tenantId, propId, KEY, "user:t");
  await selectListing(t.tenantId, propId, FAKE_LISTING_ID, "user:t");
  const prop = (await db.select().from(properties).where(eq(properties.id, propId)))[0];
  process.env.PRICELABS_WRITE_ENABLED = "true";
  return { t, prop, read, writer };
}
async function approved(t: Awaited<ReturnType<typeof makeTenant>>, propertyId: string, type: string, parameters: Record<string, any>) {
  const oppId = newId("opp"), id = newId("act");
  await db.insert(schema.opportunities).values({ id: oppId, tenantId: t.tenantId, propertyId, code: "OPP-" + oppId.slice(-6), playbook: "TEST", reasonCode: "TEST", title: "Dossier de test", stayFrom: D1, stayTo: D2, dedupeKey: oppId, signals: {}, diagnosis: {}, candidates: [], expiresAt: "2027-01-01" });
  await db.insert(revenueActions).values({ id, tenantId: t.tenantId, propertyId, opportunityId: oppId, type, label: "Action de test", target: { system: "PRICELABS" }, parameters, simulation: { executionMode: "API_PRICELABS", measurementWindowDays: 7 }, audit: {}, status: "DRAFT", riskLevel: "LOW", rollbackPlan: "test", idempotencyKey: id });
  for (const st of ["SIMULATED", "AUDITED", "PENDING_APPROVAL", "APPROVED"]) await db.update(revenueActions).set({ status: st }).where(eq(revenueActions.id, id));
  return { id };
}
const alertsOf = (tenantId: string) => db.select().from(executionAlerts).where(eq(executionAlerts.tenantId, tenantId));
const status = async (id: string) => (await db.select().from(revenueActions).where(eq(revenueActions.id, id)))[0];
const MIN = { minPriceCents: 9500, previousMinPriceCents: 8300 };

describe("alertes levées au moment de l'échec", () => {
  it("écriture refusée par PriceLabs (403) : alerte « à surveiller », action en échec, événement d'audit", async () => {
    const { t, prop, writer } = await setup("al-403");
    const a = await approved(t, prop.id, "MIN_PRICE_CHANGE", MIN);
    writer.failWrites = { status: 403 };
    await expect(D.execute(t.actor, a.id, undefined)).rejects.toThrow();
    expect((await status(a.id)).status).toBe("FAILED");
    const al = await alertsOf(t.tenantId);
    expect(al).toHaveLength(1);
    expect(al[0]).toMatchObject({ kind: "WRITE_FAILED", severity: "WARNING", status: "OPEN", actionId: a.id, propertyId: prop.id, notifiedAt: null });
    expect(al[0].title).toContain("rien n'a été modifié");
    expect(JSON.stringify(al[0])).not.toContain(KEY);
    const ev = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.tenantId, t.tenantId));
    expect(ev.some((e) => e.type === "alert.raised" && e.entityId === a.id)).toBe(true);
    expect(await openAlertCount(t.tenantId)).toBe(1);
  });

  it("écriture envoyée mais non confirmée : alerte critique « à vérifier »", async () => {
    const { t, prop, writer } = await setup("al-nonconf");
    const a = await approved(t, prop.id, "PRICE_OVERRIDE", { nightlyCents: 11000, restoresFloor: true, dates: [D1] });
    const real = writer.getOverrides.bind(writer);
    let reads = 0;
    writer.getOverrides = async (...args) => { if (++reads > 1) writer.brokenOverrideRead = true; return real(...args); };
    await expect(D.execute(t.actor, a.id, undefined)).rejects.toThrow(/non confirmée/);
    const [al] = await alertsOf(t.tenantId);
    expect(al).toMatchObject({ kind: "WRITE_UNCONFIRMED", severity: "CRITICAL", writeId: expect.any(String) });
  });

  it("précondition non remplie : alerte à surveiller, action laissée approuvée ; résolue quand l'action est écrite", async () => {
    const { t, prop, read } = await setup("al-precond");
    const a = await approved(t, prop.id, "MIN_PRICE_CHANGE", { minPriceCents: 9500, previousMinPriceCents: 7000 });
    await expect(D.execute(t.actor, a.id, undefined)).rejects.toThrow(/Précondition non remplie/);
    expect((await alertsOf(t.tenantId))[0]).toMatchObject({ kind: "PRECONDITION_FAILED", severity: "WARNING", status: "OPEN" });
    (read.scenario.listings[0] as any).min = 70; // PriceLabs revient à ce qui avait été simulé
    await D.execute(t.actor, a.id, undefined);
    expect((await alertsOf(t.tenantId))[0].status).toBe("RESOLVED");
  });

  it("jamais d'alerte pour une action de démonstration ou un échec sur un logement non réel", async () => {
    const t = await makeTenant("al-demo"), propId = await makeProperty(t.tenantId, "Démo");
    await db.update(properties).set({ isDemo: true }).where(eq(properties.id, propId));
    const a = await approved(t, propId, "MIN_PRICE_CHANGE", MIN);
    await D.execute(t.actor, a.id, undefined).catch(() => {});
    expect(await alertsOf(t.tenantId)).toHaveLength(0);
  });
});

describe("dédoublonnage, e-mail, prise en compte", () => {
  it("une seule alerte non résolue par clé ; un seul e-mail, aux rôles qui décident, sans secret ; nouvelle alerte possible après résolution", async () => {
    vi.mocked(emailConfigured).mockReturnValue(true);
    process.env.APP_URL = "https://staging.example.test";
    const t = await makeTenant("al-mail");
    await db.insert(schema.users).values({ id: newId("usr"), tenantId: t.tenantId, email: "analyste@test.local", name: "Analyste", passwordHash: "x", role: "ANALYST" });
    const input = { tenantId: t.tenantId, kind: "DRIFT" as const, title: "Écart <script>", detail: "prix minimum 105 € au lieu de 95 €", dedupeKey: "DRIFT:x:1" };
    const first = await raiseAlert(input);
    expect(first).not.toBeNull();
    expect(await raiseAlert(input)).toBeNull();
    expect(await alertsOf(t.tenantId)).toHaveLength(1);
    expect(sendEmail).toHaveBeenCalledTimes(1); // l'analyste n'est pas destinataire
    const mail = vi.mocked(sendEmail).mock.calls[0][0];
    expect(mail.to).toBe(`${t.userId}@test.local`);
    expect(mail.subject).toContain("Alerte critique");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.text).toContain("https://staging.example.test/alertes");
    expect((await alertsOf(t.tenantId))[0].notifiedAt).not.toBeNull();
    await db.update(executionAlerts).set({ status: "RESOLVED" }).where(eq(executionAlerts.tenantId, t.tenantId));
    expect(await raiseAlert(input)).not.toBeNull(); // le même écart revenu après résolution est une nouvelle alerte
    delete process.env.APP_URL;
  });

  it("e-mail non configuré : l'alerte existe quand même, sans date d'envoi", async () => {
    const t = await makeTenant("al-nomail");
    const al = await raiseAlert({ tenantId: t.tenantId, kind: "STUCK", title: "x", detail: "y", dedupeKey: "k" });
    expect(al).toMatchObject({ notifiedAt: null, status: "OPEN" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("prise en compte : réservée à ceux qui peuvent décider, une seule fois, sans effet sur les autres espaces", async () => {
    const t = await makeTenant("al-ack"), other = await makeTenant("al-ack-autre");
    const al = (await raiseAlert({ tenantId: t.tenantId, kind: "DRIFT", title: "x", detail: "y", dedupeKey: "k" }))!;
    await expect(D.acknowledge({ ...t.actor, role: "ANALYST" }, al.id)).rejects.toMatchObject({ kind: "FORBIDDEN" });
    await expect(D.acknowledge(other.actor, al.id)).rejects.toMatchObject({ kind: "NOT_FOUND" });
    await D.acknowledge(t.actor, al.id);
    expect((await alertsOf(t.tenantId))[0]).toMatchObject({ status: "ACKNOWLEDGED", acknowledgedBy: t.userId });
    await expect(D.acknowledge(t.actor, al.id)).rejects.toThrow(/déjà été prise en compte/);
    expect(await openAlertCount(t.tenantId)).toBe(0);
    expect(await acknowledgeAlert(t.tenantId, al.id, t.userId)).toBeNull();
    const ev = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.tenantId, t.tenantId));
    expect(ev.filter((e) => e.type === "alert.acknowledged")).toHaveLength(1);
    expect(ev.some((e) => e.type === "access.denied")).toBe(true);
  });
});

describe("dérive, retour arrière, action bloquée", () => {
  it("vérification en écart : alerte critique unique, résolue dès que PriceLabs redevient conforme", async () => {
    const { t, prop, read } = await setup("al-verif");
    const a = await approved(t, prop.id, "MIN_PRICE_CHANGE", MIN);
    await D.execute(t.actor, a.id, undefined);
    (read.scenario.listings[0] as any).min = 105;
    await expect(D.verify(t.actor, a.id)).rejects.toThrow(/diffère/);
    await expect(D.verify(t.actor, a.id)).rejects.toThrow(/diffère/);
    const al = await alertsOf(t.tenantId);
    expect(al).toHaveLength(1);
    expect(al[0]).toMatchObject({ kind: "DRIFT", severity: "CRITICAL", status: "OPEN" });
    (read.scenario.listings[0] as any).min = 95;
    await D.verify(t.actor, a.id);
    expect((await alertsOf(t.tenantId))[0].status).toBe("RESOLVED");
  });

  it("surveillance : écart détecté sans action humaine, relecture limitée à une par période, résolution quand tout est conforme", async () => {
    const { t, prop, read } = await setup("al-watch");
    const a = await approved(t, prop.id, "MIN_PRICE_CHANGE", MIN);
    await D.execute(t.actor, a.id, undefined);
    (read.scenario.listings[0] as any).min = 105;
    const mine = async () => alertsOf(t.tenantId);
    await runExecutionWatch(NOW);
    expect((await mine())).toHaveLength(1);
    expect((await mine())[0]).toMatchObject({ kind: "DRIFT", status: "OPEN" });
    expect((await mine())[0].detail).toContain("105");
    const [row] = await db.select().from(revenueActions).where(eq(revenueActions.id, a.id));
    expect(row.driftCheckedAt).not.toBeNull();
    // moins de 6 h plus tard : pas de nouvelle relecture, même si PriceLabs a changé
    (read.scenario.listings[0] as any).min = 95;
    await runExecutionWatch(new Date(+NOW + 3600_000));
    expect((await mine())[0].status).toBe("OPEN");
    // plus de 6 h plus tard : relecture conforme, l'alerte se referme
    await runExecutionWatch(new Date(+NOW + 7 * 3600_000));
    expect((await mine())[0]).toMatchObject({ status: "RESOLVED", resolution: expect.stringContaining("conforme") });
  });

  it("action restée en exécution : alerte, refus de la reprise trop tôt, puis action marquée interrompue et alerte résolue", async () => {
    const { t, prop } = await setup("al-stuck");
    const a = await approved(t, prop.id, "MIN_PRICE_CHANGE", MIN);
    await db.update(revenueActions).set({ status: "EXECUTING", updatedAt: new Date(+NOW - 5 * 60_000) }).where(eq(revenueActions.id, a.id));
    await runExecutionWatch(NOW);
    expect((await alertsOf(t.tenantId))).toHaveLength(0); // 5 minutes : pas encore bloquée
    await expect(D.interruptStuck(t.actor, a.id)).rejects.toThrow(/moins de 15 minutes/);
    await db.update(revenueActions).set({ updatedAt: new Date(+NOW - 30 * 60_000) }).where(eq(revenueActions.id, a.id));
    await runExecutionWatch(NOW);
    await runExecutionWatch(NOW); // idempotent
    const al = await alertsOf(t.tenantId);
    expect(al).toHaveLength(1);
    expect(al[0]).toMatchObject({ kind: "STUCK", severity: "CRITICAL", actionId: a.id });
    await expect(D.interruptStuck({ ...t.actor, role: "ANALYST" }, a.id)).rejects.toMatchObject({ kind: "FORBIDDEN" });
    await D.interruptStuck(t.actor, a.id);
    expect((await status(a.id)).status).toBe("FAILED");
    expect((await alertsOf(t.tenantId))[0].status).toBe("RESOLVED");
    // l'action en échec reste annulable : rien n'a été écrit chez PriceLabs, le retour arrière est sans envoi
    await D.rollback(t.actor, a.id, "reprise");
    expect((await status(a.id)).status).toBe("ROLLED_BACK");
  });

  it("ligne de journal restée « en préparation » depuis plus de 10 minutes : alerte ; une récente n'en lève pas", async () => {
    const { t, prop } = await setup("al-pending");
    const a = await approved(t, prop.id, "MIN_PRICE_CHANGE", MIN);
    for (const st of ["EXECUTING", "EXECUTED"]) await db.update(revenueActions).set({ status: st }).where(eq(revenueActions.id, a.id));
    const row = (age: number, key: string) => ({ id: newId("xw"), tenantId: t.tenantId, propertyId: prop.id, actionId: a.id, idempotencyKey: `${a.id}:${key}`, phase: "APPLY", kind: "LISTING_LIMITS", status: "PENDING", plan: {}, adapter: "FAKE", updatedAt: new Date(+NOW - age) });
    await db.insert(externalWrites).values(row(2 * 60_000, "A"));
    await runExecutionWatch(NOW);
    expect(await alertsOf(t.tenantId)).toHaveLength(0);
    await db.insert(externalWrites).values(row(20 * 60_000, "B"));
    await runExecutionWatch(NOW);
    const al = await alertsOf(t.tenantId);
    expect(al).toHaveLength(1);
    expect(al[0]).toMatchObject({ kind: "STUCK_WRITE", writeId: expect.any(String) });
  });

  it("retour arrière refusé (coupe-circuit) : alerte à surveiller ; retour arrière réussi ensuite : alertes de l'action résolues", async () => {
    const { t, prop } = await setup("al-rb");
    const a = await approved(t, prop.id, "MIN_PRICE_CHANGE", MIN);
    await D.execute(t.actor, a.id, undefined);
    const [ig] = await db.insert(schema.integrations).values({ id: newId("int"), tenantId: t.tenantId, provider: "pricelabs", status: "CONNECTED", capabilities: {}, killSwitch: true } as any).returning();
    await expect(D.rollback(t.actor, a.id, "test")).rejects.toThrow(/coupe-circuit/i);
    expect((await alertsOf(t.tenantId))[0]).toMatchObject({ kind: "ROLLBACK_FAILED", severity: "WARNING", status: "OPEN" });
    await db.update(schema.integrations).set({ killSwitch: false }).where(eq(schema.integrations.id, ig.id));
    await D.rollback(t.actor, a.id, "levé");
    expect((await status(a.id)).status).toBe("ROLLED_BACK");
    expect((await alertsOf(t.tenantId))[0].status).toBe("RESOLVED");
    const { active, resolved } = await listAlerts(t.tenantId);
    expect(active).toHaveLength(0); expect(resolved).toHaveLength(1);
  });

  it("après « marquer comme interrompue » puis retour arrière : la ligne de journal ne rouvre jamais l'alerte, un seul e-mail", async () => {
    vi.mocked(emailConfigured).mockReturnValue(true);
    const { t, prop } = await setup("al-boucle");
    const a = await approved(t, prop.id, "MIN_PRICE_CHANGE", MIN);
    await db.update(revenueActions).set({ status: "EXECUTING", updatedAt: new Date(+NOW - 30 * 60_000) }).where(eq(revenueActions.id, a.id));
    await db.insert(externalWrites).values({ id: newId("xw"), tenantId: t.tenantId, propertyId: prop.id, actionId: a.id, idempotencyKey: `${a.id}:APPLY`, phase: "APPLY", kind: "LISTING_LIMITS", status: "PENDING", plan: {}, adapter: "FAKE", updatedAt: new Date(+NOW - 30 * 60_000) });
    await runExecutionWatch(NOW);
    expect((await alertsOf(t.tenantId)).map((x) => x.kind).sort()).toEqual(["STUCK", "STUCK_WRITE"]);
    await D.interruptStuck(t.actor, a.id);
    const [w] = await db.select().from(externalWrites).where(eq(externalWrites.actionId, a.id));
    expect(w.status).toBe("SENT");
    const mine = () => vi.mocked(sendEmail).mock.calls.filter((c) => c[0].to === `${t.userId}@test.local`).length, mails = mine();
    for (let i = 0; i < 3; i++) await runExecutionWatch(new Date(+NOW + i * 20 * 60_000));
    expect((await alertsOf(t.tenantId)).filter((x) => x.status !== "RESOLVED")).toHaveLength(0);
    expect(mine()).toBe(mails);
  });

  it("réponse ambiguë de PriceLabs (500) : alerte « non confirmée », jamais « rien n'a été modifié »", async () => {
    const { t, prop, writer } = await setup("al-500");
    const a = await approved(t, prop.id, "MIN_PRICE_CHANGE", MIN);
    writer.failWrites = { status: 500 };
    await expect(D.execute(t.actor, a.id, undefined)).rejects.toThrow();
    const [al] = await alertsOf(t.tenantId);
    expect(al.kind).toBe("WRITE_UNCONFIRMED");
    expect(al.title).not.toContain("rien n'a été modifié");
  });

  it("alerte prise en compte puis nouveau motif : elle est rouverte avec le nouveau détail et un nouvel e-mail", async () => {
    vi.mocked(emailConfigured).mockReturnValue(true);
    const t = await makeTenant("al-reopen");
    const base = { tenantId: t.tenantId, kind: "ROLLBACK_FAILED" as const, title: "Retour arrière en échec", dedupeKey: "ROLLBACK:x" };
    const al = (await raiseAlert({ ...base, detail: "motif A" }))!;
    await D.acknowledge(t.actor, al.id);
    expect(await raiseAlert({ ...base, detail: "motif A" })).toBeNull(); // même motif : rien
    expect(await raiseAlert({ ...base, detail: "motif B" })).not.toBeNull();
    const [cur] = await alertsOf(t.tenantId);
    expect(cur).toMatchObject({ status: "OPEN", detail: "motif B", acknowledgedBy: null });
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it("un refus certain pris en compte se referme ; un nouvel écart remplace l'ancien ; une action rejetée ferme ses alertes", async () => {
    const t = await makeTenant("al-close");
    const w = (await raiseAlert({ tenantId: t.tenantId, kind: "WRITE_FAILED", title: "refus", detail: "d", dedupeKey: "F:1" }))!;
    await D.acknowledge(t.actor, w.id);
    expect((await alertsOf(t.tenantId))[0].status).toBe("RESOLVED");
  });

  it("dérive : les nuits passées et les écritures remplacées par une plus récente ne sont pas des dérives", async () => {
    const { t, prop, writer } = await setup("al-ancien");
    const a = await approved(t, prop.id, "PRICE_OVERRIDE", { nightlyCents: 11000, restoresFloor: true, dates: [D1] });
    await D.execute(t.actor, a.id, undefined);
    await writer.deleteOverrides(FAKE_LISTING_ID, "superhote", [D1]); // le prix daté a disparu chez PriceLabs
    await runExecutionWatch(new Date(+NOW + 40 * 86400_000)); // la nuit est passée : rien à contrôler
    expect(await alertsOf(t.tenantId)).toHaveLength(0);
    await db.update(revenueActions).set({ driftCheckedAt: null }).where(eq(revenueActions.id, a.id));
    await runExecutionWatch(NOW); // nuit à venir : l'écart est réel
    expect((await alertsOf(t.tenantId))[0]).toMatchObject({ kind: "DRIFT" });
  });

  it("relecture impossible : alerte à surveiller, nouvel essai dans l'heure, résolue dès que la lecture revient", async () => {
    const { t, prop, writer } = await setup("al-illisible");
    const a = await approved(t, prop.id, "PRICE_OVERRIDE", { nightlyCents: 11000, restoresFloor: true, dates: [D1] });
    await D.execute(t.actor, a.id, undefined);
    writer.brokenOverrideRead = true;
    await runExecutionWatch(NOW);
    expect((await alertsOf(t.tenantId))[0]).toMatchObject({ kind: "UNREADABLE", severity: "WARNING", status: "OPEN" });
    writer.brokenOverrideRead = false;
    await runExecutionWatch(new Date(+NOW + 90 * 60_000));
    expect((await alertsOf(t.tenantId))[0].status).toBe("RESOLVED");
  });

  it("isolation : les alertes d'un espace ne sont jamais listées pour un autre", async () => {
    const a = await makeTenant("al-iso-a"), b = await makeTenant("al-iso-b");
    await raiseAlert({ tenantId: a.tenantId, kind: "DRIFT", title: "secret de A", detail: "y", dedupeKey: "k" });
    const lb = await listAlerts(b.tenantId);
    expect(lb.active).toHaveLength(0);
    expect(await openAlertCount(b.tenantId)).toBe(0);
    expect(await raiseAlert({ tenantId: b.tenantId, kind: "DRIFT", title: "autre", detail: "y", dedupeKey: "k" })).not.toBeNull(); // même clé, autre espace
    expect((await listAlerts(a.tenantId)).active.some((x) => x.title === "autre")).toBe(false);
    void and;
  });
});
