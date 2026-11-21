import { MAX_WEBHOOK_BYTES } from "@/lib/integrations/superhote-webhook";
import { receiveWebhook } from "@/lib/services/superhote-webhook";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Réception des webhooks SuperHote (US-030). Pas de session : l'authenticité vient de la signature HMAC-SHA256 du corps brut (secret propre à chaque
 * point de réception). SuperHote exige une réponse 2xx sous 10 s : l'inscription et le traitement d'une réservation tiennent largement dans ce délai.
 * 401 signature invalide · 404 point inconnu · 400 enveloppe invalide · 413 trop volumineux · 500/503 traitement impossible ou base indisponible (SuperHote réessaie à 1 puis 5 minutes ; la livraison est reprise, jamais traitée deux fois).
 */
/** Lit le corps en s'arrêtant dès que la limite est dépassée (en-tête content-length absent, faux ou transfert fragmenté compris). null = trop volumineux. */
async function readBounded(req: Request): Promise<Buffer | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) return null;
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_WEBHOOK_BYTES) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

export async function POST(req: Request, ctx: { params: Promise<{ endpointId: string }> }) {
  const { endpointId } = await ctx.params;
  const raw = await readBounded(req);
  if (!raw) return Response.json({ error: "Corps trop volumineux." }, { status: 413, headers: { "Cache-Control": "no-store" } });
  try {
    const r = await receiveWebhook(endpointId, raw, { signature: req.headers.get("x-superhote-signature"), event: req.headers.get("x-superhote-event"), delivery: req.headers.get("x-superhote-delivery") });
    return Response.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[superhote-webhook] réception impossible :", e instanceof Error ? e.message : e);
    return Response.json({ error: "Réception momentanément impossible." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
