import { destroySession } from "@/lib/auth";
import { forgetThisDevice } from "@/lib/remember";

export const dynamic = "force-dynamic";
/**
 * Fin de session côté navigateur. Par défaut (inactivité) : la session est supprimée mais l'appareil reste reconnu s'il a coché « Rester connecté ».
 * Avec ?forget=1 (déconnexion volontaire) : l'appareil est aussi oublié.
 */
export async function POST(req: Request) {
  await destroySession();
  if (new URL(req.url).searchParams.get("forget") === "1") await forgetThisDevice();
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
