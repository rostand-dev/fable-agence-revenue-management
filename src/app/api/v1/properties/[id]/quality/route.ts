import { apiUser, fromError, isResponse, json } from "@/lib/api/v1";
import { getQuality } from "@/lib/services/quality";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/v1/properties/{id}/quality : checklist de qualité (points bloquants et avertissements) et `canActivate`. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await apiUser(); if (isResponse(u)) return u;
  const { id } = await params;
  try {
    const q = await getQuality(u.tenantId, id);
    const reason = q.isDemo ? "DEMO" : q.status !== "SHADOW" ? q.status : null; // pourquoi l'activation est impossible indépendamment de la checklist
    return json({ status: q.status, canActivate: q.canActivate && reason === null, notActivatableBecause: reason, blockers: q.blockers, warnings: q.warnings, items: q.items.map(({ key, label, severity, ok, detail }) => ({ key, label, severity, ok, detail })) });
  } catch (e) { return fromError(e); }
}
