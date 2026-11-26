import { apiWriter, fromError, isResponse, json, readObject } from "@/lib/api/v1";
import { recordReconciliation } from "@/lib/services/validations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/v1/properties/{id}/validations/reconciliation { sampleSize, maxGapPct, source, note? } : atteste le rapprochement manuel d'un échantillon de réservations. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await apiWriter(req, "property.manage", (await params).id); if (isResponse(u)) return u;
  const body = await readObject(req); if (isResponse(body)) return body;
  const { id } = await params;
  try { await recordReconciliation(u, id, body); return json({ ok: true }); } catch (e) { return fromError(e); }
}
