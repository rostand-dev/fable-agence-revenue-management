import { apiUser, fromError, isResponse, json } from "@/lib/api/v1";
import { getSnapshotState } from "@/lib/services/snapshots";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/v1/properties/{id}/snapshots?limit=20 : dernier snapshot de chaque nature (PRICING, MARKET) avec sa fraîcheur, puis l'historique récent. Métadonnées seulement. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await apiUser(); if (isResponse(u)) return u;
  const { id } = await params;
  const n = Number(new URL(req.url).searchParams.get("limit") ?? 20);
  try { return json(await getSnapshotState(u.tenantId, id, { limit: Number.isInteger(n) ? n : 20 })); } catch (e) { return fromError(e); }
}
