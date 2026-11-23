import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { typesOfCategory, type AuditCategory } from "./types";

const { auditEvents: t } = schema;

/** Qui a agi : une personne (`user:…`), un agent IA (`agent:…`) ou le système (tout le reste : planification, démonstration, webhooks). */
export type ActorKind = "human" | "agent" | "system";
export const ACTOR_KINDS: Record<ActorKind, string> = { human: "Une personne", agent: "Un agent IA", system: "Le système" };
export const isActorKind = (v: unknown): v is ActorKind => typeof v === "string" && Object.hasOwn(ACTOR_KINDS, v);
/** Jour civil `YYYY-MM-DD` valide (rejette 2026-02-31) ; sinon undefined. */
export function parseDay(v: unknown): string | undefined {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(v + "T00:00:00Z");
  return Number.isNaN(+d) || d.toISOString().slice(0, 10) !== v ? undefined : v;
}
/** `from` et `to` : jours UTC inclusifs. */
export type AuditFilter = { category?: AuditCategory; entity?: string; entityId?: string; from?: string; to?: string; actorKind?: ActorKind };
export type AuditRow = typeof t.$inferSelect;
export type AuditPage = { events: AuditRow[]; nextCursor: string | null };

/**
 * Curseur : horodatage au microseconde (celui de la base, pas celui de JavaScript qui s'arrête à la milliseconde)
 * et identifiant, pour ne jamais sauter ni répéter deux événements écrits dans la même milliseconde.
 */
const encode = (ts: string, id: string) => Buffer.from(JSON.stringify([ts, id])).toString("base64url");
function decode(c: string): [string, string] | null {
  try {
    const v = JSON.parse(Buffer.from(c, "base64url").toString());
    return Array.isArray(v) && typeof v[0] === "string" && typeof v[1] === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?Z$/.test(v[0]) && v[1].length < 80 ? [v[0], v[1]] : null;
  } catch { return null; }
}
const TS = sql<string>`to_char(${t.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Journal d'un seul propriétaire, du plus récent au plus ancien, paginé par curseur (blueprint §13.1, GET /v1/audit-events). */
export async function listAuditEvents(tenantId: string, opts: AuditFilter & { limit?: number; cursor?: string | null } = {}, ex: Pick<typeof db, "select"> = db): Promise<AuditPage> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
  const where = [eq(t.tenantId, tenantId)];
  if (opts.category) where.push(inArray(t.type, typesOfCategory(opts.category)));
  if (opts.entity) where.push(eq(t.entity, opts.entity));
  if (opts.entityId) where.push(eq(t.entityId, opts.entityId));
  const from = parseDay(opts.from), to = parseDay(opts.to);
  if (from) where.push(sql`${t.createdAt} >= ${from + "T00:00:00Z"}::timestamptz`);
  if (to) where.push(sql`${t.createdAt} < (${to + "T00:00:00Z"}::timestamptz + interval '1 day')`);
  if (opts.actorKind === "human") where.push(sql`${t.actor} like 'user:%'`);
  else if (opts.actorKind === "agent") where.push(sql`${t.actor} like 'agent:%'`);
  else if (opts.actorKind === "system") where.push(sql`${t.actor} not like 'user:%' and ${t.actor} not like 'agent:%'`);
  const cur = opts.cursor ? decode(opts.cursor) : null;
  if (cur) where.push(sql`(${t.createdAt}, ${t.id}) < (${cur[0]}::timestamptz, ${cur[1]})`);
  const rows = await ex.select({ e: t, ts: TS }).from(t).where(and(...where)).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { events: page.map((r) => r.e), nextCursor: rows.length > limit && last ? encode(last.ts, last.e.id) : null };
}

/** Tout ce qui est arrivé à un objet (dossier, action, logement), du plus ancien au plus récent. */
export async function auditTrail(tenantId: string, entity: string, entityId: string): Promise<AuditRow[]> {
  return db.select().from(t).where(and(eq(t.tenantId, tenantId), eq(t.entity, entity), eq(t.entityId, entityId))).orderBy(t.createdAt, t.id);
}

/**
 * Chronologie d'un logement : événements du logement lui-même, de ses dossiers (opportunités) et de leurs actions,
 * du plus récent au plus ancien. Réservée à l'appelant qui a le droit `audit.read` (à vérifier avant l'appel).
 */
export async function propertyAuditTrail(tenantId: string, propertyId: string, limit = 50, ex: Pick<typeof db, "select"> = db): Promise<AuditRow[]> {
  const opps = ex.select({ id: schema.opportunities.id }).from(schema.opportunities).where(and(eq(schema.opportunities.tenantId, tenantId), eq(schema.opportunities.propertyId, propertyId)));
  const acts = ex.select({ id: schema.revenueActions.id }).from(schema.revenueActions).where(and(eq(schema.revenueActions.tenantId, tenantId), eq(schema.revenueActions.propertyId, propertyId)));
  const scope = sql`(
    (${t.entity} = 'Property' and ${t.entityId} = ${propertyId})
    or (${t.entity} = 'Opportunity' and ${t.entityId} in (${opps}))
    or (${t.entity} = 'RevenueAction' and ${t.entityId} in (${acts}))
  )`;
  return ex.select().from(t).where(and(eq(t.tenantId, tenantId), scope)).orderBy(desc(t.createdAt), desc(t.id)).limit(Math.min(Math.max(Math.trunc(limit), 1), 200));
}
