import { IdleGuard } from "@/components/IdleGuard";
import { Shell } from "@/components/Shell";
import { requireUser } from "@/lib/auth";
import { openCount } from "@/lib/queries";
import { idleMsFromEnv } from "@/lib/session-policy";
import { demoReadonly, demoSignupUrl } from "@/lib/demo-mode";

export const dynamic = "force-dynamic";
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return <><IdleGuard idleMs={idleMsFromEnv()} /><Shell open={await openCount(user.tenantId)} demo={demoReadonly()} exitHref={demoSignupUrl() ?? "/demo"}>{children}</Shell></>;
}
