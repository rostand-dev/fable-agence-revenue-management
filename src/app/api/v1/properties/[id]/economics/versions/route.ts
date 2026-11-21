import { apiError, apiUser, fromError, isResponse, json } from "@/lib/api/v1";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { listEconomicsVersions } from "@/lib/services/economics-versions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/v1/properties/{id}/economics/versions : versions du modèle économique, de la plus récente à la plus ancienne. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await apiUser(); if (isResponse(u)) return u;
  const { id } = await params;
  try {
    const [p] = await db.select({ current: schema.properties.economicsVersion }).from(schema.properties).where(and(eq(schema.properties.id, id), eq(schema.properties.tenantId, u.tenantId)));
    if (!p) return apiError(404, "NOT_FOUND", "Logement introuvable.");
    const versions = await listEconomicsVersions(u.tenantId, id);
    return json({ current: p.current, versions: versions.map((v) => ({ version: v.version, createdAt: v.createdAt.toISOString(), author: v.author, changes: v.changes })) });
  } catch (e) { return fromError(e); }
}
