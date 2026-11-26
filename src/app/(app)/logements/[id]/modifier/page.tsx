import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { Icon } from "@/components/Icon";
import { Page } from "@/components/Page";
import { PropertyForm } from "@/components/PropertyForm";
import { Banner } from "@/components/ui";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { missingEconomics } from "@/lib/engine/economics";
import type { EconomicModel, Strategy } from "@/lib/engine/types";
import { can } from "@/lib/rbac";
import { listOwners } from "@/lib/services/portfolio";

export const metadata = { title: "Dossier du logement" };
export default async function Modifier({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ enregistre?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const [p] = await db.select().from(schema.properties).where(and(eq(schema.properties.id, id), eq(schema.properties.tenantId, user.tenantId)));
  if (!p || p.isDemo) notFound();
  // pendant la création, le dossier se complète dans le parcours guidé
  if (p.status === "ONBOARDING") redirect(`/logements/${p.id}/creation?etape=logement`);
  const owners = await listOwners(user.tenantId);
  return (
    <Page title="Modifier le dossier" sub={p.name} crumbs={[{ label: "Logements", href: "/logements" }, { label: p.name, href: `/logements/${p.id}` }, { label: "Modifier" }]}>
      <p style={{ margin: "0 0 16px" }}><Link className="btn btn-ghost btn-sm" href={`/logements/${p.id}`}><Icon name="back" />Retour à la fiche</Link></p>
      <div className="page-head">
        <h1>{`Dossier de ${p.name}`}</h1>
        <p>Identité du logement et séjour minimum. Les coûts, commissions et seuils se revoient dans le parcours Coûts et seuils.</p>
      </div>
      {(await searchParams).enregistre && <Banner role="sain" title="Saisie enregistrée" style={{ marginBottom: 8 }}>Vos modifications sont enregistrées.</Banner>}
      <PropertyForm existing={{ id: p.id, name: p.name, city: p.city, kind: p.kind, bedrooms: p.bedrooms, capacity: p.capacity, economics: p.economics as EconomicModel, strategy: p.strategy as Strategy, profile: p.profile, hasKey: !!p.pricelabs?.apiKeyEnc, hasShKey: !!p.superhote?.apiKeyEnc, channelMarkups: p.channelMarkups ?? [], ownerId: p.ownerId }} owners={owners} />
      {can(user.role, "property.delete") && <section className="section" style={{ marginTop: 36 }}><h2>Supprimer le logement</h2><p className="section-note">Suppression définitive du dossier et de tout ce qui s'y rattache.</p><Link className="btn btn-danger btn-sm" href={`/logements/${p.id}/supprimer`}><Icon name="cross" />Supprimer ce logement…</Link></section>}
    </Page>
  );
}
