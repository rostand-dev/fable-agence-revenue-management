import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { apiUser, apiWriter, fromError, isResponse, json, propertyView, readObject } from "@/lib/api/v1";
import { createProperty } from "@/lib/services/portfolio";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/v1/properties : logements de l'espace (identité et statut ; jamais les clés de connexion). */
export async function GET() {
  const u = await apiUser(); if (isResponse(u)) return u;
  const rows = await db.select().from(schema.properties).where(eq(schema.properties.tenantId, u.tenantId)).orderBy(desc(schema.properties.createdAt));
  return json({ properties: rows.map(propertyView) });
}
/** POST /api/v1/properties : { name, city, kind, bedrooms?, capacity?, positioning?, objective?, ownerId? }. Crée un dossier en cours de création (ONBOARDING). */
export async function POST(req: Request) {
  const u = await apiWriter(req, "property.manage"); if (isResponse(u)) return u;
  const body = await readObject(req); if (isResponse(body)) return body;
  try { const c = await createProperty(u, body); return json({ id: c.id, name: c.name, status: "ONBOARDING" }, 201); } catch (e) { return fromError(e); }
}
