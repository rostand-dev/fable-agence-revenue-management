import { apiError, apiWriter, fromError, isResponse, json, readObject } from "@/lib/api/v1";
import { saveSeasons } from "@/lib/services/seasons";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * PUT /api/v1/properties/{id}/economics/seasons : remplace les saisons (corps `{ seasons: [{ label, from: "MM-JJ", to: "MM-JJ", strategyContributionPerNightCents }] }`, liste vide = aucune saison).
 * 400 (INVALID) si une saison est incorrecte ou chevauche une autre ; crée une version du modèle économique et invalide la validation des planchers.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await apiWriter(req, "property.manage", (await params).id); if (isResponse(u)) return u;
  const body = await readObject(req); if (isResponse(body)) return body;
  if (!Array.isArray(body.seasons)) return apiError(400, "INVALID", "Champ « seasons » : une liste est attendue (vide pour supprimer les saisons).");
  const { id } = await params;
  try { return json(await saveSeasons(u, id, body.seasons)); } catch (e) { return fromError(e); }
}
