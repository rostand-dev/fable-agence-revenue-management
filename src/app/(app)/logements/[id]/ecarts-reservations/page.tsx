import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { Icon } from "@/components/Icon";
import { Page } from "@/components/Page";
import { Banner, State } from "@/components/ui";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { fmtDate } from "@/lib/dates";
import { euro } from "@/lib/format";
import type { ReservationGap } from "@/lib/integrations/superhote-map";

export const metadata = { title: "Écarts de réservations" };
const KIND: Record<ReservationGap["kind"], string> = { ABSENTE_PRICELABS: "Absente de PriceLabs", ABSENTE_SUPERHOTE: "Absente de SuperHote", MONTANT: "Montant différent" };

/** Écran secondaire : réservations SuperHote (référence) comparées à celles de PriceLabs, pour signaler les bugs de synchronisation. */
export default async function EcartsReservations({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const [p] = await db.select().from(schema.properties).where(and(eq(schema.properties.id, id), eq(schema.properties.tenantId, user.tenantId)));
  if (!p || p.isDemo) notFound();
  const rc = (p.superhote as any)?.lastSync?.reservationCheck as { compared: number; onlySuperhote: number; onlyPriceLabs: number; amountDiffs: number; items?: ReservationGap[] } | undefined;
  const items = rc?.items ?? [];
  const total = rc ? rc.onlySuperhote + rc.onlyPriceLabs + rc.amountDiffs : 0;
  return (
    <Page title="Écarts de réservations" sub={p.name} crumbs={[{ label: "Logements", href: "/logements" }, { label: p.name, href: `/logements/${p.id}` }, { label: "Écarts de réservations" }]}>
      <p style={{ margin: "0 0 16px" }}><Link className="btn btn-ghost btn-sm" href={`/logements/${p.id}?tab=superhote`}><Icon name="back" />Retour à SuperHote</Link></p>
      <div className="page-head">
        <h1>Réservations : SuperHote face à PriceLabs</h1>
        <p>SuperHote fait foi pour les réservations ; PriceLabs, alimenté par SuperHote, sert de contrôle. Chaque écart ci-dessous est un candidat à signaler à SuperHote comme défaut de synchronisation.</p>
      </div>
      {!rc ? <Banner role="tech" title="Pas encore de comparaison">Elle est faite à la prochaine lecture, quand SuperHote et PriceLabs sont tous deux rattachés au logement.</Banner>
        : total === 0 ? <Banner role="sain" title="Aucun écart">{rc.compared} réservations comparées, toutes concordantes.</Banner>
        : <>
          <p><State role="attention">{total} écart{total > 1 ? "s" : ""}</State> sur {rc.compared} réservations comparées : {rc.amountDiffs} montant{rc.amountDiffs > 1 ? "s" : ""} différent{rc.amountDiffs > 1 ? "s" : ""}, {rc.onlySuperhote} absente{rc.onlySuperhote > 1 ? "s" : ""} de PriceLabs, {rc.onlyPriceLabs} absente{rc.onlyPriceLabs > 1 ? "s" : ""} de SuperHote.</p>
          <div className="table-wrap"><table className="econ">
            <thead><tr><th scope="col">Écart</th><th scope="col">Séjour</th><th scope="col">Canal</th><th scope="col" className="num">SuperHote</th><th scope="col" className="num">PriceLabs</th></tr></thead>
            <tbody>{items.map((g) => (
              <tr key={`${g.kind}-${g.id}`}>
                <td>{KIND[g.kind]}</td><td>{g.checkIn ? fmtDate(g.checkIn) : "—"} → {g.checkOut ? fmtDate(g.checkOut) : "—"}<br /><small>réf. {g.id}</small></td><td>{g.channel}</td>
                <td className="num">{g.shCents == null ? "—" : euro(g.shCents)}</td><td className="num">{g.plCents == null ? "—" : euro(g.plCents)}</td>
              </tr>))}</tbody>
          </table></div>
          {total > items.length && <p><small>Les {items.length} premiers écarts sont affichés sur {total}.</small></p>}
        </>}
    </Page>
  );
}
