import { apiError, apiUser, apiWriter, fromError, isResponse, json, readObject } from "@/lib/api/v1";
import { discardDraft, getStrategyState, saveDraft } from "@/lib/services/strategy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

/** GET /api/v1/properties/{id}/strategy : stratégie en vigueur, brouillon avec ses écarts, historique des versions. */
export async function GET(_: Request, { params }: Ctx) {
  const u = await apiUser(); if (isResponse(u)) return u;
  const { id } = await params;
  try {
    const s = await getStrategyState(u.tenantId, id);
    return json({ version: s.version, published: s.published, prices: { basePriceCents: s.current.basePriceCents ?? null, minPriceCents: s.current.minPriceCents ?? null, maxPriceCents: s.current.maxPriceCents ?? null }, draft: s.draft, versions: s.versions.map((v) => ({ version: v.version, source: v.source, author: v.author, note: v.note, createdAt: v.createdAt.toISOString(), changes: v.changes })) });
  } catch (e) { return fromError(e); }
}
/** PUT : enregistre le brouillon { objective?, positioning?, minStay?, maxDiscountStackPct?, maxPriceChangePct?, baseVersion? } ; baseVersion = version vue par l'appelant (409 si les réglages ont changé depuis). Aucun effet sur la stratégie en vigueur. */
export async function PUT(req: Request, { params }: Ctx) {
  const u = await apiWriter(req, "property.manage", (await params).id); if (isResponse(u)) return u;
  const body = await readObject(req); if (isResponse(body)) return body;
  const { id } = await params;
  const { baseVersion, ...values } = body as Record<string, unknown>;
  if (baseVersion != null && !Number.isInteger(baseVersion)) return apiError(400, "INVALID", "baseVersion doit être un entier.");
  try { await saveDraft(u, id, values, (baseVersion as number | undefined) ?? null); return json({ ok: true }); } catch (e) { return fromError(e); }
}
/** DELETE : abandonne le brouillon. */
export async function DELETE(req: Request, { params }: Ctx) {
  const u = await apiWriter(req, "property.manage", (await params).id); if (isResponse(u)) return u;
  const { id } = await params;
  try { await discardDraft(u, id); return json({ ok: true }); } catch (e) { return fromError(e); }
}
