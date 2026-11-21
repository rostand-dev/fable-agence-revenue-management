import { getTableColumns, getTableName, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { beforeAll, describe, expect, it } from "vitest";
import { db, newId, schema } from "@/db";
import { makeProperty, makeTenant } from "@/test/db";
import { recordAudit } from "@/lib/audit/log";
import { isolationStatus, TENANT_TABLES, withTenant } from "./tenant";

let a: Awaited<ReturnType<typeof makeTenant>>, b: Awaited<ReturnType<typeof makeTenant>>, propA = "", propB = "";
beforeAll(async () => {
  a = await makeTenant("A-rls"); b = await makeTenant("B-rls");
  propA = await makeProperty(a.tenantId, "Logement A"); propB = await makeProperty(b.tenantId, "Logement B");
  for (const [t, p] of [[a, propA], [b, propB]] as const) {
    await recordAudit(db, { tenantId: t.tenantId, actor: "system", type: "review.completed", entity: "Property", entityId: p, summary: "test" });
    await db.insert(schema.featureFlags).values({ id: "flg_" + t.tenantId, tenantId: t.tenantId, flag: "write.api", scope: "TENANT", scopeId: "", enabled: false, updatedBy: "system" });
  }
});

describe("isolation par la base (RLS, US-011)", () => {
  it("la liste des tables protégées couvre TOUTE table portant tenant_id (un oubli fait échouer ce test)", () => {
    const withTenantCol = (Object.values(schema) as unknown[]).filter((x): x is PgTable => x instanceof PgTable).filter((t) => "tenantId" in getTableColumns(t)).map((t) => getTableName(t)).sort();
    expect(withTenantCol).toEqual([...TENANT_TABLES].sort());
  });

  it("chaque table protégée a RLS activée et sa politique", async () => {
    const r = await db.execute(sql`select c.relname, c.relrowsecurity, (select count(*) from pg_policies p where p.tablename = c.relname and p.policyname = 'tenant_isolation') as pol from pg_class c where c.relname = any(${sql.raw(`array[${[...TENANT_TABLES, "tenants"].map((t) => `'${t}'`).join(",")}]`)}) and c.relkind = 'r'`);
    expect(r.rows).toHaveLength(TENANT_TABLES.length + 1);
    for (const row of r.rows as any[]) { expect(row.relrowsecurity, row.relname).toBe(true); expect(Number(row.pol), row.relname).toBe(1); }
  });

  it("sur chaque table : sous le rôle de A, le nombre de lignes égale celui des lignes de A (vu par la base entière), et B n'y figure pas", async () => {
    for (const t of TENANT_TABLES) {
      const own = await withTenant(a.tenantId, (tx) => tx.execute(sql`select tenant_id from ${sql.identifier(t)}`), { enforce: true });
      const all = await db.execute(sql`select count(*)::int as n, count(*) filter (where tenant_id = ${a.tenantId})::int as mine from ${sql.identifier(t)}`);
      const { n, mine } = all.rows[0] as { n: number; mine: number };
      expect(own.rows.length, t).toBe(mine);
      for (const row of own.rows as any[]) expect(row.tenant_id, t).toBe(a.tenantId);
      if (["users", "properties", "audit_events", "feature_flags"].includes(t)) expect(n, t + " : B doit avoir des lignes").toBeGreaterThan(mine);
    }
    const tenantsSeen = await withTenant(a.tenantId, (tx) => tx.select().from(schema.tenants), { enforce: true });
    expect(tenantsSeen.map((x) => x.id)).toEqual([a.tenantId]);
    const seenByA = await withTenant(a.tenantId, (tx) => tx.select().from(schema.properties), { enforce: true });
    expect(seenByA.map((p) => p.id)).toEqual([propA]);
    const seenByB = await withTenant(b.tenantId, (tx) => tx.select().from(schema.auditEvents), { enforce: true });
    expect(seenByB.every((e) => e.tenantId === b.tenantId) && seenByB.length > 0).toBe(true);
  });

  it("une requête qui oublie son filtre reste cloisonnée, y compris avec un identifiant visé directement", async () => {
    const r = await withTenant(a.tenantId, (tx) => tx.execute(sql`select id from properties where id = ${propB}`), { enforce: true });
    expect(r.rows).toHaveLength(0);
  });

  it("A ne peut ni modifier ni supprimer les lignes de B (0 ligne touchée)", async () => {
    const upd = await withTenant(a.tenantId, (tx) => tx.update(schema.properties).set({ name: "piraté" }).returning({ id: schema.properties.id }).then((r) => r), { enforce: true });
    expect(upd.map((x) => x.id)).toEqual([propA]); // seulement le sien, jamais celui de B
    const del = await withTenant(a.tenantId, (tx) => tx.delete(schema.featureFlags).returning({ id: schema.featureFlags.id }), { enforce: true });
    expect(del.every((x) => x.id === "flg_" + a.tenantId)).toBe(true);
    const [pb] = await db.select().from(schema.properties).where(sql`id = ${propB}`);
    expect(pb.name).toBe("Logement B");
    const [fb] = await db.select().from(schema.featureFlags).where(sql`id = ${"flg_" + b.tenantId}`);
    expect(fb).toBeTruthy();
  });

  it("A ne peut pas écrire une ligne au nom de B (la base refuse)", async () => {
    await expect(withTenant(a.tenantId, (tx) => tx.insert(schema.featureFlags).values({ id: "flg_intrus", tenantId: b.tenantId, flag: "sync.scheduled", scope: "TENANT", scopeId: "", enabled: false, updatedBy: "x" }), { enforce: true })).rejects.toThrow();
    await expect(withTenant(a.tenantId, (tx) => tx.update(schema.properties).set({ tenantId: b.tenantId }), { enforce: true })).rejects.toThrow();
  });

  it("le journal d'audit reste en ajout seul pour le rôle applicatif (ni modification ni suppression)", async () => {
    await expect(withTenant(a.tenantId, (tx) => tx.execute(sql`update audit_events set summary = 'x'`), { enforce: true })).rejects.toThrow();
    await expect(withTenant(a.tenantId, (tx) => tx.execute(sql`delete from audit_events`), { enforce: true })).rejects.toThrow();
  });

  it("les versions de stratégie sont en ajout seul pour le rôle applicatif", async () => {
    await expect(withTenant(a.tenantId, (tx) => tx.execute(sql`update strategy_versions set created_by = 'x'`), { enforce: true })).rejects.toThrow();
    await expect(withTenant(a.tenantId, (tx) => tx.execute(sql`delete from strategy_versions`), { enforce: true })).rejects.toThrow();
  });

  it("les validations d'activation sont en ajout seul pour le rôle applicatif", async () => {
    await expect(withTenant(a.tenantId, (tx) => tx.execute(sql`update activation_validations set note = 'x'`), { enforce: true })).rejects.toThrow();
    await expect(withTenant(a.tenantId, (tx) => tx.execute(sql`delete from activation_validations`), { enforce: true })).rejects.toThrow();
  });

  it("les versions du modèle économique sont en ajout seul pour le rôle applicatif, et la suppression d'un logement passe quand même", async () => {
    const pid = newId("prop");
    await db.insert(schema.properties).values({ id: pid, tenantId: a.tenantId, name: "Versions RLS", city: "Paris", kind: "T2", status: "ACTIVE" });
    await withTenant(a.tenantId, (tx) => tx.insert(schema.economicModelVersions).values({ id: newId("ecv"), tenantId: a.tenantId, propertyId: pid, version: 1, model: {}, changes: [], createdBy: "t" }), { enforce: true });
    await expect(withTenant(a.tenantId, (tx) => tx.execute(sql`update economic_model_versions set created_by = 'x'`), { enforce: true })).rejects.toThrow();
    await expect(withTenant(a.tenantId, (tx) => tx.execute(sql`delete from economic_model_versions`), { enforce: true })).rejects.toThrow();
    await withTenant(a.tenantId, (tx) => tx.delete(schema.properties).where(sql`id = ${pid}`), { enforce: true });
    expect(await db.select().from(schema.economicModelVersions).where(sql`property_id = ${pid}`)).toHaveLength(0);
  });

  it("sans propriétaire défini, la base ne montre rien (échec fermé)", async () => {
    const r = await db.transaction(async (tx) => { await tx.execute(sql`set local role nuitsignal_app`); return tx.execute(sql`select id from properties`); });
    expect(r.rows).toHaveLength(0);
  });

  it("les tables d'authentification ne sont pas accessibles au rôle applicatif", async () => {
    for (const t of ["sessions", "password_resets", "auth_attempts", "signup_confirmations"]) {
      await expect(withTenant(a.tenantId, (tx) => tx.execute(sql`select * from ${sql.identifier(t)}`), { enforce: true }), t).rejects.toThrow();
    }
  });

  it("scénario réel : un filtre applicatif visant B sous la session de A ne renvoie rien (la base protège)", async () => {
    const { listAuditEvents } = await import("@/lib/audit/query");
    const seen = await withTenant(a.tenantId, (tx) => listAuditEvents(b.tenantId, {}, tx), { enforce: true });
    expect(seen.events).toHaveLength(0);
    expect((await listAuditEvents(b.tenantId)).events.length).toBeGreaterThan(0);
  });

  it("le rôle et le propriétaire sont réinitialisés après la transaction : la connexion rendue au pool n'est pas restreinte", async () => {
    await withTenant(a.tenantId, (tx) => tx.execute(sql`select 1`), { enforce: true });
    const r = await db.execute(sql`select current_user as u`);
    expect((r.rows[0] as any).u).not.toBe("nuitsignal_app");
    const g = await db.execute(sql`select nullif(current_setting('app.tenant_id', true), '') as t`);
    expect((g.rows[0] as any).t).toBeNull();
  });

  it("la migration 0011 se rejoue sans erreur ni changement", async () => {
    const { readFileSync } = await import("node:fs");
    const stmts = readFileSync("drizzle/0011_tenant_rls.sql", "utf8").split("--> statement-breakpoint");
    for (let i = 0; i < 2; i++) for (const st of stmts) await db.execute(sql.raw(st));
    expect(await isolationStatus()).toBe("available");
  });

  it("le statut d'isolation est « available » (rôle et politiques en place, non exigée)", async () => { expect(await isolationStatus()).toBe("available"); });
});
