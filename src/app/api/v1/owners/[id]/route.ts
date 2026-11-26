import { apiWriter, fromError, isResponse, json, readObject } from "@/lib/api/v1";
import { deleteOwner, updateOwner } from "@/lib/services/portfolio";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/v1/owners/{id} : { name, email?, notes? } (remplace les trois champs). */
export async function PATCH(req: Request, { params }: Ctx) {
  const u = await apiWriter(req, "property.manage"); if (isResponse(u)) return u;
  const body = await readObject(req); if (isResponse(body)) return body;
  try { await updateOwner(u, (await params).id, body); return json({ ok: true }); } catch (e) { return fromError(e); }
}
/** DELETE /api/v1/owners/{id} : refusé pour le propriétaire par défaut ou s'il possède des logements. */
export async function DELETE(req: Request, { params }: Ctx) {
  const u = await apiWriter(req, "property.manage"); if (isResponse(u)) return u;
  try { await deleteOwner(u, (await params).id); return json({ ok: true }); } catch (e) { return fromError(e); }
}
