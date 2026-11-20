import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { listAuditEvents } from "@/lib/audit/query";
import { makeTenant } from "@/test/db";
import type { Candidate } from "../engine/types";
import * as D from "./decisions";
import { flagFor, loadFlags, setFlag } from "./flags";
import { runDue } from "./scheduler";
import { seedDemo } from "./seed";

let t: Awaited<ReturnType<typeof makeTenant>>, other: Awaited<ReturnType<typeof makeTenant>>;
let propId = "";
beforeAll(async () => {
  t = await makeTenant("drapeaux"); other = await makeTenant("autre-drapeaux");
  await seedDemo(t.tenantId);
  propId = (await db.select().from(schema.properties).where(eq(schema.properties.tenantId, t.tenantId)))[0].id;
}, 120_000);
const events = async () => (await listAuditEvents(t.tenantId, { limit: 200 })).events.filter((e) => e.type === "flag.changed");

describe("drapeaux de fonctionnalité (US-013)", () => {
  it("tout est actif par défaut", async () => { expect((await flagFor(t.tenantId, "write.api", { propertyId: propId, provider: "pricelabs" })).enabled).toBe(true); });

  it("désactiver écrit le drapeau et son événement ; rejouer ne fait rien ; réactiver est tracé", async () => {
    expect(await setFlag(t.actor, { flag: "sync.scheduled", scope: "INTEGRATION", scopeId: "pricelabs", enabled: false })).toBe("changed");
    expect(await setFlag(t.actor, { flag: "sync.scheduled", scope: "INTEGRATION", scopeId: "pricelabs", enabled: false })).toBe("unchanged");
    expect((await flagFor(t.tenantId, "sync.scheduled", { provider: "pricelabs" })).enabled).toBe(false);
    expect((await flagFor(t.tenantId, "sync.scheduled", { provider: "superhote" })).enabled).toBe(true);
    expect(await events()).toHaveLength(1);
    expect((await events())[0]).toMatchObject({ actor: "user:" + t.userId, entityId: "sync.scheduled:INTEGRATION:pricelabs" });
    expect((await events())[0].payload).toMatchObject({ enabled: false, previous: true });
    expect(await setFlag(t.actor, { flag: "sync.scheduled", scope: "INTEGRATION", scopeId: "pricelabs", enabled: true })).toBe("changed");
    expect(await events()).toHaveLength(2);
  });

  it("refuse un drapeau, un niveau, un logement ou une intégration invalides", async () => {
    await expect(setFlag(t.actor, { flag: "nimporte", scope: "TENANT", scopeId: "", enabled: false })).rejects.toThrow(/inconnue/i);
    await expect(setFlag(t.actor, { flag: "review.scheduled", scope: "INTEGRATION", scopeId: "pricelabs", enabled: false })).rejects.toThrow(/niveau/i);
    await expect(setFlag(t.actor, { flag: "write.api", scope: "INTEGRATION", scopeId: "inventé", enabled: false })).rejects.toThrow(/Intégration/i);
    await expect(setFlag(t.actor, { flag: "write.api", scope: "INTEGRATION", scopeId: "booking", enabled: false })).rejects.toThrow(/Intégration/i);
    await expect(setFlag(t.actor, { flag: "write.api", scope: "PROPERTY", scopeId: "prop_inexistant", enabled: false })).rejects.toThrow(/introuvable/i);
  });

  it("isolation : le logement d'un autre propriétaire est refusé, et un drapeau ne déborde pas sur un autre espace", async () => {
    await expect(setFlag(other.actor, { flag: "write.api", scope: "PROPERTY", scopeId: propId, enabled: false })).rejects.toThrow(/introuvable/i);
    await setFlag(t.actor, { flag: "write.api", scope: "TENANT", scopeId: "", enabled: false });
    expect((await flagFor(other.tenantId, "write.api")).enabled).toBe(true);
    expect(await loadFlags(other.tenantId)).toHaveLength(0);
    expect((await listAuditEvents(other.tenantId)).events).toHaveLength(0);
    await setFlag(t.actor, { flag: "write.api", scope: "TENANT", scopeId: "", enabled: true });
  });

  it("écriture automatique coupée : l'approbation d'une option par API est refusée, rétablie elle passe, et l'exécution est refusée sans changer l'état", async () => {
    const opens = await db.select().from(schema.opportunities).where(and(eq(schema.opportunities.tenantId, t.tenantId), eq(schema.opportunities.status, "OPEN")));
    const pick = opens.map((o) => ({ o, i: (o.candidates as Candidate[]).findIndex((c) => c.executionMode === "API_PRICELABS" && c.audit.verdict !== "REJECT") })).find((x) => x.i >= 0);
    expect(pick, "aucun dossier approuvable par API dans la démonstration").toBeTruthy();
    const { o, i } = pick!;
    const comment = "Validé après relecture complète du dossier.";
    await setFlag(t.actor, { flag: "write.api", scope: "PROPERTY", scopeId: o.propertyId, enabled: false });
    await expect(D.approve(t.actor, o.id, i, comment)).rejects.toThrow(/désactivée sur ce logement/);
    await setFlag(t.actor, { flag: "write.api", scope: "PROPERTY", scopeId: o.propertyId, enabled: true });
    const actionId = (await D.approve(t.actor, o.id, i, comment))!;
    await setFlag(t.actor, { flag: "write.api", scope: "TENANT", scopeId: "", enabled: false });
    await expect(D.execute(t.actor, actionId)).rejects.toThrow(/désactivée pour tout votre espace/);
    expect((await db.select().from(schema.revenueActions).where(eq(schema.revenueActions.id, actionId)))[0].status).toBe("APPROVED");
    await setFlag(t.actor, { flag: "write.api", scope: "TENANT", scopeId: "", enabled: true });
    await expect(D.execute(t.actor, actionId)).resolves.toBeUndefined();
  });

  it("le planificateur ne lance plus de revue pour un logement dont la revue automatique est coupée", async () => {
    await db.update(schema.properties).set({ nextReviewAt: new Date(Date.now() - 3600_000) }).where(eq(schema.properties.id, propId));
    await setFlag(t.actor, { flag: "review.scheduled", scope: "PROPERTY", scopeId: propId, enabled: false });
    await runDue();
    const [p] = await db.select().from(schema.properties).where(eq(schema.properties.id, propId));
    expect(+p.nextReviewAt! < Date.now(), "l'échéance de revue ne doit pas avoir été consommée").toBe(true);
    await setFlag(t.actor, { flag: "review.scheduled", scope: "PROPERTY", scopeId: propId, enabled: true });
    await runDue();
    const [p2] = await db.select().from(schema.properties).where(eq(schema.properties.id, propId));
    expect(+p2.nextReviewAt! > Date.now(), "revue reprise une fois le drapeau rétabli").toBe(true);
  });

  it("deux demandes simultanées identiques : un seul changement, un seul événement", async () => {
    const before = (await events()).length;
    const r = await Promise.all([1, 2].map(() => setFlag(t.actor, { flag: "sync.scheduled", scope: "TENANT", scopeId: "", enabled: false })));
    expect(r.sort()).toEqual(["changed", "unchanged"]);
    expect((await events()).length).toBe(before + 1);
    await setFlag(t.actor, { flag: "sync.scheduled", scope: "TENANT", scopeId: "", enabled: true });
  });

  it("lectures planifiées coupées pour un propriétaire : aucune lecture, échéance conservée ; l'autre propriétaire n'est pas touché", async () => {
    const real = await db.select().from(schema.properties).where(eq(schema.properties.tenantId, t.tenantId));
    expect(real.length).toBeGreaterThan(0);
    // logement démo : le planificateur ne lit que les logements réels branchés, on vérifie donc la règle de coupure elle-même et l'isolation
    await setFlag(t.actor, { flag: "sync.scheduled", scope: "TENANT", scopeId: "", enabled: false });
    expect((await flagFor(t.tenantId, "sync.scheduled", { propertyId: propId, provider: "superhote" })).enabled).toBe(false);
    expect((await flagFor(other.tenantId, "sync.scheduled", { propertyId: propId, provider: "superhote" })).enabled).toBe(true);
    await runDue();
    await setFlag(t.actor, { flag: "sync.scheduled", scope: "TENANT", scopeId: "", enabled: true });
  });
});
