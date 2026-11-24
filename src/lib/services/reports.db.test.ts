import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { todayISO } from "@/lib/dates";
import { lastMonths } from "@/lib/engine/metrics";
import type { Role } from "@/lib/rbac";
import { draftNarrative } from "@/lib/reports/monthly";
import { makeTenant } from "@/test/db";
import { certifyReport, draftReport, getCertifiedReport, getReport, listMeasures, listReportHistory, listReports, loadSnapshot, propertyName, recordExport, ReportError, reportHash, saveReport } from "./reports";
import { seedDemo } from "./seed";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T, other: T, propertyId: string, otherProperty: string;
const as = (role: Role) => ({ ...t.actor, role });
const [MONTH, OLDER] = [lastMonths(todayISO(), 1)[0], lastMonths(todayISO(), 3)[0]];
const refused = async (p: PromiseLike<unknown>, code: string, re?: RegExp) => {
  const e = await Promise.resolve(p).then(() => null, (x) => x);
  expect(e, "aurait dû être refusé").toBeInstanceOf(ReportError);
  expect((e as ReportError).code).toBe(code);
  if (re) expect((e as ReportError).message).toMatch(re);
};
const frozen = async (p: PromiseLike<unknown>) => {
  const err = await Promise.resolve(p).then(() => null, (e) => e as { message?: string; cause?: { message?: string } });
  expect(err, "la modification aurait dû être refusée").not.toBeNull();
  expect(`${err!.message} ${err!.cause?.message ?? ""}`).toMatch(/figé/);
};
const KEEP = (r: { snapshot: any }) => `${r.snapshot.unknowns.contribution} ${r.snapshot.unknowns.objective} Sans période témoin, aucun effet n'est attribué aux actions.`;
const audits = (type: string, tenantId = t.tenantId) => db.execute(sql`select summary, payload, entity_id from audit_events where tenant_id = ${tenantId} and type = ${type} order by created_at`).then((r) => r.rows as { summary: string; payload: any; entity_id: string }[]);

beforeAll(async () => {
  t = await makeTenant("rapports"); other = await makeTenant("rapports-autre");
  await seedDemo(t.tenantId); await seedDemo(other.tenantId);
  propertyId = (await db.select().from(schema.properties).where(eq(schema.properties.tenantId, t.tenantId)))[0].id;
  otherProperty = (await db.select().from(schema.properties).where(eq(schema.properties.tenantId, other.tenantId)))[0].id;
}, 180_000);

describe("rapport mensuel certifié (US-112)", () => {
  it("l'instantané est lu en base : mois, logement, tendances nommées, contribution et objectif dits inconnus", async () => {
    const s = await loadSnapshot(t.tenantId, propertyId, MONTH);
    expect(s.month).toBe(MONTH);
    expect(s.property.id).toBe(propertyId);
    for (const tr of Object.values(s.trends)) expect(["croissante", "stable", "décroissante", "inconnue"]).toContain(tr);
    expect(s.unknowns.contribution).toMatch(/non calculée/);
    expect(s.unknowns.objective).toMatch(/inconnu/);
    expect(s.kpis.available).toBeGreaterThan(0);
  });

  it("préparer : brouillon version 1, texte automatique, audit ; un autre espace ne voit rien", async () => {
    const r = await draftReport(as("OWNER"), propertyId, MONTH);
    expect(r).toMatchObject({ status: "DRAFT", version: 1, month: MONTH, edited: false, certifiedAt: null });
    expect(r.narrative).toBe(draftNarrative(r.snapshot));
    const a = await audits("report.drafted");
    expect(a).toHaveLength(1);
    expect(a[0].entity_id).toBe(r.id);
    expect(await getReport(other.tenantId, r.id)).toBeNull();
    expect(await listReports(other.tenantId)).toEqual([]);
    expect((await listReports(t.tenantId, propertyId)).map((x) => x.id)).toEqual([r.id]);
  });

  it("droits : seuls les rôles de décision préparent, retouchent et certifient ; le refus est journalisé", async () => {
    const r = (await listReports(t.tenantId, propertyId))[0];
    for (const role of ["ANALYST", "OTA_OPERATOR", "OWNER_VIEWER", "AUDITOR"] as Role[]) {
      await refused(draftReport(as(role), propertyId, MONTH), "FORBIDDEN", /ne permet pas/);
      await refused(saveReport(as(role), r.id, "Texte."), "FORBIDDEN");
      await refused(certifyReport(as(role), r.id), "FORBIDDEN");
    }
    expect((await audits("access.denied")).length).toBeGreaterThanOrEqual(12);
    expect((await getReport(t.tenantId, r.id))!.status).toBe("DRAFT");
  });

  it("mois non ouvert (en cours, futur, trop ancien) et logement d'un autre espace refusés", async () => {
    await refused(draftReport(as("OWNER"), propertyId, todayISO().slice(0, 7)), "INVALID", /mois terminés/);
    await refused(draftReport(as("OWNER"), propertyId, "2099-01"), "INVALID");
    await refused(draftReport(as("OWNER"), propertyId, "2000-01"), "INVALID");
    await refused(draftReport(as("OWNER"), otherProperty, MONTH), "NOT_FOUND");
  });

  it("retoucher : un texte avec un nombre inventé est refusé sans rien écrire ; un texte valide est enregistré et marqué retouché", async () => {
    const r = (await listReports(t.tenantId, propertyId))[0];
    await refused(saveReport(as("OWNER"), r.id, `Le revenu net a progressé de 98765 %.\n\n${KEEP(r)}`), "INVALID", /98765/);
    await refused(saveReport(as("OWNER"), r.id, "   "), "INVALID");
    expect((await getReport(t.tenantId, r.id))!.narrative).toBe(r.narrative);
    await refused(saveReport(as("OWNER"), r.id, "Mois calme, tendance à suivre."), "INVALID", /Contribution non calculée/);
    await refused(saveReport(as("OWNER"), r.id, `Grâce à nos actions, tout va bien.\n\n${KEEP(r)}`), "INVALID", /attribue un effet/);
    const ok = await saveReport(as("OWNER"), r.id, `Mois calme, tendance à suivre.\n\n${KEEP(r)}`);
    expect(ok.edited).toBe(true);
    expect(ok.narrative).toContain("Mois calme");
    expect(await audits("report.edited")).toHaveLength(1);
  });

  it("régénérer un brouillon retouché exige une confirmation explicite ; sans retouche, les chiffres sont simplement actualisés", async () => {
    await refused(draftReport(as("OWNER"), propertyId, MONTH), "CONFLICT", /retouché/);
    const again = await draftReport(as("OWNER"), propertyId, MONTH, { replaceEdits: true });
    expect(again.version).toBe(1);
    expect(again.edited).toBe(false);
    expect(again.narrative).toBe(draftNarrative(again.snapshot));
    expect(await listReports(t.tenantId, propertyId)).toHaveLength(1);
    const refreshed = await draftReport(as("OWNER"), propertyId, MONTH);
    expect(refreshed.id).toBe(again.id);
  });

  it("certifier : texte revérifié, empreinte du contenu, figé par la base ; une seconde certification est refusée", async () => {
    const d = (await listReports(t.tenantId, propertyId))[0];
    const c = await certifyReport(as("REVENUE_MANAGER"), d.id);
    expect(c.status).toBe("CERTIFIED");
    expect(c.certifiedBy).toBe(`user:${t.userId}`);
    expect(c.certifiedHash).toBe(reportHash(c.snapshot, c.narrative));
    expect(c.certifiedAt).toBeTruthy();
    expect(await audits("report.certified")).toHaveLength(1);
    await refused(certifyReport(as("OWNER"), d.id), "CONFLICT", /déjà certifié/);
    await refused(saveReport(as("OWNER"), d.id, "Autre texte."), "CONFLICT", /certifié/);
    // même un accès direct à la base ne peut plus rien changer
    await frozen(db.update(schema.monthlyReports).set({ narrative: "Falsifié" }).where(eq(schema.monthlyReports.id, d.id)));
    await frozen(db.update(schema.monthlyReports).set({ snapshot: { falsifie: true } }).where(eq(schema.monthlyReports.id, d.id)));
    await frozen(db.update(schema.monthlyReports).set({ certifiedHash: "x" }).where(eq(schema.monthlyReports.id, d.id)));
    expect((await getReport(t.tenantId, d.id))!.narrative).toBe(c.narrative);
  });

  it("la certification porte sur le texte fourni, vérifié sous verrou ; un instantané trop ancien ne se certifie pas ; le rapport certifié ne se supprime pas directement", async () => {
    const m = lastMonths(todayISO(), 6)[0];
    const d = await draftReport(as("OWNER"), propertyId, m);
    // texte affiché mais jamais enregistré : c'est lui qui est certifié, et il est contrôlé
    await refused(certifyReport(as("OWNER"), d.id, "Mois calme."), "INVALID", /Contribution non calculée/);
    await refused(certifyReport(as("OWNER"), d.id, `Invention de 98765 nuits.\n\n${KEEP(d)}`), "INVALID", /98765/);
    expect((await getReport(t.tenantId, d.id))!.status).toBe("DRAFT");
    const later = new Date(Date.now() + 8 * 86_400_000);
    await refused(certifyReport(as("OWNER"), d.id, undefined, later), "INVALID", /plus de 7 jours/);
    const c = await certifyReport(as("OWNER"), d.id, `Relu et validé.\n\n${KEEP(d)}`);
    expect(c.narrative).toContain("Relu et validé.");
    expect(c.certifiedHash).toBe(reportHash(c.snapshot, c.narrative));
    const del = await Promise.resolve(db.delete(schema.monthlyReports).where(eq(schema.monthlyReports.id, c.id))).then(() => null, (e) => e as { message?: string; cause?: { message?: string } });
    expect(`${del?.message} ${del?.cause?.message ?? ""}`).toMatch(/ne se supprime pas/);
    expect(await getReport(t.tenantId, c.id)).not.toBeNull();
  });

  it("régénération et certification simultanées : ce qui est certifié est cohérent avec l'instantané enregistré", async () => {
    const m = lastMonths(todayISO(), 7)[0];
    const d = await draftReport(as("OWNER"), propertyId, m);
    const res = await Promise.allSettled([certifyReport(as("OWNER"), d.id), draftReport(as("OWNER"), propertyId, m)]);
    const row = (await getReport(t.tenantId, d.id))!;
    if (row.status === "CERTIFIED") expect(row.certifiedHash).toBe(reportHash(row.snapshot, row.narrative));
    expect(res.some((x) => x.status === "fulfilled")).toBe(true);
  });

  it("corriger : une nouvelle version s'ouvre, la certifiée reste intacte ; un seul brouillon à la fois ; la nouvelle version se certifie à son tour", async () => {
    const v1 = (await listReports(t.tenantId, propertyId))[0];
    const v2 = await draftReport(as("OWNER"), propertyId, MONTH);
    expect(v2).toMatchObject({ version: 2, status: "DRAFT" });
    expect(v2.id).not.toBe(v1.id);
    expect((await getReport(t.tenantId, v1.id))!.status).toBe("CERTIFIED");
    expect((await audits("report.reopened")).filter((a) => a.payload.month === MONTH)).toHaveLength(1);
    const same = await draftReport(as("OWNER"), propertyId, MONTH);
    expect(same.id).toBe(v2.id);
    const c2 = await certifyReport(as("OWNER"), v2.id);
    expect(c2.status).toBe("CERTIFIED");
    expect((await listReports(t.tenantId, propertyId)).filter((r) => r.month === MONTH).map((r) => r.version)).toEqual([2, 1]);
  });

  it("un autre mois a ses propres versions ; la base refuse de changer l'identité d'un brouillon, d'écrire un statut inconnu ou une certification sans signataire", async () => {
    const o = await draftReport(as("OWNER"), propertyId, OLDER);
    expect(o.version).toBe(1);
    const row = db.update(schema.monthlyReports);
    await expect(Promise.resolve(row.set({ month: MONTH }).where(eq(schema.monthlyReports.id, o.id)))).rejects.toThrow();
    await expect(Promise.resolve(db.update(schema.monthlyReports).set({ status: "AUTRE" }).where(eq(schema.monthlyReports.id, o.id)))).rejects.toThrow();
    await expect(Promise.resolve(db.update(schema.monthlyReports).set({ status: "CERTIFIED" }).where(eq(schema.monthlyReports.id, o.id)))).rejects.toThrow();
    expect((await getReport(t.tenantId, o.id))!.status).toBe("DRAFT");
  });

  it("deux certifications simultanées : une seule aboutit", async () => {
    const o = (await listReports(t.tenantId, propertyId)).find((r) => r.month === OLDER)!;
    const res = await Promise.allSettled([certifyReport(as("OWNER"), o.id), certifyReport(as("OWNER"), o.id)]);
    expect(res.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((await audits("report.certified")).filter((a) => a.entity_id === o.id)).toHaveLength(1);
  });

  it("isolation : un autre espace ne peut ni lire ni certifier ce rapport", async () => {
    const r = (await listReports(t.tenantId, propertyId))[0];
    await refused(certifyReport({ ...other.actor }, r.id), "NOT_FOUND");
    await refused(saveReport({ ...other.actor }, r.id, "x"), "NOT_FOUND");
    const rows = await db.select().from(schema.monthlyReports).where(and(eq(schema.monthlyReports.tenantId, other.tenantId)));
    expect(rows).toEqual([]);
  });

  it("export (US-113) : seul un rapport certifié s'exporte, l'espace voisin ne le voit pas, l'export est tracé", async () => {
    const m = lastMonths(todayISO(), 8)[0];
    const d = await draftReport(as("OWNER"), propertyId, m);
    await refused(getCertifiedReport(t.tenantId, d.id), "CONFLICT", /pas certifié/);
    const c = await certifyReport(as("OWNER"), d.id);
    expect((await getCertifiedReport(t.tenantId, c.id)).certifiedHash).toBe(c.certifiedHash);
    await refused(getCertifiedReport(other.tenantId, c.id), "NOT_FOUND");
    await recordExport(as("ANALYST"), "MonthlyReport", c.id, "Export de test.", { format: "pdf" });
    const a = await audits("report.exported");
    expect(a).toHaveLength(1);
    expect(a[0].entity_id).toBe(c.id);
    expect(await propertyName(t.tenantId, propertyId)).toBeTruthy();
    await expect(propertyName(other.tenantId, propertyId)).rejects.toBeInstanceOf(ReportError);
  });

  it("historique (US-113) : filtres état et année sur les rapports, résultat sur les mesures, isolation par espace", async () => {
    const none = { etat: null, annee: null, resultat: null } as const;
    const all = await listReportHistory(t.tenantId, propertyId, none);
    expect(all.length).toBeGreaterThanOrEqual(4);
    const cert = await listReportHistory(t.tenantId, propertyId, { ...none, etat: "CERTIFIED" });
    expect(cert.every((r) => r.status === "CERTIFIED")).toBe(true);
    expect(cert.length).toBeLessThan(all.length + 1);
    const y = all[0].month.slice(0, 4);
    expect((await listReportHistory(t.tenantId, propertyId, { ...none, annee: y })).every((r) => r.month.startsWith(y))).toBe(true);
    expect(await listReportHistory(t.tenantId, propertyId, { ...none, annee: "1999" })).toEqual([]);
    expect(await listReportHistory(other.tenantId, propertyId, none)).toEqual([]);
    const ms = await listMeasures(t.tenantId, propertyId, none);
    expect(ms.length).toBeGreaterThan(0);
    const out = ms[0].outcome;
    expect((await listMeasures(t.tenantId, propertyId, { ...none, resultat: out })).every((x) => x.outcome === out)).toBe(true);
    expect(await listMeasures(other.tenantId, propertyId, none)).toEqual([]);
  });
});

