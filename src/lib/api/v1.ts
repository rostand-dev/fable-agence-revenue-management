import { getUser, type CurrentUser } from "@/lib/auth";
import { PortfolioError } from "@/lib/services/portfolio";

/** Aides communes de l'API REST V1 (blueprint §13.1). Authentification par la session du cockpit ; le propriétaire d'espace n'est jamais un paramètre. */
export const NO_STORE = { "Cache-Control": "no-store" };
export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });
export const apiError = (status: number, code: string, message: string) => json({ error: { code, message } }, status);

/** Utilisateur de la session, ou la réponse 401 à renvoyer telle quelle. */
export async function apiUser(): Promise<CurrentUser | Response> {
  const u = await getUser();
  return u ?? apiError(401, "UNAUTHENTICATED", "Session expirée : reconnectez-vous.");
}

/**
 * Une requête qui modifie ne vient que de l'application elle-même : si le navigateur indique son origine, elle doit être celle du site.
 * (Le cookie de session est SameSite=Lax : une autre origine ne l'envoie déjà pas ; ce contrôle est une seconde barrière.)
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try { return !!host && new URL(origin).host === host; } catch { return false; }
}
/** Réponse 403 à renvoyer si la requête qui modifie vient d'une autre origine ; null sinon. */
export const originGuard = (req: Request): Response | null => (sameOrigin(req) ? null : apiError(403, "FORBIDDEN_ORIGIN", "Origine de la requête refusée."));
/** Corps JSON objet ; sinon la réponse d'erreur à renvoyer. */
export async function readObject(req: Request): Promise<Record<string, unknown> | Response> {
  const refused = originGuard(req); if (refused) return refused;
  let body: unknown;
  try { body = await req.json(); } catch { return apiError(400, "INVALID_JSON", "Le corps de la requête doit être un objet JSON."); }
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : apiError(400, "INVALID_JSON", "Le corps de la requête doit être un objet JSON.");
}
/** Erreur d'un service → réponse HTTP. Une erreur inattendue est consignée sans détail côté client. */
export function fromError(e: unknown): Response {
  if (e instanceof PortfolioError) return apiError(e.code === "NOT_FOUND" ? 404 : e.code === "CONFLICT" ? 409 : 400, e.code, e.message);
  console.error("[api/v1]", e instanceof Error ? e.message : e);
  return apiError(500, "INTERNAL", "Erreur technique : rien n'a été modifié.");
}
export const isResponse = (x: unknown): x is Response => x instanceof Response;

export const ownerView = (o: { id: string; name: string; email: string | null; notes: string | null; isDefault: boolean; propertyCount?: number; createdAt: Date }) => ({ id: o.id, name: o.name, email: o.email, notes: o.notes, isDefault: o.isDefault, propertyCount: o.propertyCount ?? 0, createdAt: o.createdAt.toISOString() });
/** Un logement vu par l'API : jamais les connexions (clés chiffrées, jetons) ni les réglages internes. */
export const propertyView = (p: { id: string; ownerId: string | null; name: string; city: string; kind: string; bedrooms: number | null; capacity: number | null; status: string; isDemo: boolean; strategyVersion: number; createdAt: Date }) => ({ id: p.id, ownerId: p.ownerId, name: p.name, city: p.city, kind: p.kind, bedrooms: p.bedrooms, capacity: p.capacity, status: p.status, isDemo: p.isDemo, strategyVersion: p.strategyVersion, createdAt: p.createdAt.toISOString() });
export const listingView = (l: { id: string; propertyId: string; channel: string; externalId: string | null; url: string | null; title: string | null; status: string; createdAt: Date; updatedAt: Date }) => ({ id: l.id, propertyId: l.propertyId, channel: l.channel, externalId: l.externalId, url: l.url, title: l.title, status: l.status, createdAt: l.createdAt.toISOString(), updatedAt: l.updatedAt.toISOString() });
