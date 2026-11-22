import { apiUser, fromError, isResponse, json } from "@/lib/api/v1";
import { getFloors } from "@/lib/services/seasons";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/v1/properties/{id}/economics/floors : saisons et grille des planchers canal × durée × saison (plancher absolu unique, plancher stratégique par saison). Montants en centimes. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await apiUser(); if (isResponse(u)) return u;
  const { id } = await params;
  try { return json(await getFloors(u.tenantId, id)); } catch (e) { return fromError(e); }
}
