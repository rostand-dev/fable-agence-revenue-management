import { apiError, apiUser, decisionResponse, isResponse, json, readObject } from "@/lib/api/v1";
import * as D from "@/lib/services/decisions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Approuve une option d'un dossier (US-084, blueprint §13.1 « approve avec commentaire »).
 * Corps : { "candidate": <numéro d'option, entier ≥ 0>, "comment": "<texte, obligatoire pour une option à risque élevé ou à valider>" }.
 * 200 { actionId } (null si l'option retenue est l'inaction) · 400 saisie invalide · 401 · 403 droits insuffisants ou origine refusée · 404 · 409 état du dossier.
 * Les mêmes règles que l'écran : option rejetée par l'auditeur impossible, commentaire exigé, une seule décision par dossier.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await apiUser(); if (isResponse(user)) return user;
  // le droit est contrôlé avant la saisie : un rôle sans droit reçoit 403 quel que soit le corps envoyé
  const { id } = await ctx.params;
  const actor = { id: user.id, name: user.name, tenantId: user.tenantId, role: user.role };
  const refused = await decisionResponse(() => D.requireDecide(actor, "Opportunity", id), () => new Response(null)).then((x) => (x.status === 200 ? null : x));
  if (refused) return refused;
  const body = await readObject(req); if (isResponse(body)) return body;
  const candidate = body.candidate;
  if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate < 0 || candidate > 50) return apiError(400, "INVALID_CANDIDATE", "candidate doit être le numéro d'une option (entier ≥ 0).");
  if (body.comment !== undefined && typeof body.comment !== "string") return apiError(400, "INVALID_COMMENT", "comment doit être un texte.");
  return decisionResponse(async () => ({ actionId: await D.approve({ id: user.id, name: user.name, tenantId: user.tenantId, role: user.role }, id, candidate, String(body.comment ?? "")) }), json);
}
