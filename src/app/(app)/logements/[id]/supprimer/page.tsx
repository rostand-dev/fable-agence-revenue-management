import Link from "next/link";
import { notFound } from "next/navigation";
import { and, count, eq } from "drizzle-orm";
import { DeletePropertyForm } from "@/components/DeletePropertyForm";
import { Icon } from "@/components/Icon";
import { Page } from "@/components/Page";
import { Banner } from "@/components/ui";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { can, denyMessage, ROLE_LABEL, rolesWith } from "@/lib/rbac";

export const metadata = { title: "Supprimer le logement" };
export default async function Supprimer({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const [p] = await db.select().from(schema.properties).where(and(eq(schema.properties.id, id), eq(schema.properties.tenantId, user.tenantId)));
  if (!p || p.isDemo) notFound();
  const crumbs = [{ label: "Logements", href: "/logements" }, { label: p.name, href: `/logements/${p.id}` }, { label: "Supprimer" }];
  const back = <p style={{ margin: "0 0 16px" }}><Link className="btn btn-ghost btn-sm" href={`/logements/${p.id}`}><Icon name="back" />Retour à la fiche</Link></p>;
  if (!can(user.role, "property.delete")) {
    return (
      <Page title="Supprimer le logement" sub={p.name} crumbs={crumbs}>
        {back}
        <div className="page-head"><h1>{`Supprimer ${p.name}`}</h1></div>
        <div data-testid="suppression-reservee">
          <Banner role="tech" title="Suppression réservée">{denyMessage(user.role, "property.delete")} Adressez-vous à un compte autorisé : {rolesWith("property.delete").map((r) => ROLE_LABEL[r]).join(" ou ")}.</Banner>
        </div>
      </Page>
    );
  }
  const n = async (t: typeof schema.reservations | typeof schema.opportunities | typeof schema.listings) => Number((await db.select({ n: count() }).from(t as any).where(eq((t as any).propertyId, p.id)))[0].n);
  const [resas, opps, lst] = await Promise.all([n(schema.reservations), n(schema.opportunities), n(schema.listings)]);
  return (
    <Page title="Supprimer le logement" sub={p.name} crumbs={crumbs}>
      {back}
      <div className="page-head"><h1>{`Supprimer ${p.name}`}</h1><p>La suppression est définitive. Le journal d'audit conserve la trace de ce qui a été supprimé, et par qui.</p></div>
      <Banner role="attention" title="Ce qui sera supprimé" style={{ marginBottom: 16 }}>
        Le dossier du logement, ses coûts et sa stratégie, ses connexions PriceLabs et SuperHote (clés comprises), {resas} réservation{resas > 1 ? "s" : ""}, {opps} situation{opps > 1 ? "s" : ""} et décision{opps > 1 ? "s" : ""}, {lst} annonce{lst > 1 ? "s" : ""}, et le calendrier lu. Les autres logements ne sont pas touchés.
      </Banner>
      <DeletePropertyForm propertyId={p.id} name={p.name} />
    </Page>
  );
}
