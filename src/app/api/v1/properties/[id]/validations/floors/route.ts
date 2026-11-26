import { apiWriter, fromError, isResponse, json, readObject } from "@/lib/api/v1";
import { validateFloors } from "@/lib/services/validations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/v1/properties/{id}/validations/floors { fingerprint, note? } : valide la grille de planchers vue (fingerprint lu via GET …/validations). 409 si la grille a changé. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await apiWriter(req, "property.manage", (await params).id); if (isResponse(u)) return u;
  const body = await readObject(req); if (isResponse(body)) return body;
  const { id } = await params;
  try { await validateFloors(u, id, body.fingerprint, body.note); return json({ ok: true }); } catch (e) { return fromError(e); }
}
