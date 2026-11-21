import { apiError, apiUser, fromError, isResponse, json, originGuard, readObject } from "@/lib/api/v1";
import { deleteListing, setListingStatus, updateListing } from "@/lib/services/portfolio";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string; listingId: string }> };

/** PATCH : externalId, url, title présents, et/ou status (ACTIVE | ARCHIVED). Le canal ne change pas. */
export async function PATCH(req: Request, { params }: Ctx) {
  const u = await apiUser(); if (isResponse(u)) return u;
  const body = await readObject(req); if (isResponse(body)) return body;
  const { id, listingId } = await params;
  if ("channel" in body) return apiError(400, "INVALID", "Le canal d'une annonce ne change pas : supprimez-la et créez-en une autre.");
  if ("status" in body && body.status !== "ACTIVE" && body.status !== "ARCHIVED") return apiError(400, "INVALID", "status : ACTIVE ou ARCHIVED.");
  try {
    const { status, ...fields } = body;
    if (Object.keys(fields).length) await updateListing(u, id, listingId, fields);
    if (status === "ACTIVE" || status === "ARCHIVED") await setListingStatus(u, id, listingId, status);
    return json({ ok: true });
  } catch (e) { return fromError(e); }
}
export async function DELETE(req: Request, { params }: Ctx) {
  const u = await apiUser(); if (isResponse(u)) return u;
  const refused = originGuard(req); if (refused) return refused;
  const { id, listingId } = await params;
  try { await deleteListing(u, id, listingId); return json({ ok: true }); } catch (e) { return fromError(e); }
}
