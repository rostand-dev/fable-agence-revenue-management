import { NextResponse, type NextRequest } from "next/server";
import { previewAuthDecision } from "@/lib/preview-auth";
import { blockedInReadonly, DEMO_READONLY_MESSAGE, demoReadonly } from "@/lib/demo-mode";
import { PATH_HEADER } from "@/lib/nav";

/** Proxy Next.js 16 (ancien middleware, exécuté par Node.js). Preview : mot de passe exigé si configuré. Instance de démo : refuse toute requête qui modifie (actions serveur, API). Sans DEMO_READONLY, rien n'est refusé.
 * Toute requête acceptée reçoit le chemin demandé (mode poche : les pages savent quel écran elles affichent) et le navigateur est invité à dire s'il est mobile. */
export function proxy(req: NextRequest) {
  // Preview protégée par mot de passe (variables PREVIEW_BASIC_AUTH_* posées uniquement sur les previews Coolify) : avant toute autre règle.
  const gate = previewAuthDecision(req.nextUrl.pathname, req.headers.get("authorization"));
  if (gate === "challenge") return new NextResponse("Authentification requise", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="NuitSignal preview", charset="UTF-8"', "Cache-Control": "no-store" } });
  if (gate === "misconfigured") return new NextResponse("Protection de la preview mal configurée : accès refusé.", { status: 503, headers: { "Cache-Control": "no-store" } });
  if (demoReadonly() && blockedInReadonly(req.method, req.nextUrl.pathname)) {
    const headers = { "Cache-Control": "no-store" };
    // les clients de l'API (assistant d'équipe) affichent le champ « error » tel quel
    if (req.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error: DEMO_READONLY_MESSAGE }, { status: 403, headers });
    return new NextResponse(DEMO_READONLY_MESSAGE, { status: 403, headers });
  }
  // toujours réécrit ici : une valeur envoyée par le navigateur est ignorée
  const headers = new Headers(req.headers);
  headers.set(PATH_HEADER, req.nextUrl.pathname + req.nextUrl.search);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("Accept-CH", "Sec-CH-UA-Mobile");
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
