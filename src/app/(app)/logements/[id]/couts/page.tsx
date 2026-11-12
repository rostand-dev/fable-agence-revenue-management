import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { CostWizard } from "@/components/CostWizard";
import { Icon } from "@/components/Icon";
import { Page } from "@/components/Page";
import { db, schema } from "@/db";
import { agentName } from "@/lib/agents/registry";
import { requireUser } from "@/lib/auth";
import { todayISO } from "@/lib/dates";
import { answersFromModel } from "@/lib/engine/costs";
import { lastMonths, medianLos, monthlyKpis } from "@/lib/engine/metrics";
import type { EconomicModel, Strategy } from "@/lib/engine/types";

export const metadata = { title: "Coûts et seuils" };
export default async function Couts({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ etape?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const [p] = await db.select().from(schema.properties).where(and(eq(schema.properties.id, id), eq(schema.properties.tenantId, user.tenantId)));
  if (!p || p.isDemo) notFound();
  const resas = await db.select().from(schema.reservations).where(eq(schema.reservations.propertyId, p.id));
  const k = monthlyKpis(resas, lastMonths(todayISO(), 12)).filter((m) => m.nights > 0);
  const nightsSold = k.length ? k.reduce((a, m) => a + m.nights, 0) : null;
  const ines = agentName("onboarding", user.settings.agentNames);
  const step = Math.min(7, Math.max(0, Number((await searchParams).etape ?? 1) - 1 || 0));
  return (
    <Page title="Coûts et seuils" sub={`${p.name} · avec ${ines}`} crumbs={[{ label: "Logements", href: "/logements" }, { label: p.name, href: `/logements/${p.id}` }, { label: "Coûts et seuils" }]}>
      <p style={{ margin: "0 0 16px" }}><Link className="btn btn-ghost btn-sm" href={`/logements/${p.id}`}><Icon name="back" />Retour à la fiche</Link></p>
      <div className="page-head">
        <h1>Vos coûts et vos seuils, pas à pas</h1>
        <p>Huit écrans courts, une question concrète à la fois. {ines} en déduit vos planchers : le prix en dessous duquel l'équipe ne proposera jamais rien. Si vous ne savez pas, laissez vide ou donnez une estimation provisoire ; vos réponses sont enregistrées à chaque étape.</p>
      </div>
      <CostWizard propertyId={p.id} propertyName={p.name} startAt={step} initial={answersFromModel(p.economics as EconomicModel)}
        hints={{ ines, observed: p.pricelabs?.lastSync?.observedCommission ?? {}, nightsSold, monthsCovered: k.length || null, avgStay: medianLos(resas), minPriceCents: (p.strategy as Strategy)?.minPriceCents ?? null }} />
    </Page>
  );
}
