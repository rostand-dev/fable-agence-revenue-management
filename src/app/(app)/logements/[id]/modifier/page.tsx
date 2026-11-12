import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { Icon } from "@/components/Icon";
import { Page } from "@/components/Page";
import { PropertyForm } from "@/components/PropertyForm";
import { Banner } from "@/components/ui";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { missingEconomics } from "@/lib/engine/economics";
import type { EconomicModel, Strategy } from "@/lib/engine/types";

export const metadata = { title: "Dossier du logement" };
export default async function Modifier({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ enregistre?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const [p] = await db.select().from(schema.properties).where(and(eq(schema.properties.id, id), eq(schema.properties.tenantId, user.tenantId)));
  if (!p || p.isDemo) notFound();
  const miss = missingEconomics(p.economics as EconomicModel);
  const draft = p.status === "ONBOARDING";
  return (
    <Page title={draft ? "Reprendre la saisie" : "Modifier le dossier"} sub={p.name} crumbs={[{ label: "Logements", href: "/logements" }, { label: p.name, href: `/logements/${p.id}` }, { label: draft ? "Reprendre la saisie" : "Modifier" }]}>
      <p style={{ margin: "0 0 16px" }}><Link className="btn btn-ghost btn-sm" href={`/logements/${p.id}`}><Icon name="back" />Retour à la fiche</Link></p>
      <div className="page-head">
        <h1>{draft ? `Reprendre la saisie — ${p.name}` : `Dossier de ${p.name}`}</h1>
        <p>{draft ? "Votre saisie est conservée telle que vous l'avez laissée. Complétez ce que vous connaissez ; le reste peut attendre." : "Corrigez un coût, une commission ou un seuil : les planchers sont recalculés à l'enregistrement et la version de la stratégie est incrémentée."}</p>
      </div>
      {(await searchParams).enregistre && <Banner role="sain" title="Saisie enregistrée" style={{ marginBottom: 8 }}>Vous pouvez fermer cette page. Le logement apparaît dans Logements avec la mention « Saisie à reprendre ».</Banner>}
      {draft && miss.length > 0 && <Banner role="tech" title={`Il manque encore ${miss.length} valeur${miss.length > 1 ? "s" : ""} pour calculer les planchers`} style={{ marginBottom: 8 }}>{miss.join(", ")}.</Banner>}
      <PropertyForm existing={{ id: p.id, name: p.name, city: p.city, kind: p.kind, bedrooms: p.bedrooms, capacity: p.capacity, economics: p.economics as EconomicModel, strategy: p.strategy as Strategy, profile: p.profile, hasKey: !!p.pricelabs?.apiKeyEnc }} />
    </Page>
  );
}
