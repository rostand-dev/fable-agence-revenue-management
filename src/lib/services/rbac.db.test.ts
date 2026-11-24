import { todayISO } from "@/lib/dates";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, schema } from "@/db";
import { listAuditEvents } from "@/lib/audit/query";
import { ROLES, can, type Role } from "@/lib/rbac";
import { makeTenant } from "@/test/db";
import type { Candidate } from "../engine/types";
import * as D from "./decisions";
import { seedDemo } from "./seed";

// L'utilisateur « connecté » des routes d'API est choisi par chaque test.
let current: { id: string; name: string; tenantId: string; role: Role } | null = null;
vi.mock("@/lib/auth", async (orig) => {
  const m = await orig<typeof import("@/lib/auth")>();
  return { ...m, getUser: async () => (current ? { sessionId: "s", passwordVerified: true, email: "x@test.local", tenantName: "Test", settings: {}, ...current } : null) };
});
import { POST as approveRoute } from "@/app/api/v1/opportunities/[id]/approve/route";
import { POST as rejectRoute } from "@/app/api/v1/opportunities/[id]/reject/route";
import { GET as auditRoute } from "@/app/api/audit-events/route";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
/** Chaque groupe de tests a son propre espace de démonstration : une approbation consomme un dossier ouvert. */
async function fresh(label: string): Promise<T> { const x = await makeTenant(label); await seedDemo(x.tenantId); return x; }
beforeEach(() => { current = null; });

const as = (role: Role) => ({ ...t.actor, role });
const open = () => db.select().from(schema.opportunities).where(and(eq(schema.opportunities.tenantId, t.tenantId), eq(schema.opportunities.status, "OPEN")));
const oppRow = async (id: string) => (await db.select().from(schema.opportunities).where(eq(schema.opportunities.id, id)))[0];
const denied = async () => (await listAuditEvents(t.tenantId, { limit: 200 })).events.filter((e) => e.type === "access.denied");
/** Un dossier ouvert dont une option est approuvable (avec commentaire si l'option l'exige : les tests en fournissent toujours un). */
async function approvable(mode?: string) {
  for (const o of await open()) {
    const cands = o.candidates as Candidate[];
    const i = cands.findIndex((c) => c.type !== "NO_ACTION" && c.audit.verdict !== "REJECT" && (!mode || c.executionMode === mode));
    if (i >= 0) return { o, i };
  }
  return null;
}
const WHY = "Validé après relecture du dossier.";
const req = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("décider selon le rôle (US-084)", () => {
  beforeAll(async () => { t = await fresh("rôles-décision"); }, 120_000);
  it("un rôle sans droit de décision est refusé par le service, sans rien changer, et la tentative est consignée", async () => {
    const pick = (await approvable())!; expect(pick).not.toBeNull();
    const before = (await denied()).length;
    for (const role of ["ANALYST", "OTA_OPERATOR", "OWNER_VIEWER", "AUDITOR"] as Role[]) {
      expect(can(role, "decision.decide")).toBe(false);
      await expect(D.approve(as(role), pick.o.id, pick.i, WHY)).rejects.toMatchObject({ kind: "FORBIDDEN" });
      await expect(D.reject(as(role), pick.o.id, "non")).rejects.toBeInstanceOf(D.ForbiddenError);
      await expect(D.defer(as(role), pick.o.id)).rejects.toBeInstanceOf(D.ForbiddenError);
      await expect(D.reopen(as(role), pick.o.id)).rejects.toBeInstanceOf(D.ForbiddenError);
    }
    // le dossier est intact et aucune action n'a été créée
    expect((await oppRow(pick.o.id)).status).toBe("OPEN");
    expect(await db.select().from(schema.revenueActions).where(eq(schema.revenueActions.opportunityId, pick.o.id))).toHaveLength(0);
    const ev = (await denied()).slice(0, (await denied()).length - before);
    expect(ev).toHaveLength(16);
    expect(ev[0]).toMatchObject({ actor: "user:" + t.userId, entity: "Opportunity", entityId: pick.o.id });
    expect(ev.every((e) => (e.payload as any).permission === "decision.decide")).toBe(true);
    expect(new Set(ev.map((e) => (e.payload as any).role))).toEqual(new Set(["ANALYST", "OTA_OPERATOR", "OWNER_VIEWER", "AUDITOR"]));
    // le résumé nomme le rôle et l'acte, jamais le contenu du commentaire
    expect(ev[0].summary).toContain("tentative refusée");
    expect(JSON.stringify(ev)).not.toContain(WHY);
  });

  it("administrateur, revenue manager et propriétaire du compte décident (non-régression : le rôle par défaut OWNER)", async () => {
    for (const role of ["OWNER", "TENANT_ADMIN", "REVENUE_MANAGER"] as Role[]) {
      const pick = (await approvable())!; expect(pick, role).not.toBeNull();
      const id = await D.approve(as(role), pick.o.id, pick.i, WHY);
      expect(id, role).toMatch(/^act_/);
      expect((await oppRow(pick.o.id)).status).toBe("DECIDED");
    }
  });

  it("un rôle inconnu en base (normalisé en lecture seule) ne décide pas", async () => {
    const { normalizeRole } = await import("@/lib/rbac");
    const pick = (await approvable())!;
    await expect(D.reject({ ...t.actor, role: normalizeRole("ROOT") }, pick.o.id, "")).rejects.toBeInstanceOf(D.ForbiddenError);
  });
});

describe("exécuter, vérifier, revenir en arrière selon le rôle (US-084)", () => {
  let manualId: string, apiId: string;
  beforeAll(async () => {
    t = await fresh("rôles-exécution");
    const m = await approvable("MANUAL_RUNBOOK");
    const a = (await approvable("API_PRICELABS")) ?? (await approvable("INTERNAL"));
    expect(m, "aucune option manuelle approuvable dans la démonstration").not.toBeNull();
    expect(a, "aucune option API approuvable dans la démonstration").not.toBeNull();
    manualId = (await D.approve(as("REVENUE_MANAGER"), m!.o.id, m!.i, WHY))!;
    apiId = (await D.approve(as("REVENUE_MANAGER"), a!.o.id, a!.i, WHY))!;
  });
  const status = async (id: string) => (await db.select().from(schema.revenueActions).where(eq(schema.revenueActions.id, id)))[0].status;

  it("l'opérateur OTA applique la procédure manuelle, pas l'écriture PriceLabs", async () => {
    await expect(D.execute(as("OTA_OPERATOR"), apiId)).rejects.toBeInstanceOf(D.ForbiddenError);
    expect(await status(apiId)).toBe("APPROVED");
    await D.execute(as("OTA_OPERATOR"), manualId, { scope: "Portée déclarée pour le test", date: todayISO(), proof: "ref-1" });
    expect(await status(manualId)).toBe("EXECUTED");
  });

  it("l'analyste et l'auditeur n'exécutent rien, ne vérifient rien et ne reviennent pas en arrière", async () => {
    for (const role of ["ANALYST", "AUDITOR", "OWNER_VIEWER"] as Role[]) {
      await expect(D.execute(as(role), apiId)).rejects.toBeInstanceOf(D.ForbiddenError);
      await expect(D.verify(as(role), manualId)).rejects.toBeInstanceOf(D.ForbiddenError);
      await expect(D.rollback(as(role), manualId, "non")).rejects.toBeInstanceOf(D.ForbiddenError);
    }
    expect(await status(manualId)).toBe("EXECUTED");
    expect(await status(apiId)).toBe("APPROVED");
  });

  it("l'opérateur OTA vérifie mais ne revient pas en arrière ; le revenue manager le peut", async () => {
    // US-104 : la personne qui a confirmé ne vérifie pas tout de suite ; une autre personne de même rôle le peut
    await expect(D.verify(as("OTA_OPERATOR"), manualId)).rejects.toBeInstanceOf(D.DecisionError);
    await D.verify({ ...as("OTA_OPERATOR"), id: "autre-operateur" }, manualId);
    expect(await status(manualId)).toBe("MEASURING");
    await expect(D.rollback(as("OTA_OPERATOR"), manualId, "non")).rejects.toBeInstanceOf(D.ForbiddenError);
    await D.rollback(as("REVENUE_MANAGER"), manualId, "Test");
    expect(await status(manualId)).toBe("ROLLED_BACK");
  });

  it("le revenue manager exécute l'action API", async () => {
    await D.execute(as("REVENUE_MANAGER"), apiId, (await db.select().from(schema.revenueActions).where(eq(schema.revenueActions.id, apiId)))[0].simulation.executionMode === "MANUAL_RUNBOOK" ? { scope: "Portée déclarée pour le test", date: todayISO(), proof: "", externalRef: "REF-TEST-1" } : undefined);
    expect(["EXECUTED", "FAILED"]).toContain(await status(apiId));
  });
});

describe("API REST : approuver et rejeter (US-084)", () => {
  beforeAll(async () => { t = await fresh("rôles-api"); }, 120_000);
  it("401 sans session", async () => {
    const pick = (await approvable())!;
    const r = await approveRoute(req("/x", { candidate: pick.i }), ctx(pick.o.id));
    expect(r.status).toBe(401);
  });

  it("403 pour un rôle sans droit, avec le message du rôle ; le dossier reste ouvert", async () => {
    const pick = (await approvable())!;
    for (const role of ["ANALYST", "AUDITOR"] as Role[]) {
      current = { ...t.actor, role };
      const a = await approveRoute(req("/x", { candidate: pick.i, comment: WHY }), ctx(pick.o.id));
      expect(a.status).toBe(403);
      expect((await a.json()).error).toMatchObject({ code: "FORBIDDEN" });
      const r = await rejectRoute(req("/x", { comment: "non" }), ctx(pick.o.id));
      expect(r.status).toBe(403);
    }
    expect((await oppRow(pick.o.id)).status).toBe("OPEN");
  });

  it("un rôle sans droit reçoit 403 même avec un corps invalide ; la revue et la réinstallation exigent aussi le droit", async () => {
    const pick = (await approvable())!;
    current = as("ANALYST");
    expect((await approveRoute(req("/x", { candidate: "n'importe quoi" }), ctx(pick.o.id))).status).toBe(403);
    expect((await rejectRoute(req("/x", { comment: 42 }), ctx(pick.o.id))).status).toBe(403);
    await expect(D.requireDecide(as("AUDITOR"))).rejects.toBeInstanceOf(D.ForbiddenError);
    await expect(D.requireDecide(as("REVENUE_MANAGER"))).resolves.toBeUndefined();
    // un identifiant démesuré n'entre pas tel quel dans le journal
    await expect(D.verify(as("ANALYST"), "x".repeat(500))).rejects.toBeInstanceOf(D.ForbiddenError);
    expect((await denied())[0].entityId.length).toBeLessThanOrEqual(64);
  });

  it("400 sur une saisie invalide, 404 sur un dossier inconnu, 409 sur un dossier déjà tranché", async () => {
    current = as("REVENUE_MANAGER");
    const pick = (await approvable())!;
    expect((await approveRoute(req("/x", { candidate: "1" }), ctx(pick.o.id))).status).toBe(400);
    expect((await approveRoute(req("/x", { candidate: -1 }), ctx(pick.o.id))).status).toBe(400);
    expect((await approveRoute(req("/x", { candidate: 0, comment: 3 }), ctx(pick.o.id))).status).toBe(400);
    expect((await approveRoute(req("/x", { candidate: 999 }), ctx(pick.o.id))).status).toBe(400); // plafond de la saisie
    expect((await approveRoute(req("/x", { candidate: 40 }), ctx(pick.o.id))).status).toBe(400); // option inconnue (VALIDATION)
    expect((await approveRoute(req("/x", { candidate: 0 }), ctx("opp_inconnu"))).status).toBe(404);
    const ok = await approveRoute(req("/x", { candidate: pick.i, comment: WHY }), ctx(pick.o.id));
    expect(ok.status).toBe(200);
    expect((await ok.json()).actionId).toMatch(/^act_/);
    const again = await approveRoute(req("/x", { candidate: pick.i }), ctx(pick.o.id));
    expect(again.status).toBe(409);
  });

  it("le commentaire reste exigé pour une option à valider (400)", async () => {
    current = as("REVENUE_MANAGER");
    let found: { id: string; i: number } | null = null;
    for (const o of await open()) { const i = (o.candidates as Candidate[]).findIndex((c) => c.audit.verdict !== "REJECT" && D.commentRequired(c, o.playbook) && c.type !== "NO_ACTION"); if (i >= 0) { found = { id: o.id, i }; break; } }
    if (!found) return; // la démonstration du jour n'en comporte pas : le contrôle reste couvert par decisions.db.test.ts
    const r = await approveRoute(req("/x", { candidate: found.i }), ctx(found.id));
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toContain("commentaire");
  });

  it("le rejet par l'API est consigné au journal", async () => {
    current = as("TENANT_ADMIN");
    const pick = (await approvable())!;
    const r = await rejectRoute(req("/x", { comment: "Pas pertinent" }), ctx(pick.o.id));
    expect(r.status).toBe(200);
    const ev = (await listAuditEvents(t.tenantId, { limit: 50 })).events.find((e) => e.type === "opportunity.rejected" && e.entityId === pick.o.id);
    expect(ev?.actor).toBe("user:" + t.userId);
  });

  it("origine étrangère refusée (403) avant toute décision", async () => {
    current = as("REVENUE_MANAGER");
    const pick = (await approvable())!;
    const r = await approveRoute(new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example", host: "localhost" }, body: JSON.stringify({ candidate: pick.i }) }), ctx(pick.o.id));
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("FORBIDDEN_ORIGIN");
    expect((await oppRow(pick.o.id)).status).toBe("OPEN");
  });
});

describe("journal d'audit selon le rôle (US-084)", () => {
  beforeAll(async () => { t = await makeTenant("rôles-journal"); });
  it("lisible par l'auditeur, le revenue manager, l'administrateur, le propriétaire du compte ; refusé aux autres (403)", async () => {
    for (const role of ROLES) {
      current = as(role);
      const r = await auditRoute(new Request("http://localhost/api/audit-events?limit=5"));
      expect(r.status, role).toBe(can(role, "audit.read") ? 200 : 403);
    }
  });
});
