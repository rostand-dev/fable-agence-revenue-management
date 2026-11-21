import { apiUser, fromError, isResponse, json } from "@/lib/api/v1";
import { getValidations } from "@/lib/services/validations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/v1/properties/{id}/validations : état des validations d'activation (planchers, rapprochement) et grille de planchers à valider (`fingerprint` à renvoyer pour valider). */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await apiUser(); if (isResponse(u)) return u;
  const { id } = await params;
  try { const v = await getValidations(u.tenantId, id); return json({ status: v.status, floors: v.floors, fingerprint: v.fingerprint, grid: v.grid, reconciliation: v.reconciliation, reconciliationSource: v.reconciliationDetail }); } catch (e) { return fromError(e); }
}
