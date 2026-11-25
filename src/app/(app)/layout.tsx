import { IdleGuard } from "@/components/IdleGuard";
import { Shell } from "@/components/Shell";
import { requireUser } from "@/lib/auth";
import { menuPropertyList, openCount } from "@/lib/queries";
import { openAlertCount } from "@/lib/services/execution-alerts";
import { idleMsFromEnv } from "@/lib/session-policy";
import { demoReadonly, demoSignupUrl } from "@/lib/demo-mode";

export const dynamic = "force-dynamic";
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [open, alerts, properties] = await Promise.all([openCount(user.tenantId), openAlertCount(user.tenantId), menuPropertyList(user.tenantId)]);
  return <><IdleGuard idleMs={idleMsFromEnv()} /><Shell open={open} alerts={alerts} properties={properties} demo={demoReadonly()} exitHref={demoSignupUrl() ?? "/demo"}>{children}</Shell></>;
}
