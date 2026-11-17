import { NextResponse, type NextRequest } from "next/server";
import { blockedInReadonly, demoReadonly } from "@/lib/demo-mode";

/** Instance de démo : refuse toute requête qui modifie (actions serveur, API). Sans DEMO_READONLY, ne fait rien. */
export function middleware(req: NextRequest) {
  if (demoReadonly() && blockedInReadonly(req.method, req.nextUrl.pathname))
    return new NextResponse("Démo en lecture seule : cette action n'est pas disponible.", { status: 403, headers: { "Cache-Control": "no-store" } });
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
