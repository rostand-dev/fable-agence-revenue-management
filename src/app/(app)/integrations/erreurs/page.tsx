import Link from "next/link";
import { replayAllDeliveriesAction, dismissDeliveryAction, replayDeliveryAction } from "@/app/actions/ingestion";
import { ActionForm, Submit } from "@/components/forms";
import { Icon } from "@/components/Icon";
import { Page } from "@/components/Page";
import { Banner, Recap, State } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { fmtDateTime } from "@/lib/dates";
import { listIngestionErrors, type DeliveryRow } from "@/lib/services/ingestion-errors";

export const metadata = { title: "Erreurs d'ingestion" };
export const dynamic = "force-dynamic";
const EVENT: Record<string, string> = { "reservation.created": "Réservation créée", "reservation.updated": "Réservation modifiée", "reservation.canceled": "Réservation annulée" };
const STAGE: Record<DeliveryRow["stage"], [string, "attention" | "tech"]> = { failed: ["En échec", "tech"], abandoned: ["Abandonnée", "attention"], interrupted: ["Traitement interrompu", "attention"] };

/** Écran des échecs d'ingestion SuperHote (US-033) : livraisons de webhook en échec ou abandonnées, lectures planifiées en échec. Rejeu et mise à l'écart. */
export default async function IngestionErrors() {
  const user = await requireUser();
  const e = await listIngestionErrors(user.tenantId);
  const nothing = e.total === 0 && e.readFailures.length === 0;
  return (
    <Page title="Erreurs d'ingestion" sub="Réservations SuperHote" crumbs={[{ label: "Paramètres", href: "/parametres" }, { label: "Intégrations", href: "/integrations" }, { label: "Erreurs d'ingestion" }]}>
      <p style={{ margin: "0 0 16px" }}><Link className="btn btn-ghost btn-sm" href="/integrations"><Icon name="back" />Retour aux intégrations</Link></p>
      <div className="page-head">
        <h1>Réservations SuperHote qui n'ont pas pu être appliquées</h1>
        <p>Chaque livraison de webhook est enregistrée avant d'être traitée. Quand elle échoue, elle apparaît ici avec la raison ; SuperHote réessaie seul tant que le traitement est possible (3 tentatives). Vous pouvez la rejouer (sans risque de doublon) ou l'écarter ; la lecture planifiée de SuperHote rattrape de toute façon les réservations manquantes.</p>
      </div>
      {nothing && <Banner role="sain" title="Aucune erreur d'ingestion">Toutes les livraisons reçues ont été appliquées et les dernières lectures ont réussi.</Banner>}
      {e.readFailures.length > 0 && (
        <section className="stack" data-testid="read-failures" style={{ marginBottom: 20 }}>
          <h2 style={{ margin: 0 }}>Lectures planifiées en échec</h2>
          {e.readFailures.map((r) => (
            <article className="stratum" key={r.propertyId}>
              <header><h3>{r.propertyName}</h3><span style={{ marginLeft: "auto" }}><State role="attention">{r.kind === "READ" ? "Lecture en échec" : "Lecture suspecte"}</State></span></header>
              <div className="stratum-body stack">
                <p style={{ margin: 0 }}>{r.error}</p>
                {r.at && !Number.isNaN(+new Date(r.at)) && <p className="muted" style={{ margin: 0 }}>{fmtDateTime(new Date(r.at))}. Les données précédentes sont conservées ; la lecture est retentée à la prochaine échéance.</p>}
                <div><Link className="btn btn-ghost btn-sm" href={`/logements/${r.propertyId}?tab=superhote`}>Ouvrir l'onglet SuperHote</Link></div>
              </div>
            </article>
          ))}
        </section>
      )}
      {e.total > 0 && (
        <section className="stack" data-testid="deliveries">
          <div className="row-wrap" style={{ alignItems: "center" }}>
            <h2 style={{ margin: 0 }}>Livraisons en échec <span className="muted">({e.total})</span></h2>
            <ActionForm action={replayAllDeliveriesAction} className="inline" style={{ marginLeft: "auto" }}><Submit icon="spin" pendingLabel="Rejeu en cours…">Tout rejouer</Submit></ActionForm>
          </div>
          {e.abandoned > 0 && <Banner role="attention" title={`${e.abandoned} livraison${e.abandoned > 1 ? "s abandonnées" : " abandonnée"}`}>Les tentatives automatiques sont épuisées. Rejouez-les une fois la cause levée, ou écartez-les.</Banner>}
          {e.deliveries.map((d) => {
            const [label, role] = STAGE[d.stage];
            return (
              <article className="stratum" key={d.id} data-testid="delivery">
                <header><h3>{EVENT[d.event] ?? d.event}</h3><span className="metric-source">{d.propertyName ?? "logement non identifié"}</span><span style={{ marginLeft: "auto" }}><State role={role}>{label}</State></span></header>
                <div className="stratum-body stack">
                  <Recap rows={[
                    ["Reçue", fmtDateTime(d.receivedAt)],
                    ["Réservation SuperHote", d.externalId ?? "—"],
                    ["Tentatives", String(d.attempts)],
                    ["Raison", d.error ?? (d.stage === "interrupted" ? "Le traitement s'est arrêté avant la fin (redémarrage du serveur ?)." : "—")],
                  ]} />
                  {!d.replayable && <p className="muted" style={{ margin: 0 }}>Le webhook de cette livraison a été supprimé : elle ne peut plus être rejouée.</p>}
                  <div className="row-wrap">
                    {d.replayable && <ActionForm action={replayDeliveryAction} hidden={{ id: d.id }} className="inline"><Submit icon="spin" pendingLabel="Rejeu…" ariaLabel={`Rejouer la livraison de la réservation ${d.externalId ?? d.deliveryId}`}>Rejouer</Submit></ActionForm>}
                    <ActionForm action={dismissDeliveryAction} hidden={{ id: d.id }} className="inline"><Submit className="btn btn-ghost btn-sm" icon="cross" ariaLabel={`Écarter la livraison de la réservation ${d.externalId ?? d.deliveryId}`}>Écarter</Submit></ActionForm>
                  </div>
                </div>
              </article>
            );
          })}
          {e.total > e.deliveries.length && <p className="muted">Les {e.deliveries.length} plus récentes sont affichées sur {e.total}.</p>}
        </section>
      )}
    </Page>
  );
}
