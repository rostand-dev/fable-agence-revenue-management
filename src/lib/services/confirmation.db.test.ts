import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { listAuditEvents } from "@/lib/audit/query";
import { todayISO } from "@/lib/dates";
import type { Role } from "@/lib/rbac";
import { makeTenant } from "@/test/db";
import type { Candidate } from "../engine/types";
import * as D from "./decisions";
import { seedDemo } from "./seed";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T, actionId: string;
const as = (role: Role) => ({ ...t.actor, role });
const action = async () => (await db.select().from(schema.revenueActions).where(eq(schema.revenueActions.id, actionId)))[0];
const alerts = () => db.select().from(schema.executionAlerts).where(and(eq(schema.executionAlerts.tenantId, t.tenantId), eq(schema.executionAlerts.actionId, actionId), eq(schema.executionAlerts.kind, "PROMO_MISMATCH")));
const promosOf = () => db.select().from(schema.promotions).where(and(eq(schema.promotions.tenantId, t.tenantId), eq(schema.promotions.actionId, actionId)));
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { if (e instanceof D.DecisionError) return e; throw e; } throw new Error("aurait dû échouer"); };
const OK = { scope: "Promotion posée sur Booking.com, 8 %, séjours de décembre", date: todayISO(), proof: "", externalRef: "BK-PROMO-42" };

// approuve une action manuelle approuvable encore inutilisée et lui donne le type et les paramètres voulus
async function approveManual(type: string, parameters: Record<string, unknown>): Promise<string> {
  // la démonstration n'a que peu d'actions manuelles approuvables : on clone le dossier de l'action de départ (nouvel identifiant, nouveau code), puis on suit la machine à états
  const [src] = await db.select().from(schema.revenueActions).where(eq(schema.revenueActions.id, actionId));
  const [o] = await db.select().from(schema.opportunities).where(eq(schema.opportunities.id, src.opportunityId));
  const n = `${++seq}${Date.now().toString(36)}`;
  await db.insert(schema.opportunities).values({ ...o, id: `opp_cf_${n}`, code: `CF-${n}` });
  const id = `act_cf_${n}`;
  await db.insert(schema.revenueActions).values({ ...src, id, opportunityId: `opp_cf_${n}`, idempotencyKey: `cf-${n}`, status: "DRAFT", executedAt: null, execution: null, verifiedAt: null, measureDueAt: null, measurement: null, approvedAt: null, type: type as any, target: { system: "BOOKING", channel: "BOOKING" }, parameters } as any);
  for (const st of ["SIMULATED", "AUDITED", "PENDING_APPROVAL"]) await db.update(schema.revenueActions).set({ status: st as any }).where(eq(schema.revenueActions.id, id));
  await db.update(schema.revenueActions).set({ status: "APPROVED", approvedAt: new Date() }).where(eq(schema.revenueActions.id, id));
  return id;
}
let seq = 0;

beforeAll(async () => {
  t = await makeTenant("confirmation"); await seedDemo(t.tenantId);
  const opps = await db.select().from(schema.opportunities).where(and(eq(schema.opportunities.tenantId, t.tenantId), eq(schema.opportunities.status, "OPEN")));
  // La démonstration ne contient aucune promotion de canal approuvable (l'auditeur les rejette) : on approuve une action manuelle approuvable,
  // puis on lui donne la forme d'une promotion de canal pour exercer la confirmation (type, canal, paramètres).
  for (const o of opps) {
    const i = (o.candidates as Candidate[]).findIndex((c) => c.type !== "NO_ACTION" && c.audit.verdict !== "REJECT" && c.executionMode === "MANUAL_RUNBOOK");
    if (i < 0) continue;
    await D.approve(as("OWNER"), o.id, i, "Validé après relecture du dossier.");
    actionId = (await db.select().from(schema.revenueActions).where(eq(schema.revenueActions.opportunityId, o.id)))[0].id;
    await db.update(schema.revenueActions).set({ type: "CHANNEL_PROMO", target: { system: "BOOKING", channel: "BOOKING" }, parameters: { kind: "MOBILE", discountPct: 8, label: "Mobile 8 %", stayFrom: "2026-12-10", stayTo: "2026-12-20", minLos: 3 } }).where(eq(schema.revenueActions.id, actionId));
    break;
  }
  if (!actionId) throw new Error("aucune promotion de canal manuelle approuvable dans la démonstration");
}, 120_000);

describe("confirmation de l'opérateur (US-103)", () => {
  it("promotion sans identifiant ni preuve, ou datée dans le futur : refusée, l'action reste approuvée, rien n'est inscrit", async () => {
    const e = await fail(D.execute(as("OWNER"), actionId, { ...OK, externalRef: "" }));
    expect(e).toMatchObject({ kind: "VALIDATION" }); expect(e.message).toContain("identifiant");
    expect((await fail(D.execute(as("OWNER"), actionId, { ...OK, date: "2999-01-01" }))).message).toContain("futur");
    expect((await fail(D.execute(as("OWNER"), actionId, undefined))).kind).toBe("VALIDATION");
    expect((await action()).status).toBe("APPROVED");
    expect(await promosOf()).toHaveLength(0);
  });

  it("écart : arrête sans rien appliquer, ouvre un incident, journalise ; rejouable sans second incident", async () => {
    expect((await fail(D.reportMismatch(as("OWNER"), actionId, "non"))).kind).toBe("VALIDATION");
    await expect(D.reportMismatch(as("ANALYST"), actionId, "Booking affiche 12 % au lieu de 8 %.")).rejects.toBeInstanceOf(D.ForbiddenError);
    expect(await alerts()).toHaveLength(0);
    await D.reportMismatch(as("OTA_OPERATOR"), actionId, "Booking affiche 12 % au lieu de 8 %.");
    await D.reportMismatch(as("OTA_OPERATOR"), actionId, "Booking affiche 12 % au lieu de 8 %.");
    const a = await alerts();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ status: "OPEN", severity: "WARNING" });
    expect(a[0].detail).toContain("12 %");
    expect((await action()).status).toBe("APPROVED");
    expect(await promosOf()).toHaveLength(0);
    const ev = (await listAuditEvents(t.tenantId, { limit: 300 })).events.filter((e) => e.type === "action.mismatch_reported");
    expect(ev.length).toBeGreaterThanOrEqual(1);
    expect(ev[0].entityId).toBe(actionId);
  });

  it("confirmation : exécutée, promotion inscrite au registre avec identifiant, preuve, date d'effet et lien vers l'action ; incident résolu", async () => {
    await D.execute(as("OTA_OPERATOR"), actionId, { ...OK, proof: "capture : https://exemple.test/c/42" });
    const a = await action();
    expect(a.status).toBe("EXECUTED");
    expect(a.execution).toMatchObject({ mode: "MANUAL_DECLARED", externalRef: "BK-PROMO-42", proof: "capture : https://exemple.test/c/42", declaredDate: OK.date });
    expect(a.execution.runbook).toMatchObject({ done: 0 });
    const [p] = await promosOf();
    expect(p).toMatchObject({ source: "DECLARED", status: "ACTIVE", externalRef: "BK-PROMO-42", proof: "capture : https://exemple.test/c/42", effectiveOn: OK.date, actionId, kind: "MOBILE", channel: "BOOKING", minLos: 3 });
    expect(p.verifiedAt).not.toBeNull();
    expect((await alerts())[0].status).toBe("RESOLVED");
    const ex = (await listAuditEvents(t.tenantId, { limit: 300 })).events.find((e) => e.type === "action.executed" && e.entityId === actionId);
    expect((ex!.payload as any).externalRef).toBe("BK-PROMO-42");
  });

  it("après confirmation, un écart ne peut plus arrêter l'action", async () => {
    expect((await fail(D.reportMismatch(as("OWNER"), actionId, "Écart signalé trop tard pour le test."))).kind).toBe("CONFLICT");
  });

  it("retrait d'une promotion : date, preuve et identifiant conservés au registre ; promotion introuvable ou déjà terminée : refus", async () => {
    const [prop] = await db.select().from(schema.properties).where(eq(schema.properties.tenantId, t.tenantId));
    const mk = async (id: string, status: "ACTIVE" | "ENDED") => { await db.insert(schema.promotions).values({ id, tenantId: t.tenantId, propertyId: prop.id, channel: "BOOKING", kind: "MOBILE", label: "À retirer", discountPct: 10, stayFrom: "2026-12-01", stayTo: "2026-12-31", status, source: "DECLARED" } as any); };
    await mk("promo-rm-ok", "ACTIVE"); await mk("promo-rm-done", "ENDED");
    const bad = await approveManual("PROMO_REMOVAL", { promotionId: "promo-rm-done" });
    expect((await fail(D.execute(as("OWNER"), bad, { ...OK, externalRef: "BK-RM-0" }))).message).toContain("introuvable ou déjà terminée");
    expect((await db.select().from(schema.revenueActions).where(eq(schema.revenueActions.id, bad)))[0].status).toBe("APPROVED");
    const good = await approveManual("PROMO_REMOVAL", { promotionId: "promo-rm-ok" });
    await D.execute(as("OWNER"), good, { ...OK, externalRef: "BK-RM-1" });
    const [p] = await db.select().from(schema.promotions).where(eq(schema.promotions.id, "promo-rm-ok"));
    expect(p).toMatchObject({ status: "ENDED", externalRef: "BK-RM-1", actionId: good });
    expect(p.endedAt!.toISOString().slice(0, 10)).toBe(OK.date);
  });

  it("relecture du calendrier (PB-08) : confirmée sans dater les promotions du canal comme vérifiées ; la vérification du registre (PB-10) le fait", async () => {
    const [prop] = await db.select().from(schema.properties).where(eq(schema.properties.tenantId, t.tenantId));
    await db.insert(schema.promotions).values({ id: "promo-cal-1", tenantId: t.tenantId, propertyId: prop.id, channel: "BOOKING", kind: "MOBILE", label: "Jamais relue", discountPct: 10, stayFrom: "2026-12-01", stayTo: "2026-12-31", status: "ACTIVE", source: "DECLARED", verifiedAt: null } as any);
    const cal = await approveManual("INVESTIGATION", { channel: "BOOKING", subject: "CALENDAR", dates: ["2026-12-10"] });
    await D.execute(as("OWNER"), cal, { ...OK, externalRef: "CAL-1" });
    expect((await db.select().from(schema.promotions).where(eq(schema.promotions.id, "promo-cal-1")))[0].verifiedAt).toBeNull();
    const reg = await approveManual("INVESTIGATION", { channel: "BOOKING" });
    await D.execute(as("OWNER"), reg, { ...OK, externalRef: "REG-1" });
    expect((await db.select().from(schema.promotions).where(eq(schema.promotions.id, "promo-cal-1")))[0].verifiedAt).not.toBeNull();
  });

  it("offre de durée de séjour (PB-09) confirmée : une promotion LOS avec son séjour minimal entre au registre", async () => {
    const id = await approveManual("CHANNEL_PROMO", { kind: "LOS", discountPct: 10, label: "Séjour de 7 nuits et plus", stayFrom: "2027-01-10", stayTo: "2027-02-07", minLos: 7 });
    await D.execute(as("OWNER"), id, { ...OK, externalRef: "ABB-LOS-1" });
    const [p] = await db.select().from(schema.promotions).where(eq(schema.promotions.actionId, id));
    expect(p).toMatchObject({ kind: "LOS", minLos: 7, discountPct: 10, stayFrom: "2027-01-10", stayTo: "2027-02-07", status: "ACTIVE", externalRef: "ABB-LOS-1" });
  });

  it("date d'effet antérieure à l'approbation : refusée", async () => {
    const id = await approveManual("INVESTIGATION", { channel: "BOOKING" });
    expect((await fail(D.execute(as("OWNER"), id, { ...OK, date: "2020-01-01" }))).message).toContain("précéder l'approbation");
  });

  it("deux confirmations simultanées : une seule promotion ; une action d'un autre tenant est introuvable", async () => {
    const id = await approveManual("CHANNEL_PROMO", { kind: "MOBILE", discountPct: 5, label: "Mobile 5 %", stayFrom: "2026-12-21", stayTo: "2026-12-28", minLos: 2 });
    const r = await Promise.allSettled([D.execute(as("OWNER"), id, OK), D.execute(as("OWNER"), id, OK)]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(schema.promotions).where(eq(schema.promotions.actionId, id))).toHaveLength(1);
    const other = await makeTenant("confirmation-autre");
    await expect(D.execute({ ...other.actor, role: "OWNER" as Role }, id, OK)).rejects.toThrow();
    await expect(D.reportMismatch({ ...other.actor, role: "OWNER" as Role }, id, "Écart venu d'un autre tenant.")).rejects.toThrow();
  });
});
