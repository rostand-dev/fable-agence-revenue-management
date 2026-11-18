import { IdleGuard } from "@/components/IdleGuard";
import { requireUser } from "@/lib/auth";
import { idleMsFromEnv } from "@/lib/session-policy";

export const dynamic = "force-dynamic";
/** Parcours de création d'un logement : plein écran, sans menu latéral, pour qu'on ne puisse pas en sortir par erreur. */
export default async function FunnelLayout({ children }: { children: React.ReactNode }) {
  await requireUser();
  return <><IdleGuard idleMs={idleMsFromEnv()} /><div className="fn">{children}</div></>;
}
