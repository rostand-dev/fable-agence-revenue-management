import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { typesOfCategory, type AuditCategory } from "./types";

const { auditEvents: t } = schema;

export type AuditFilter = { category?: AuditCategory; entity?: string; entityId?: string };
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
export async function listAuditEvents(tenantId: string, opts: AuditFilter & { limit?: number; cursor?: string | null } = {}): Promise<AuditPage> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
  const where = [eq(t.tenantId, tenantId)];
  if (opts.category) where.push(inArray(t.type, typesOfCategory(opts.category)));
  if (opts.entity) where.push(eq(t.entity, opts.entity));
  if (opts.entityId) where.push(eq(t.entityId, opts.entityId));
  const cur = opts.cursor ? decode(opts.cursor) : null;
  if (cur) where.push(sql`(${t.createdAt}, ${t.id}) < (${cur[0]}::timestamptz, ${cur[1]})`);
  const rows = await db.select({ e: t, ts: TS }).from(t).where(and(...where)).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { events: page.map((r) => r.e), nextCursor: rows.length > limit && last ? encode(last.ts, last.e.id) : null };
}

/** Tout ce qui est arrivé à un objet (dossier, action, logement), du plus ancien au plus récent. */
export async function auditTrail(tenantId: string, entity: string, entityId: string): Promise<AuditRow[]> {
  return db.select().from(t).where(and(eq(t.tenantId, tenantId), eq(t.entity, entity), eq(t.entityId, entityId))).orderBy(t.createdAt, t.id);
}
