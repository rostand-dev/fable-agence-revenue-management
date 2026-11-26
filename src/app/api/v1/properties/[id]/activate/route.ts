import { apiWriter, fromError, isResponse, json } from "@/lib/api/v1";
import { activateProperty } from "@/lib/services/quality";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/v1/properties/{id}/activate : Observation → Actif. 400 (INVALID) avec les points à corriger si la checklist n'est pas satisfaite, si le logement n'est pas en observation ou s'il est déjà actif. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await apiWriter(req, "property.manage", (await params).id); if (isResponse(u)) return u;
  const { id } = await params;
  try { await activateProperty(u, id); return json({ ok: true }); } catch (e) { return fromError(e); }
}
