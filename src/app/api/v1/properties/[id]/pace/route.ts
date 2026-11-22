import { apiUser, fromError, isResponse, json } from "@/lib/api/v1";
import { getPace } from "@/lib/services/pace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/v1/properties/{id}/pace : pickup (1, 3, 7, 14 jours) et pacing des cinq fenêtres à venir (D+0–7 … D+61–90) face à l'an dernier, lecture seule.
 * Pickup = nuits réservées pendant les N derniers jours civils (aujourd'hui compris) ; les annulations sont données à part.
 * `status` vaut UNKNOWN, avec sa raison, tant que l'historique ne remonte pas à un an : jamais « dans la cible » par défaut.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await apiUser(); if (isResponse(u)) return u;
  const { id } = await params;
  try { return json(await getPace(u.tenantId, id)); } catch (e) { return fromError(e); }
}
