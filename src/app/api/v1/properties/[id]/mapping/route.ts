import { apiUser, fromError, isResponse, json, readObject } from "@/lib/api/v1";
import { confirmMapping, getMapping } from "@/lib/services/mapping";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

/** GET /api/v1/properties/{id}/mapping : état du mapping (items, écarts détectés, statut INCOMPLETE | TO_CONFIRM | CONFIRMED | STALE). */
export async function GET(_: Request, { params }: Ctx) {
  const u = await apiUser(); if (isResponse(u)) return u;
  const { id } = await params;
  try {
    const m = await getMapping(u.tenantId, id);
    return json({ status: m.status, fingerprint: m.fingerprint, confirmable: m.confirmable, confirmedAt: m.confirmedAt, missingRequired: m.missingRequired, items: m.items.map(({ key, label, required, state, detail, value }) => ({ key, label, required, state, detail, value })), checks: m.checks });
  } catch (e) { return fromError(e); }
}
/** POST /api/v1/properties/{id}/mapping : { fingerprint, acknowledge? } confirme (fingerprint : celui lu par le GET, pour confirmer ce qui a été vu ; acknowledge exigé s'il y a des écarts) le mapping (acknowledge exigé s'il y a des écarts). */
export async function POST(req: Request, { params }: Ctx) {
  const u = await apiUser(); if (isResponse(u)) return u;
  const body = await readObject(req); if (isResponse(body)) return body;
  const { id } = await params;
  try { await confirmMapping(u, id, body.acknowledge === true, body.fingerprint); return json({ ok: true }); } catch (e) { return fromError(e); }
}
