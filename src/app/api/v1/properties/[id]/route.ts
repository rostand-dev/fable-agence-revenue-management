import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { apiError, apiUser, fromError, isResponse, json, propertyView, readObject } from "@/lib/api/v1";
import { deleteProperty, updatePropertyIdentity } from "@/lib/services/portfolio";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_: Request, { params }: Ctx) {
  const u = await apiUser(); if (isResponse(u)) return u;
  const [p] = await db.select().from(schema.properties).where(and(eq(schema.properties.id, (await params).id), eq(schema.properties.tenantId, u.tenantId)));
  return p ? json(propertyView(p)) : apiError(404, "NOT_FOUND", "Logement introuvable.");
}
/** PATCH /api/v1/properties/{id} : champs d'identité présents (name, city, kind, bedrooms, capacity, positioning, objective) et ownerId. */
export async function PATCH(req: Request, { params }: Ctx) {
  const u = await apiUser(); if (isResponse(u)) return u;
  const body = await readObject(req); if (isResponse(body)) return body;
  try { await updatePropertyIdentity(u, (await params).id, body); return json({ ok: true }); } catch (e) { return fromError(e); }
}
/** DELETE /api/v1/properties/{id} : { "confirmName": "<nom exact du logement>" } obligatoire. */
export async function DELETE(req: Request, { params }: Ctx) {
  const u = await apiUser(); if (isResponse(u)) return u;
  const body = await readObject(req); if (isResponse(body)) return body;
  try { await deleteProperty(u, (await params).id, body.confirmName); return json({ ok: true }); } catch (e) { return fromError(e); }
}
