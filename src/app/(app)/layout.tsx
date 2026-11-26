import { IdleGuard } from "@/components/IdleGuard";
import { Shell } from "@/components/Shell";
import { requireUser } from "@/lib/auth";
import { menuPropertyList, openCount } from "@/lib/queries";
import { openAlertCount } from "@/lib/services/execution-alerts";
import { isLlmAdmin } from "@/lib/llm-registry/admin";
import { pendingPriceCount } from "@/lib/llm-registry/price-validation";
import { idleMsFromEnv } from "@/lib/session-policy";
import { demoReadonly, demoSignupUrl } from "@/lib/demo-mode";
import { RightsProvider } from "@/components/Rights";
import { getViewContext } from "@/lib/view-mode";

export const dynamic = "force-dynamic";
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [open, alerts, properties, prices, view] = await Promise.all([openCount(user.tenantId), openAlertCount(user.tenantId), menuPropertyList(user.tenantId), pendingPriceCount(), getViewContext()]);
  return <RightsProvider role={user.role}><IdleGuard idleMs={idleMsFromEnv()} /><Shell open={open} alerts={alerts} prices={prices} pricesDecide={isLlmAdmin(user.email)} properties={properties} demo={demoReadonly()} exitHref={demoSignupUrl() ?? "/demo"} pocket={view.mode === "poche"}>{children}</Shell></RightsProvider>;
}
