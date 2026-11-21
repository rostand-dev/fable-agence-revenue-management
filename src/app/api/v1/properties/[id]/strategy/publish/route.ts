import { apiUser, fromError, isResponse, json, readObject } from "@/lib/api/v1";
import { publishDraft } from "@/lib/services/strategy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/v1/properties/{id}/strategy/publish : { note? } publie le brouillon (nouvelle version). 409 si la stratégie a changé depuis le brouillon. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await apiUser(); if (isResponse(u)) return u;
  const body = await readObject(req); if (isResponse(body)) return body;
  const { id } = await params;
  try { return json({ version: await publishDraft(u, id, body.note) }); } catch (e) { return fromError(e); }
}
