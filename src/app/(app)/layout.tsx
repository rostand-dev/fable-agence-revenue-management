import { IdleGuard } from "@/components/IdleGuard";
import { Shell } from "@/components/Shell";
import { requireUser } from "@/lib/auth";
import { openCount } from "@/lib/queries";

export const dynamic = "force-dynamic";
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return <><IdleGuard /><Shell open={await openCount(user.tenantId)}>{children}</Shell></>;
}
