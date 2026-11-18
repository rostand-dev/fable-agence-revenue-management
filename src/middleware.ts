import { NextResponse, type NextRequest } from "next/server";
import { blockedInReadonly, DEMO_READONLY_MESSAGE, demoReadonly } from "@/lib/demo-mode";

/** Instance de démo : refuse toute requête qui modifie (actions serveur, API). Sans DEMO_READONLY, ne fait rien. */
export function middleware(req: NextRequest) {
  if (demoReadonly() && blockedInReadonly(req.method, req.nextUrl.pathname)) {
    const headers = { "Cache-Control": "no-store" };
    // les clients de l'API (assistant d'équipe) affichent le champ « error » tel quel
    if (req.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error: DEMO_READONLY_MESSAGE }, { status: 403, headers });
    return new NextResponse(DEMO_READONLY_MESSAGE, { status: 403, headers });
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
