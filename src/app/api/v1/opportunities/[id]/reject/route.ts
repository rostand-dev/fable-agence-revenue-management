import { apiError, apiUser, decisionResponse, isResponse, json, readObject } from "@/lib/api/v1";
import * as D from "@/lib/services/decisions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Rejette la proposition d'un dossier (US-084). Corps : { "comment": "<texte facultatif>" }.
 * 200 { ok: true } · 400 · 401 · 403 droits insuffisants ou origine refusée · 404 · 409 dossier plus ouvert.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await apiUser(); if (isResponse(user)) return user;
  // le droit est contrôlé avant la saisie : un rôle sans droit reçoit 403 quel que soit le corps envoyé
  const { id } = await ctx.params;
  const actor = { id: user.id, name: user.name, tenantId: user.tenantId, role: user.role };
  const refused = await decisionResponse(() => D.requireDecide(actor, "Opportunity", id), () => new Response(null)).then((x) => (x.status === 200 ? null : x));
  if (refused) return refused;
  const body = await readObject(req); if (isResponse(body)) return body;
  if (body.comment !== undefined && typeof body.comment !== "string") return apiError(400, "INVALID_COMMENT", "comment doit être un texte.");
  return decisionResponse(async () => { await D.reject({ id: user.id, name: user.name, tenantId: user.tenantId, role: user.role }, id, String(body.comment ?? "")); return { ok: true }; }, json);
}
