import { apiError, apiUser, isResponse, json } from "@/lib/api/v1";
import { getSnapshotPayload } from "@/lib/services/snapshots";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/v1/snapshots/{snapshotId} : métadonnées et réponse brute de la source (lineage d'une valeur affichée). 404 hors du locataire. */
export async function GET(_: Request, { params }: { params: Promise<{ snapshotId: string }> }) {
  const u = await apiUser(); if (isResponse(u)) return u;
  const { snapshotId } = await params;
  const r = await getSnapshotPayload(u.tenantId, snapshotId);
  return r ? json(r) : apiError(404, "NOT_FOUND", "Snapshot introuvable.");
}
