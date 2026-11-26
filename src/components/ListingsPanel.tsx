import { deleteListingAction, saveListingAction, setListingStatusAction } from "@/app/actions/portfolio";
import { LISTING_CHANNELS, LISTING_CHANNEL_LABEL, type ListingChannel } from "@/lib/portfolio";
import { ActionForm, Submit } from "./forms";
import { State } from "./ui";

type L = { id: string; channel: string; externalId: string | null; url: string | null; title: string | null; status: string };
const HELP: Record<ListingChannel, string> = {
  AIRBNB: "Airbnb : l'identifiant est le nombre après /rooms/ dans l'adresse de l'annonce.",
  BOOKING: "Booking.com : l'identifiant de l'établissement est visible dans l'extranet.",
  DIRECT: "Réservation directe : un identifiant interne de votre choix (facultatif).",
};

function ListingFields({ l, prefix, channelFixed }: { l?: L; prefix: string; channelFixed?: boolean }) {
  return (
    <div className="form-grid">
      {channelFixed ? <input type="hidden" name="channel" value={l!.channel} /> : (
        <div className="field"><label htmlFor={prefix + "-channel"}>Canal<span className="req" aria-hidden="true">*</span></label>
          <select id={prefix + "-channel"} name="channel" defaultValue="AIRBNB" required>{LISTING_CHANNELS.map((c) => <option key={c} value={c}>{LISTING_CHANNEL_LABEL[c]}</option>)}</select></div>
      )}
      <div className="field"><label htmlFor={prefix + "-externalId"}>Identifiant sur le canal</label><input id={prefix + "-externalId"} name="externalId" type="text" inputMode="text" maxLength={64} defaultValue={l?.externalId ?? ""} placeholder="inconnu si vide" autoComplete="off" /></div>
      <div className="field" style={{ gridColumn: "1 / -1" }}><label htmlFor={prefix + "-url"}>Adresse de l'annonce</label><input id={prefix + "-url"} name="url" type="url" maxLength={300} defaultValue={l?.url ?? ""} placeholder="https://… (facultatif)" autoComplete="off" />
        <span className="help">{(l && HELP[l.channel as ListingChannel]) ?? "Pour Airbnb, l'identifiant est déduit de l'adresse s'il n'est pas saisi."}</span></div>
      <div className="field" style={{ gridColumn: "1 / -1" }}><label htmlFor={prefix + "-title"}>Titre</label><input id={prefix + "-title"} name="title" type="text" maxLength={120} defaultValue={l?.title ?? ""} placeholder="facultatif" autoComplete="off" /></div>
    </div>
  );
}

/** Annonces d'un logement (US-020) : une par canal actif, ajout, modification, archivage et suppression. */
export function ListingsPanel({ propertyId, listings, editable }: { propertyId: string; listings: L[]; editable: boolean }) {
  return (
    <section>
      <h2>Annonces du logement</h2>
      <p className="section-note">Une annonce par canal : c'est elle que les agents et les rattachements désignent. Un identifiant ne peut désigner qu'un seul de vos logements. Les identifiants inconnus restent vides, jamais inventés.</p>
      {listings.length === 0 ? <div className="empty"><h3>Aucune annonce enregistrée</h3><p>Ajoutez l'annonce Airbnb, Booking.com ou directe de ce logement.</p></div> : (
        <div className="stack" data-testid="listings-list">
          {listings.map((l) => (
            <details className="fold" key={l.id} data-testid="listing-card">
              <summary>
                <span>{LISTING_CHANNEL_LABEL[l.channel as ListingChannel] ?? l.channel}</span>
                <span className="muted">{l.title ?? (l.externalId ? "n° " + l.externalId : "identifiant inconnu")}</span>
                <span style={{ marginLeft: "auto" }}>{l.status === "ACTIVE" ? <State role="sain">active</State> : <State role="neutre">archivée</State>}</span>
              </summary>
              <div className="fold-body">
                {l.url && <p style={{ margin: "0 0 12px" }}><a href={l.url} target="_blank" rel="noopener noreferrer">Ouvrir l'annonce sur le canal</a></p>}
                {editable ? (
                  <>
                    <ActionForm need="property.manage" action={saveListingAction} hidden={{ propertyId, listingId: l.id }}>
                      <ListingFields l={l} prefix={"l-" + l.id} channelFixed />
                      <div className="row-wrap" style={{ marginTop: 16 }}><Submit icon="check" pendingLabel="Enregistrement…">Enregistrer</Submit></div>
                    </ActionForm>
                    <div className="row-wrap" style={{ marginTop: 14 }}>
                      <ActionForm need="property.manage" action={setListingStatusAction} hidden={{ propertyId, listingId: l.id, status: l.status === "ACTIVE" ? "ARCHIVED" : "ACTIVE" }}>
                        <Submit className="btn btn-ghost btn-sm" pendingLabel="…">{l.status === "ACTIVE" ? "Archiver" : "Rétablir"}</Submit>
                      </ActionForm>
                      <ActionForm need="property.manage" action={deleteListingAction} hidden={{ propertyId, listingId: l.id }}><Submit className="btn btn-danger btn-sm" icon="cross" pendingLabel="Suppression…">Supprimer</Submit></ActionForm>
                    </div>
                  </>
                ) : <p className="muted">Ce logement est une démonstration : ses annonces ne se modifient pas.</p>}
              </div>
            </details>
          ))}
        </div>
      )}
      {editable && (
        <div style={{ marginTop: 24 }}>
          <h3 style={{ margin: "0 0 10px", fontSize: 16 }}>Ajouter une annonce</h3>
          <ActionForm need="property.manage" action={saveListingAction} hidden={{ propertyId }} resetOnOk>
            <ListingFields prefix="new-listing" />
            <div className="row-wrap" style={{ marginTop: 16 }}><Submit icon="plus" pendingLabel="Ajout…">Ajouter l'annonce</Submit></div>
          </ActionForm>
        </div>
      )}
    </section>
  );
}
