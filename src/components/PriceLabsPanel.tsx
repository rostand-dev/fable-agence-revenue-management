import { connectPriceLabsAction, disconnectPriceLabsAction, selectListingAction, syncPriceLabsAction } from "@/app/actions/pricelabs";
import { fmtDateTime } from "@/lib/dates";
import { ActionForm, Submit } from "./forms";
import { PriceLabsGuide } from "./PriceLabsGuide";
import { Banner, Recap, State, Vq } from "./ui";

/** Connexion PriceLabs d'un logement : saisie de la clé, choix de l'annonce, état de la dernière lecture. */
export function PriceLabsPanel({ propertyId, isDemo, pl, error }: { propertyId: string; isDemo: boolean; pl: Record<string, any> | null; error?: string }) {
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
            ["Annonce rattachée", pl.listingId ? `${pl.listingName ?? pl.listingId} · ${pl.pms}` : <Vq>à choisir</Vq>],
            ["Dernière lecture", ls?.at ? <>{fmtDateTime(new Date(ls.at))} · {ls.ok ? <State role="sain">réussie</State> : <State role="attention">en échec</State>}</> : <Vq>aucune</Vq>],
            ...(ls?.ok ? [
              ["Grille de prix", `${ls.days} jours${ls.unknownPrices ? ` · ${ls.unknownPrices} prix inconnus` : ""}${ls.gridRefreshedAt ? ` · calculée par PriceLabs le ${fmtDateTime(new Date(ls.gridRefreshedAt))}` : ""}`],
              ["Réservations", `${ls.reservations} confirmées · ${ls.cancelled} annulées · ${ls.ownerBlocks} blocage${ls.ownerBlocks > 1 ? "s" : ""} propriétaire`],
              ["Commissions", ls.unknownCommissions ? <Vq key="c">{ls.unknownCommissions} inconnues : renseignez les taux de commission du logement</Vq> : ls.estimatedCommissions ? `${ls.estimatedCommissions} estimées au taux déclaré (le PMS ne les fournit pas)` : "fournies par le PMS"],
              ["Marché", ls.marketError ? <Vq key="m" kind="obsolete">indisponible — {ls.marketError}</Vq> : `${ls.marketDays} jours · ${ls.marketListings ?? "?"} annonces comparables · catégorie ${ls.marketCategory === "-1" ? "chambre" : ls.marketCategory + " chambre(s)"} · ${ls.marketSource ?? ""}`],
            ] as [string, React.ReactNode][] : []),
          ]} />
          {ls && !ls.ok && <Banner role="attention" title="Dernière lecture en échec">{ls.error} Les données précédentes sont conservées.</Banner>}
          {ls?.ok && ls.pushEnabled === false && <Banner role="attention" title="Synchronisation désactivée dans PriceLabs">Les prix lus ne sont peut-être pas ceux réellement publiés sur vos canaux.</Banner>}
          {!pl.listingId && (
            <ActionForm action={selectListingAction} hidden={{ propertyId }}>
              <div className="field" style={{ marginBottom: 12, maxWidth: 560 }}>
                <label htmlFor="listingId">Quelle annonce PriceLabs correspond à ce logement ? <span className="req" aria-hidden="true">*</span></label>
                <select id="listingId" name="listingId" required defaultValue="">
                  <option value="" disabled>Choisir une annonce</option>
                  {cands.map((c) => <option key={c.id} value={c.id}>{c.name}{c.city ? ` — ${c.city}` : ""} ({c.pms})</option>)}
                </select>
              </div>
              <Submit icon="check" pendingLabel="Première lecture…">Rattacher cette annonce</Submit>
            </ActionForm>
          )}
          <div className="row-wrap">
            {pl.listingId && <ActionForm action={syncPriceLabsAction} hidden={{ propertyId }} className="inline"><Submit icon="spin" pendingLabel="Lecture en cours…">Relire PriceLabs maintenant</Submit></ActionForm>}
            <ActionForm action={disconnectPriceLabsAction} hidden={{ propertyId }} className="inline"><Submit className="btn btn-danger btn-sm" icon="cross">Supprimer la clé</Submit></ActionForm>
          </div>
          <p className="muted" style={{ margin: 0 }}>Lecture seule. PriceLabs est relu avant chaque revue quotidienne ; ses prix sont recalculés par PriceLabs toutes les 24 heures.</p>
          <PriceLabsGuide />
        </>
      )}
    </section>
  );
}
