import { NextResponse, type NextRequest } from "next/server";
import { deskScreen } from "@/lib/nav";
import { addForced, FORCE_COOKIE, isViewMode, safeReturnPath, VIEW_COOKIE } from "@/lib/view-mode";

export const dynamic = "force-dynamic";

/**
 * Préférence d'affichage (aucune donnée modifiée, aucune session requise).
 * - `?mode=poche|complet` : version choisie, gardée un an ;
 * - `?afficher=/chemin` (avec `?tab=` pour une rubrique de la fiche logement) : « Afficher quand même » sur un écran réservé à l'ordinateur, gardé jusqu'à la fermeture du navigateur ;
 * - `&retour=/chemin` : page affichée ensuite (chemin interne seulement).
 * En GET : le proxy refuse les actions serveur sur la démo en lecture seule.
 */
export function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  // adresse relative : derrière le proxy Coolify, l'hôte vu par le serveur n'est pas celui du navigateur
  const res = new NextResponse(null, { status: 303, headers: { Location: safeReturnPath(q.get("retour")), "Cache-Control": "no-store" } });
  const options = { httpOnly: true, sameSite: "lax" as const, secure: (process.env.APP_URL ?? "").startsWith("https"), path: "/" };
  const mode = q.get("mode");
  if (isViewMode(mode)) res.cookies.set(VIEW_COOKIE, mode, { ...options, maxAge: 365 * 86_400 });
  const asked = q.get("afficher");
  const screen = asked ? deskScreen(safeReturnPath(asked)) : null;
  if (screen) res.cookies.set(FORCE_COOKIE, addForced(req.cookies.get(FORCE_COOKIE)?.value, screen.key), options);
  return res;
}
