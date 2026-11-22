import { apiError, apiUser, fromError, isResponse, json } from "@/lib/api/v1";
import { getPerformance, parsePerformanceQuery } from "@/lib/services/performance";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/v1/properties/{id}/performance : KPI canoniques (occupation, ADR, Net ADR, RevPAN, Net RevPAN) d'un logement, lecture seule.
 * Sans paramètre : les 12 derniers mois civils complets, avec le détail mensuel et les cinq fenêtres à venir.
 * `?months=N` (1 à 24) : les N derniers mois complets · `?from=AAAA-MM-JJ&to=AAAA-MM-JJ` : une période libre (nuits du `from` inclus au `to` exclu).
 * Un montant inconnu est `null`, jamais 0 ; `netStatus` dit si le net est complet, partiel ou inconnu.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await apiUser(); if (isResponse(u)) return u;
  const q = parsePerformanceQuery(new URL(req.url).searchParams);
  if (!q.ok) return apiError(400, "INVALID", q.error);
  const { id } = await params;
  try { return json(await getPerformance(u.tenantId, id, q.value)); } catch (e) { return fromError(e); }
}
