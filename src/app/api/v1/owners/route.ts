import { apiUser, apiWriter, fromError, isResponse, json, ownerView, readObject } from "@/lib/api/v1";
import { createOwner, listOwners } from "@/lib/services/portfolio";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/v1/owners : propriétaires de l'espace, avec le nombre de logements de chacun. */
export async function GET() {
  const u = await apiUser(); if (isResponse(u)) return u;
  try { return json({ owners: (await listOwners(u.tenantId)).map(ownerView) }); } catch (e) { return fromError(e); }
}
/** POST /api/v1/owners : { name, email?, notes? } */
export async function POST(req: Request) {
  const u = await apiWriter(req, "property.manage"); if (isResponse(u)) return u;
  const body = await readObject(req); if (isResponse(body)) return body;
  try { return json({ id: await createOwner(u, body) }, 201); } catch (e) { return fromError(e); }
}
