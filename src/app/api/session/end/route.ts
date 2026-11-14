import { destroySession } from "@/lib/auth";

export const dynamic = "force-dynamic";
/** Déconnexion pour inactivité : supprime la session en base et le cookie. */
export async function POST() {
  await destroySession();
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
