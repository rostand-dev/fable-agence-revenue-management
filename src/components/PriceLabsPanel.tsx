import { channelOverridesAction, connectPriceLabsAction, detachListingAction, disconnectPriceLabsAction, selectListingAction, syncPriceLabsAction } from "@/app/actions/pricelabs";
import { fmtDate, fmtDateTime, fmtDay } from "@/lib/dates";
import { euro } from "@/lib/format";
import { ActionForm, Submit } from "./forms";
import { PriceLabsGuide } from "./PriceLabsGuide";
import { Banner, Recap, State, Vq } from "./ui";

/** Connexion PriceLabs d'un logement : saisie de la clé, choix de l'annonce, état de la dernière lecture. */
export type NoChannel = { externalId: string; checkIn: string; checkOut: string; nights: number; grossRoomCents: number; commissionCents: number | null; choice: string };

export function PriceLabsPanel({ propertyId, propertyName, propertyCity, isDemo, pl, error, taken, noChannel = [] }: { propertyId: string; propertyName: string; propertyCity: string; isDemo: boolean; pl: Record<string, any> | null; error?: string; taken: Record<string, string>; noChannel?: NoChannel[] }) {
  if (isDemo) return <Banner role="tech" title="Logement de démonstration">Ses données sont simulées : il ne se connecte pas à PriceLabs. Ajoutez votre propre logement pour brancher votre clé.</Banner>;
  const ls = pl?.lastSync, cands: any[] = pl?.candidates ?? [];
  return (
    <section className="stack">
      {error && <Banner role="attention" title="La connexion à PriceLabs a échoué">{error} Le dossier du logement est créé ; vous pouvez ressaisir la clé ci-dessous.</Banner>}
      {!pl?.apiKeyEnc ? (
        <>
          <Banner role="tech" title="PriceLabs n'est pas connecté à ce logement">Sans clé, l'équipe ne peut lire ni la grille de prix, ni le marché, ni les réservations : aucune revue n'est faite.</Banner>
          <ActionForm action={connectPriceLabsAction} hidden={{ propertyId }}>
            <div className="field" style={{ marginBottom: 12, maxWidth: 560 }}>
              <label htmlFor="apiKey">Clé API PriceLabs <span className="req" aria-hidden="true">*</span></label>
              <input id="apiKey" name="apiKey" type="password" autoComplete="off" spellCheck={false} required minLength={20} aria-describedby="apiKey-h" />
              <span className="help" id="apiKey-h">Vérifiée auprès de PriceLabs, puis chiffrée. Jamais réaffichée en entier.</span>
            </div>
            <Submit icon="plug" pendingLabel="Vérification et première lecture…">Vérifier et connecter</Submit>
          </ActionForm>
          <PriceLabsGuide open />
        </>
      ) : (
        <>
          <Recap rows={[
            ["Clé API", <span key="k">{pl.keyHint} · chiffrée</span>, true],
            ["Annonce rattachée", pl.listingId ? `${pl.listingName ?? pl.listingId} · ${pl.pms} · identifiant ${pl.listingId}` : <Vq>à confirmer</Vq>],
            ["Dernière lecture", ls?.at ? <>{fmtDateTime(new Date(ls.at))} · {ls.ok ? <State role="sain">réussie</State> : <State role="attention">en échec</State>}</> : <Vq>aucune</Vq>],
            ...(ls?.ok ? [
              ["Grille de prix", `${ls.days} jours${ls.unknownPrices ? ` · ${ls.unknownPrices} prix inconnus` : ""}${ls.gridRefreshedAt ? ` · calculée par PriceLabs le ${fmtDateTime(new Date(ls.gridRefreshedAt))}` : ""}`],
              ["Réservations", `${ls.reservations} confirmées · ${ls.cancelled} annulées ou remplacées · ${ls.ownerBlocks} blocage${ls.ownerBlocks > 1 ? "s" : ""} propriétaire${ls.historyFrom ? ` · historique depuis le ${fmtDate(ls.historyFrom)}` : ""}`],
              ...(ls.duplicates ? [["Écartées du calcul", `${ls.duplicates} réservation${ls.duplicates > 1 ? "s" : ""} : chevauchement d'une autre réservation confirmée sur les mêmes nuits (reliquat du PMS), ou choix de votre part ci-dessous`] as [string, React.ReactNode]] : []),
              ["Commissions", ls.unknownCommissions
                ? <Vq key="c">{ls.unknownCommissions} inconnue{ls.unknownCommissions > 1 ? "s" : ""} : {ls.undeclaredRates?.length ? `taux non déclaré pour ${ls.undeclaredRates.join(", ")} — complétez le dossier du logement` : "réservations sans canal identifié, leur revenu net est partiel"}</Vq>
                : ls.estimatedCommissions ? `${ls.estimatedCommissions} estimées au taux déclaré (le PMS ne les fournit pas)` : "fournies par le PMS"],
              ...(ls.unknownCommissions && ls.estimatedCommissions ? [["Commissions estimées", `${ls.estimatedCommissions} au taux déclaré (le PMS ne les fournit pas)`] as [string, React.ReactNode]] : []),
              ["Marché", ls.marketError ? <Vq key="m" kind="obsolete">indisponible — {ls.marketError}</Vq> : `${ls.marketDays} jours · ${ls.marketListings ?? "?"} annonces comparables · catégorie ${ls.marketCategory === "-1" ? "chambre" : ls.marketCategory + " chambre(s)"} · ${ls.marketSource ?? ""}`],
            ] as [string, React.ReactNode][] : []),
          ]} />
          {ls && !ls.ok && <Banner role="attention" title="Dernière lecture en échec">{ls.error} Les données précédentes sont conservées.</Banner>}
          {ls?.ok && ls.pushEnabled === false && <Banner role="attention" title="Synchronisation désactivée dans PriceLabs">Les prix lus ne sont peut-être pas ceux réellement publiés sur vos canaux.</Banner>}
          {!pl.listingId && (() => {
            const free = cands.filter((c) => !taken[`${c.id}|${c.pms}`]);
            const desc = (c: any) => `${c.name}${c.city ? " — " + c.city : ""}${c.bedrooms !== null && c.bedrooms !== undefined ? ` — ${c.bedrooms} chambre${c.bedrooms > 1 ? "s" : ""}` : ""} (${c.pms})`;
            return (
              <>
                <Banner role="attention" title="Rattachement à confirmer">
                  Le lien se fait sur votre confirmation, pas sur le nom : vérifiez que l'annonce PriceLabs est bien celle de <strong>{propertyName}</strong> ({propertyCity}). Rien n'est lu tant que vous n'avez pas confirmé.
                </Banner>
                {cands.filter((c) => taken[`${c.id}|${c.pms}`]).map((c) => <p key={c.id} className="muted" style={{ margin: 0 }}>« {c.name} » est déjà rattachée à votre logement « {taken[`${c.id}|${c.pms}`]} » : elle n'est pas proposée.</p>)}
                {free.length === 0 ? (
                  <Banner role="tech" title="Aucune annonce disponible sur ce compte">Toutes les annonces de ce compte PriceLabs sont déjà rattachées à vos autres logements. Ajoutez d'abord ce logement dans PriceLabs, ou utilisez la clé du compte qui le contient.</Banner>
                ) : free.length === 1 ? (
                  <ActionForm action={selectListingAction} hidden={{ propertyId, listingId: free[0].id }}>
                    <Recap rows={[["Annonce PriceLabs", free[0].name], ["Ville", free[0].city ?? <Vq key="v">inconnue</Vq>], ["Chambres", free[0].bedrooms ?? <Vq key="b">inconnu</Vq>], ["PMS", free[0].pms], ["Identifiant", free[0].id, true]]} />
                    <div style={{ marginTop: 14 }}><Submit icon="check" pendingLabel="Première lecture…">Oui, c'est bien ce logement : rattacher</Submit></div>
                  </ActionForm>
                ) : (
                  <ActionForm action={selectListingAction} hidden={{ propertyId }}>
                    <div className="field" style={{ marginBottom: 12, maxWidth: 560 }}>
                      <label htmlFor="listingId">Quelle annonce PriceLabs correspond à ce logement ? <span className="req" aria-hidden="true">*</span></label>
                      <select id="listingId" name="listingId" required defaultValue="">
                        <option value="" disabled>Choisir une annonce</option>
                        {free.map((c) => <option key={c.id} value={c.id}>{desc(c)}</option>)}
                      </select>
                    </div>
                    <Submit icon="check" pendingLabel="Première lecture…">Rattacher cette annonce</Submit>
                  </ActionForm>
                )}
              </>
            );
          })()}
          {pl.listingId && noChannel.length > 0 && (
            <section>
              <h2 style={{ fontSize: 17, margin: "8px 0 2px" }}>Réservations transmises sans canal</h2>
              <p className="section-note" style={{ margin: "0 0 10px" }}>Votre PMS a transmis ces réservations sans indiquer leur plateforme. Précisez-la si vous la connaissez : votre choix est mémorisé et réappliqué à chaque lecture. Sans précision, elles restent « canal non identifié ».</p>
              <ActionForm action={channelOverridesAction} hidden={{ propertyId }}>
                <div className="table-wrap"><table className="econ">
                  <thead><tr><th scope="col">Séjour</th><th scope="col" className="num">Nuits</th><th scope="col" className="num">Montant</th><th scope="col" className="num">Commission retenue</th><th scope="col">Canal</th></tr></thead>
                  <tbody>{noChannel.map((r) => (
                    <tr key={r.externalId}>
                      <th scope="row">{fmtDay(r.checkIn)} → {fmtDate(r.checkOut)}<span className="src">réservation {r.externalId}</span></th>
                      <td className="num">{r.nights}</td><td className="num">{euro(r.grossRoomCents)}</td>
                      <td className="num">{r.commissionCents === null ? "inconnue" : euro(r.commissionCents)}</td>
                      <td><label className="visually-hidden" htmlFor={"canal-" + r.externalId}>Canal de la réservation {r.externalId}</label>
                        <select id={"canal-" + r.externalId} name={"canal-" + r.externalId} defaultValue={r.choice} style={{ minHeight: 40, padding: "0 10px", borderRadius: 8, border: "1px solid var(--line-strong)", background: "rgb(4 5 10 / 60%)", color: "var(--ink)", font: "inherit", fontSize: 14 }}>
                          <option value="">Non identifié</option><option value="AIRBNB">Airbnb</option><option value="BOOKING">Booking.com</option><option value="DIRECT">Réservation directe</option><option value="EXCLUDE">Écarter du calcul</option>
                        </select></td>
                    </tr>
                  ))}</tbody></table></div>
                <div style={{ marginTop: 12 }}><Submit className="btn btn-ghost" icon="check" pendingLabel="Enregistrement et relecture…">Enregistrer ces canaux</Submit></div>
              </ActionForm>
            </section>
          )}
          <div className="row-wrap">
            {pl.listingId && <ActionForm action={syncPriceLabsAction} hidden={{ propertyId }} className="inline"><Submit icon="spin" pendingLabel="Lecture en cours…">Relire PriceLabs maintenant</Submit></ActionForm>}
            {pl.listingId && <ActionForm action={detachListingAction} hidden={{ propertyId }} className="inline"><Submit className="btn btn-ghost btn-sm" icon="undo">Changer d'annonce</Submit></ActionForm>}
            <ActionForm action={disconnectPriceLabsAction} hidden={{ propertyId }} className="inline"><Submit className="btn btn-danger btn-sm" icon="cross">Supprimer la clé</Submit></ActionForm>
          </div>
          <p className="muted" style={{ margin: 0 }}>Lecture seule. PriceLabs est relu avant chaque revue quotidienne ; ses prix sont recalculés par PriceLabs toutes les 24 heures.</p>
          <PriceLabsGuide />
        </>
      )}
    </section>
  );
}
