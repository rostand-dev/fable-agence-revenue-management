import { getUser } from "@/lib/auth";
import { listAuditEvents } from "@/lib/audit/query";
import { auditCategoryOf, auditLabel, isAuditCategory } from "@/lib/audit/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX = 100;

/**
 * Journal d'audit du propriétaire connecté, paginé (blueprint §13.1, GET /v1/audit-events).
 *   ?limit=1..100 (50)  ?cursor=<nextCursor>  ?category=APPROVAL|EXECUTION|CONFIGURATION|INTEGRATION|ACCESS|SYSTEM  ?entity=…  ?entityId=…
 * Lecture seule : le journal n'a pas d'écriture publique. Le propriétaire n'est jamais un paramètre, il vient de la session.
 */
export async function GET(req: Request) {
  const user = await getUser();
  if (!user) return Response.json({ error: "Session expirée : reconnectez-vous." }, { status: 401, headers: NO_STORE });
  const q = new URL(req.url).searchParams;
  const rawLimit = q.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX) return Response.json({ error: `limit doit être un entier entre 1 et ${MAX}.` }, { status: 400, headers: NO_STORE });
  const category = q.get("category");
  if (category !== null && !isAuditCategory(category)) return Response.json({ error: "category inconnue." }, { status: 400, headers: NO_STORE });
  const short = (v: string | null) => (v && v.length <= 120 ? v : undefined);
  const page = await listAuditEvents(user.tenantId, { limit, cursor: short(q.get("cursor")) ?? null, category: category ?? undefined, entity: short(q.get("entity")), entityId: short(q.get("entityId")) });
  return Response.json({
    events: page.events.map((e) => ({ id: e.id, at: e.createdAt.toISOString(), actor: e.actor, type: e.type, label: auditLabel(e.type), category: auditCategoryOf(e.type), entity: e.entity, entityId: e.entityId, summary: e.summary, payload: e.payload ?? null })),
    nextCursor: page.nextCursor,
  }, { headers: NO_STORE });
}
