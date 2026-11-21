import { apiUser, fromError, isResponse, json, readObject } from "@/lib/api/v1";
import { rollbackToVersion } from "@/lib/services/strategy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/v1/properties/{id}/strategy/rollback : { version, note? } restaure les réglages d'une version antérieure comme nouvelle version (les prix ne sont pas restaurés). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await apiUser(); if (isResponse(u)) return u;
  const body = await readObject(req); if (isResponse(body)) return body;
  const { id } = await params;
  try { return json({ version: await rollbackToVersion(u, id, body.version, body.note) }); } catch (e) { return fromError(e); }
}
