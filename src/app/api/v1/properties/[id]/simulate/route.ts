import { apiUser, fromError, isResponse, json } from "@/lib/api/v1";
import { simulateForProperty } from "@/lib/services/simulator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/v1/properties/{id}/simulate?channel=BOOKING&nights=3&price=15000&from=2026-07-10&los=5&promo=GENIUS:10&promo=LIMITED:5
 * Discount Stack Simulator explicable (lecture seule, rien n'est enregistré). `price` : prix publié par nuit sur le canal, en centimes.
 * Réponse : la cascade expliquée étape par étape (qui se referme sur la contribution), les planchers de la saison du séjour, les règles de cumul
 * et un verdict OK, WARN, NEEDS_HUMAN (règle de cumul inconnue ou registre périmé) ou REJECT (sous le plancher absolu ou au-delà du plafond de cumul).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await apiUser(); if (isResponse(u)) return u;
  const { id } = await params;
  try { return json(await simulateForProperty(u.tenantId, id, new URL(req.url).searchParams)); } catch (e) { return fromError(e); }
}
