import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { db, newId, schema } from "@/db";
import { TENANT_TABLES } from "@/db/tenant";
import { listAuditEvents } from "@/lib/audit/query";
import { can, denyMessage, ROLES, type Permission, type Role } from "@/lib/rbac";
import { ACTION_RIGHTS, GET_ROUTES, ROUTE_RIGHTS } from "@/lib/rights-catalog";
import { makeProperty, makeTenant } from "@/test/db";

/**
 * Chaque écriture gardée est réellement appelée avec chaque rôle sans droit, sur des données existantes : refus, rien de modifié,
 * tentative consignée. Les rôles autorisés, eux, passent la garde.
 */
type Actor = { id: string; name: string; tenantId: string; role: Role };
let current: Actor;
const user = () => ({ sessionId: "s", passwordVerified: true, email: "x@test.local", tenantName: "Test", settings: {}, ...current });
vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<typeof import("@/lib/auth")>()), getUser: async () => user(), requireUser: async () => user() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error("REDIRECT " + to); }, notFound: () => { throw new Error("NOT_FOUND"); } }));

import * as costs from "@/app/actions/costs";
import * as decisions from "@/app/actions/decisions";
import * as ingestion from "@/app/actions/ingestion";
import * as llm from "@/app/actions/llm";
import * as mapping from "@/app/actions/mapping";
import * as onboarding from "@/app/actions/onboarding";
import * as portfolio from "@/app/actions/portfolio";
import * as pricelabs from "@/app/actions/pricelabs";
import * as quality from "@/app/actions/quality";
import * as seasons from "@/app/actions/seasons";
import * as settings from "@/app/actions/settings";
import * as strategy from "@/app/actions/strategy";
import * as superhote from "@/app/actions/superhote";
import * as validations from "@/app/actions/validations";
import * as owners from "@/app/api/v1/owners/route";
import * as owner from "@/app/api/v1/owners/[id]/route";
import * as properties from "@/app/api/v1/properties/route";
import * as property from "@/app/api/v1/properties/[id]/route";
import * as activate from "@/app/api/v1/properties/[id]/activate/route";
import * as seasonsRoute from "@/app/api/v1/properties/[id]/economics/seasons/route";
import * as listings from "@/app/api/v1/properties/[id]/listings/route";
import * as listing from "@/app/api/v1/properties/[id]/listings/[listingId]/route";
import * as mappingRoute from "@/app/api/v1/properties/[id]/mapping/route";
import * as strategyRoute from "@/app/api/v1/properties/[id]/strategy/route";
import * as publish from "@/app/api/v1/properties/[id]/strategy/publish/route";
import * as rollback from "@/app/api/v1/properties/[id]/strategy/rollback/route";
import * as floors from "@/app/api/v1/properties/[id]/validations/floors/route";
import * as reconciliation from "@/app/api/v1/properties/[id]/validations/reconciliation/route";

const ACTIONS = { ...costs, ...decisions, ...ingestion, ...llm, ...mapping, ...onboarding, ...portfolio, ...pricelabs, ...quality, ...seasons, ...settings, ...strategy, ...superhote, ...validations } as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
const ROUTES: Record<string, Record<string, unknown>> = {
  "api/v1/owners": owners, "api/v1/owners/[id]": owner, "api/v1/properties": properties, "api/v1/properties/[id]": property,
  "api/v1/properties/[id]/activate": activate, "api/v1/properties/[id]/economics/seasons": seasonsRoute,
  "api/v1/properties/[id]/listings": listings, "api/v1/properties/[id]/listings/[listingId]": listing, "api/v1/properties/[id]/mapping": mappingRoute,
  "api/v1/properties/[id]/strategy": strategyRoute, "api/v1/properties/[id]/strategy/publish": publish, "api/v1/properties/[id]/strategy/rollback": rollback,
  "api/v1/properties/[id]/validations/floors": floors, "api/v1/properties/[id]/validations/reconciliation": reconciliation,
};
const guarded = <T extends object>(table: Record<string, T>) => Object.entries(table).flatMap(([name, r]) => ("permission" in r ? [[name, r.permission as Permission] as const] : []));
const ACTION_LIST = guarded(ACTION_RIGHTS), ROUTE_LIST = guarded(ROUTE_RIGHTS);
const lacking = (p: Permission) => ROLES.filter((r) => !can(r, p));

type World = { tenantId: string; userId: string; actor: Actor; propertyId: string; ownerId: string; listingId: string };
let w: World;
beforeAll(async () => {
  const t = await makeTenant("droits");
  const propertyId = await makeProperty(t.tenantId, "Témoin");
  const ownerId = newId("own"), listingId = newId("lst");
  await db.insert(schema.owners).values({ id: ownerId, tenantId: t.tenantId, name: "Propriétaire témoin" });
  await db.insert(schema.listings).values({ id: listingId, tenantId: t.tenantId, propertyId, channel: "AIRBNB", externalId: "123", title: "Annonce témoin" });
  await db.update(schema.properties).set({ pricelabs: { apiKeyEnc: "chiffré", apiKeyHint: "…abcd" } as never, superhote: { apiKeyEnc: "chiffré", apiKeyHint: "…wxyz" } as never }).where(eq(schema.properties.id, propertyId));
  w = { ...t, propertyId, ownerId, listingId };
});

/** Saisie plausible et visant les données témoins : sans la garde, plusieurs de ces écritures modifieraient réellement la base. */
function form() {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ propertyId: w.propertyId, ownerId: w.ownerId, listingId: w.listingId, rentalId: "r1", name: "Pirate", email: "", city: "Lyon", kind: "T3", channel: "AIRBNB", externalId: "999", title: "Pirate", status: "ARCHIVED", tenantName: "Espace pirate", apiKey: "cle-pirate-123456", provider: "pricelabs", on: "1", enabled: "0", flag: "x", scope: "property", scopeId: w.propertyId, cap: "10", id: "x", intent: "quit", step: "superhote", objective: "REVENUE", "agent-onboarding": "Pirate" })) fd.set(k, v);
  return fd;
}
const call = (name: string) => (name === "saveCostsAction" ? ACTIONS[name](w.propertyId, { airbnbPct: "15" }, false) : ACTIONS[name](null, form()));

/** Toutes les tables de l'espace témoin (le journal, qui consigne les refus, est lu à part). */
async function snapshot() {
  const tables = TENANT_TABLES.filter((t) => t !== "audit_events");
  const rows = await Promise.all(tables.map((t) => db.execute(sql`select to_jsonb(x)::text as r from ${sql.identifier(t)} x where x.tenant_id = ${w.tenantId} order by 1`)));
  const tenant = await db.select().from(schema.tenants).where(eq(schema.tenants.id, w.tenantId));
  return JSON.stringify([tenant, rows.map((r, i) => [tables[i], r.rows])]);
}
/** Un refus ne doit déclencher aucun appel vers PriceLabs, SuperHote ou un fournisseur d'IA. */
let network: MockInstance;
beforeEach(() => { network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("appel réseau inattendu"); }); });
afterEach(() => network.mockRestore());
const denials = async () => (await listAuditEvents(w.tenantId, { limit: 200 })).events.filter((e) => e.type === "access.denied");
/** Nombre d'événements du journal de l'espace témoin (la liste paginée plafonne, ce compte non). */
const journalSize = async () => Number((await db.execute(sql`select count(*)::int as n from audit_events where tenant_id = ${w.tenantId}`)).rows[0].n);

describe("actions serveur gardées", () => {
  it("chaque action déclarée avec un droit existe", () => {
    expect(ACTION_LIST.length).toBeGreaterThan(40);
    expect(ACTION_LIST.filter(([n]) => typeof ACTIONS[n] !== "function")).toEqual([]);
  });
  it.each(ACTION_LIST)("%s : refusée sans « %s », sans rien modifier, tentative consignée", async (name, permission) => {
    const before = await snapshot();
    for (const role of lacking(permission)) {
      current = { ...w.actor, role };
      const seen = new Set((await denials()).map((e) => e.id));
      expect(await call(name), `${name} en ${role}`).toEqual({ error: denyMessage(role, permission) });
      const after = (await denials()).filter((e) => !seen.has(e.id));
      expect(after, `${name} en ${role} : refus non consigné`).toHaveLength(1);
      expect(after[0]).toMatchObject({ actor: "user:" + w.userId, payload: { permission, role } });
      expect(JSON.stringify(after[0])).not.toContain("cle-pirate");
    }
    expect(await snapshot()).toBe(before);
    expect(network).not.toHaveBeenCalled();
  });
});

const handler = (key: string) => { const [method, route] = key.split(" "); return { method, fn: ROUTES[route]?.[method] as ((req: Request, ctx: unknown) => Promise<Response>) | undefined, route }; };
const send = (key: string, body: string, headers: Record<string, string> = {}) => {
  const { method, fn, route } = handler(key);
  const id = route.startsWith("api/v1/owners") ? w.ownerId : w.propertyId;
  const req = new Request(`http://localhost/${route}`, { method, headers: { "content-type": "application/json", host: "localhost", ...headers }, body });
  return fn!(req, { params: Promise.resolve({ id, listingId: w.listingId }) });
};
const BODY = JSON.stringify({ name: "Pirate", city: "Lyon", kind: "T3", channel: "AIRBNB", title: "Pirate", status: "ARCHIVED", seasons: [], note: "x", version: 1 });

describe("routes d'API gardées", () => {
  it("chaque route déclarée avec un droit existe", () => {
    expect(ROUTE_LIST.length).toBeGreaterThan(15);
    expect(ROUTE_LIST.filter(([k]) => !handler(k).fn)).toEqual([]);
  });
  it.each(ROUTE_LIST)("%s : 403 sans « %s », sans rien modifier, avant même de lire la demande", async (key, permission) => {
    const before = await snapshot();
    for (const role of lacking(permission)) {
      current = { ...w.actor, role };
      // la confirmation exacte accompagne la demande : sans la garde, la suppression du logement aboutirait
      for (const body of [JSON.stringify({ ...JSON.parse(BODY), confirmName: "Témoin" }), "ceci n'est pas du JSON"]) {
        const size = await journalSize();
        const res = await send(key, body);
        expect(res.status, `${key} en ${role}`).toBe(403);
        expect(await res.json()).toEqual({ error: { code: "FORBIDDEN", message: denyMessage(role, permission) } });
        expect(await journalSize(), `${key} en ${role} : un refus consigné, un seul`).toBe(size + 1);
      }
      expect((await denials())[0]).toMatchObject({ payload: { permission, role } });
    }
    expect(await snapshot()).toBe(before);
    expect(network).not.toHaveBeenCalled();
  });
  it("une autre origine est refusée avant les droits, sans rien consigner", async () => {
    current = { ...w.actor, role: "ANALYST" };
    const size = await journalSize();
    for (const [key] of ROUTE_LIST) expect(((await (await send(key, BODY, { origin: "https://ailleurs.example" })).json()) as { error: { code: string } }).error.code, key).toBe("FORBIDDEN_ORIGIN");
    expect(await journalSize()).toBe(size);
  });
});

describe("routes déclarées en lecture", () => {
  const reads = Object.entries(GET_ROUTES).filter(([, v]) => v === "lecture").map(([r]) => r);
  it.each(reads)("GET %s : ne modifie rien et ne consigne rien", async (route) => {
    current = { ...w.actor, role: "OWNER" };
    const { GET } = (await import(path.join(process.cwd(), "src/app", route, "route.ts"))) as { GET: (req: Request, ctx: unknown) => Promise<Response> };
    const before = await snapshot(), size = await journalSize();
    const res = await GET(new Request(`http://localhost/${route}`, { headers: { host: "localhost" } }), { params: Promise.resolve({ id: w.propertyId, snapshotId: "inconnu", listingId: w.listingId }) });
    expect(res.status, route).toBeLessThan(500);
    expect(await snapshot()).toBe(before);
    expect(await journalSize()).toBe(size);
    expect(network).not.toHaveBeenCalled();
  });
});

describe("rôles autorisés", () => {
  const passes = async (name: string, permission: Permission, role: Role) => {
    current = { ...w.actor, role };
    let out: unknown;
    try { out = await call(name); } catch (e) { out = (e as Error).message; } // une redirection ou une saisie refusée : la garde est passée
    expect(JSON.stringify(out ?? null), `${name} en ${role}`).not.toContain(denyMessage(role, permission));
  };
  it("propriétaire du compte, administrateur et revenue manager passent la garde des logements", async () => {
    for (const [name, permission] of ACTION_LIST) if (permission === "property.manage") for (const role of ["OWNER", "TENANT_ADMIN", "REVENUE_MANAGER"] as Role[]) await passes(name, permission, role);
  }, 120_000);
  it("propriétaire du compte et administrateur passent la garde de l'espace", async () => {
    for (const [name, permission] of ACTION_LIST) if (permission === "workspace.manage") for (const role of ["OWNER", "TENANT_ADMIN"] as Role[]) await passes(name, permission, role);
  }, 120_000);
  it("un revenue manager crée un logement par l'API ; un analyste ne le peut pas", async () => {
    const make = () => properties.POST(new Request("http://localhost/api/v1/properties", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Par le revenue manager", city: "Lille", kind: "T2" }) }));
    current = { ...w.actor, role: "ANALYST" }; expect((await make()).status).toBe(403);
    current = { ...w.actor, role: "REVENUE_MANAGER" }; expect((await make()).status).toBe(201);
  });
});
