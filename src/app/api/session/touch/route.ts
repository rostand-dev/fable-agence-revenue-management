import { getUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
/** Signal d'activité du navigateur : getUser repousse l'échéance. 401 si la session a déjà expiré. */
export async function POST() {
  const u = await getUser();
  return new Response(null, { status: u ? 204 : 401, headers: { "Cache-Control": "no-store" } });
}
