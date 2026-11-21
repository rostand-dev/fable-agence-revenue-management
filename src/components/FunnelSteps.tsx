import Link from "next/link";
import { funnelSelectListingAction, funnelSelectRentalAction, launchAction, saveLogementAction, saveReglesAction, stepAction } from "@/app/actions/onboarding";
import { connectPriceLabsAction, detachListingAction, disconnectPriceLabsAction } from "@/app/actions/pricelabs";
import { connectSuperhoteAction, detachRentalAction, disconnectSuperhoteAction } from "@/app/actions/superhote";
import { fmtDate } from "@/lib/dates";
import { stepLabel, type StepKey } from "@/lib/onboarding";
import type { ChannelMarkup } from "@/lib/pricing/published";
import { ActionForm, Submit } from "./forms";
import { Say } from "./Funnel";
import { Icon } from "./Icon";
import { MarkupsEditor } from "./MarkupsEditor";
import { OwnerSelect } from "./OwnerSelect";
import { PriceLabsGuide } from "./PriceLabsGuide";
import { SuperhoteGuide } from "./SuperhoteGuide";
import { Banner, Recap, Vq } from "./ui";

/* Écrans du parcours de création. Chaque formulaire d'étape porte l'identifiant `funnel-form`, que soumet le bouton « Enregistrer et quitter » de l'en-tête. */

export const stepHref = (id: string, k: string) => `/logements/${id}/creation?etape=${k}`;

function Foot({ back, children, note }: { back?: string | null; children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="fn-foot">
      {back && <Link href={back} className="btn btn-ghost"><Icon name="back" />Retour</Link>}
      {note && <span className="fn-note">{note}</span>}
      <span className="fn-sp" />
      {children}
    </div>
  );
}

function Fld({ name, label, value, req, help, full, numeric }: { name: string; label: string; value?: string; req?: boolean; help?: string; full?: boolean; numeric?: boolean }) {
  return (
    <div className="field" style={full ? { gridColumn: "1 / -1" } : undefined}>
      <label htmlFor={name}>{label}{req && <span className="req" aria-hidden="true">*</span>}</label>
      <input id={name} name={name} type="text" inputMode={numeric ? "decimal" : undefined} required={req} defaultValue={value ?? ""} placeholder={req ? undefined : "inconnu si vide"} aria-describedby={help ? name + "-h" : undefined} />
      {help && <span className="help" id={name + "-h"}>{help}</span>}
    </div>
  );
}
const n = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v).replace(".", ","));

/** Étape 1. Sans `p`, le dossier n'existe pas encore : il est créé au premier enregistrement. */
export function LogementStep({ p, owners = [], ownerId }: { p?: { id: string; name: string; city: string; kind: string; bedrooms: number | null; capacity: number | null; positioning?: string; objective?: string }; owners?: { id: string; name: string; isDefault: boolean }[]; ownerId?: string | null }) {
  return (
    <>
      <div className="fn-head"><h1>Parlez-nous du logement</h1><p>Nom, ville et type suffisent pour continuer. Le reste peut rester « inconnu » : rien n'est jamais remplacé par zéro.</p></div>
      <ActionForm action={saveLogementAction} id="funnel-form" hidden={p ? { propertyId: p.id } : undefined}>
        {/* bouton par défaut : la touche Entrée vaut toujours « Continuer » */}
        <button type="submit" name="intent" value="next" className="sr-only" tabIndex={-1} aria-hidden="true">Continuer</button>
        <div className="fn-card">
          <div className="form-grid">
            <OwnerSelect owners={owners} value={ownerId} />
            <Fld name="name" label="Nom du logement" value={p && p.name !== "Logement sans nom" ? p.name : ""} req />
            <Fld name="city" label="Ville" value={p?.city} req />
            <Fld name="kind" label="Type (T2, T3, maison…)" value={p?.kind} req />
            <Fld name="bedrooms" label="Chambres" value={n(p?.bedrooms)} numeric />
            <Fld name="capacity" label="Voyageurs maximum" value={n(p?.capacity)} numeric />
            <Fld name="positioning" label="Clientèle visée" value={p?.positioning} full help="Par exemple : professionnels en semaine, familles le week-end." />
            <Fld name="objective" label="Votre objectif" value={p?.objective} full help="Par exemple : +20 % de chiffre d'affaires sur un an, sans sacrifier le prix à la nuit." />
          </div>
        </div>
        <Foot note={p ? undefined : "Le dossier est créé et enregistré dès que vous continuez."}>
          <Submit icon="arrow" name="intent" value="next" pendingLabel="Enregistrement…">Continuer</Submit>
        </Foot>
      </ActionForm>
    </>
  );
}

type Cand = { id: string; label: string; detail: string; taken?: string };
/** Étapes 2 et 3 : saisie de la clé, confirmation du rattachement, puis passage à l'étape suivante, sans quitter le parcours. */
export function ConnectStep({ kind, propertyId, propertyName, propertyCity, conn, cands, ines, plMissingNote }: {
  kind: "superhote" | "pricelabs"; propertyId: string; propertyName: string; propertyCity: string;
  conn: Record<string, any> | null; cands: Cand[]; ines: string; plMissingNote?: boolean;
}) {
  const sh = kind === "superhote";
  const name = sh ? "SuperHote" : "PriceLabs", keyName = sh ? "jeton" : "clé";
  const linked = sh ? conn?.rentalId : conn?.listingId;
  const linkedName = sh ? conn?.rentalName : conn?.listingName;
  const free = cands.filter((c) => !c.taken);
  const ls = conn?.lastSync;
  const select = sh ? funnelSelectRentalAction : funnelSelectListingAction, field = sh ? "rentalId" : "listingId";
  return (
    <>
      <div className="fn-head">
        <h1>Connectez {name}</h1>
        <p>{sh ? "SuperHote fait foi pour vos réservations, leur canal et les montants facturés. Lecture seule : NuitSignal ne modifie rien chez SuperHote." : "PriceLabs reste votre moteur de prix : NuitSignal y lit la grille de prix recommandés et le marché local. Lecture seule."}</p>
      </div>
      {!sh && plMissingNote && <Say name={ines}>PriceLabs est indispensable pour lancer l'observation : sans calendrier de prix, l'équipe ne peut faire aucune revue. Vous pouvez le reporter, mais je vous le redemanderai à la vérification.</Say>}

      {!conn?.apiKeyEnc ? (
        <div className="fn-card">
          <ActionForm action={sh ? connectSuperhoteAction : connectPriceLabsAction} hidden={{ propertyId }}>
            <div className="field" style={{ marginBottom: 14, maxWidth: 560 }}>
              <label htmlFor="apiKey">{sh ? "Jeton API SuperHote" : "Clé API PriceLabs"}<span className="req" aria-hidden="true">*</span></label>
              <input id="apiKey" name="apiKey" type="password" autoComplete="off" spellCheck={false} required minLength={sh ? undefined : 20} placeholder={`collez ${sh ? "le jeton" : "la clé"} ici`} aria-describedby="apiKey-h" />
              <span className="help" id="apiKey-h">{sh ? "Vérifié" : "Vérifiée"} auprès de {name}, puis {sh ? "chiffré" : "chiffrée"}. Jamais {sh ? "réaffiché" : "réaffichée"} en entier.</span>
            </div>
            <Submit icon="plug" pendingLabel="Vérification…">Vérifier {sh ? "le jeton" : "la clé"}</Submit>
          </ActionForm>
          <div style={{ marginTop: 16 }}>{sh ? <SuperhoteGuide /> : <PriceLabsGuide />}</div>
        </div>
      ) : linked ? (
        <div className="fn-card">
          <Banner role="sain" title={`${name} connecté`} style={{ marginBottom: 14 }}>{sh ? "Logement" : "Annonce"} rattaché{sh ? "" : "e"} : <strong>{linkedName ?? linked}</strong>.</Banner>
          <Recap rows={[
            [sh ? "Jeton" : "Clé", <span key="k">{conn.keyHint} · {sh ? "chiffré" : "chiffrée"}</span>, true],
            [sh ? "Logement SuperHote" : "Annonce PriceLabs", `${linkedName ?? linked} · identifiant ${linked}`],
            ["Première lecture", ls?.at ? (ls.ok ? (sh ? `${ls.reservations ?? "?"} réservations lues` : `${ls.days ?? "?"} jours de grille, ${ls.reservations ?? "?"} réservations${ls.historyFrom ? ` depuis le ${fmtDate(ls.historyFrom)}` : ""}`) : <Vq key="e" kind="obsolete">en échec — {ls.error}</Vq>) : <Vq key="n">pas encore faite</Vq>],
          ]} />
          <div className="row-wrap" style={{ marginTop: 12 }}>
            <ActionForm action={sh ? detachRentalAction : detachListingAction} hidden={{ propertyId }} className="inline"><Submit className="btn btn-ghost btn-sm" icon="undo">Changer de {sh ? "logement" : "annonce"}</Submit></ActionForm>
          </div>
        </div>
      ) : (
        <div className="fn-card">
          <Banner role="sain" title={`${keyName === "jeton" ? "Jeton valide" : "Clé valide"} · ${cands.length} ${sh ? "logement" : "annonce"}${cands.length > 1 ? "s" : ""} sur ce compte`} style={{ marginBottom: 16 }}>
            Enregistré{sh ? "" : "e"} et chiffré{sh ? "" : "e"} : <span className="mono">{conn.keyHint}</span>.
          </Banner>
          <h2 className="fn-h2">{sh ? "Quel logement SuperHote" : "Quelle annonce PriceLabs"} correspond à « {propertyName} »{propertyCity ? ` (${propertyCity})` : ""} ?</h2>
          <p className="help" style={{ margin: "0 0 14px" }}>Le lien se fait sur votre confirmation, jamais sur le nom. Rien n'est lu tant que vous n'avez pas confirmé.</p>
          {free.length === 0 ? (
            <Banner role="tech" title={`Aucun${sh ? "" : "e"} ${sh ? "logement" : "annonce"} disponible sur ce compte`}>Tou{sh ? "s" : "tes"} {sh ? "les logements" : "les annonces"} de ce compte {sh ? "sont déjà rattachés" : "sont déjà rattachées"} à vos autres logements. Utilisez {sh ? "le jeton" : "la clé"} du compte qui contient celui-ci, ou reportez cette étape.</Banner>
          ) : (
            <ActionForm action={select} hidden={{ propertyId }}>
              <div className="options" role="radiogroup" aria-label={sh ? "Logements SuperHote" : "Annonces PriceLabs"}>
                {free.map((c, i) => (
                  <label key={c.id} className="option fn-opt">
                    <input type="radio" name={field} value={c.id} required defaultChecked={free.length === 1 && i === 0} />
                    <span><strong>{c.label}</strong><br /><span className="muted">{c.detail}</span></span>
                  </label>
                ))}
              </div>
              <div className="row-wrap" style={{ marginTop: 16 }}>
                <Submit icon="check" pendingLabel="Première lecture…">Oui, c'est bien ce logement : confirmer et continuer</Submit>
              </div>
            </ActionForm>
          )}
          {cands.filter((c) => c.taken).map((c) => <p key={c.id} className="muted" style={{ margin: "10px 0 0", fontSize: 13.5 }}>« {c.label} » est déjà rattaché{sh ? "" : "e"} à votre logement « {c.taken} » : {sh ? "il n'est" : "elle n'est"} pas proposé{sh ? "" : "e"}.</p>)}
          <div className="row-wrap" style={{ marginTop: 14 }}>
            <ActionForm action={sh ? disconnectSuperhoteAction : disconnectPriceLabsAction} hidden={{ propertyId }} className="inline"><Submit className="btn btn-ghost btn-sm" icon="undo">Changer de {keyName}</Submit></ActionForm>
          </div>
        </div>
      )}

      <ActionForm action={stepAction} id="funnel-form" hidden={{ propertyId, step: kind }}>
        <Foot back={stepHref(propertyId, sh ? "logement" : "superhote")}>
          {!linked && <Submit className="btn btn-ghost" name="intent" value="skip" icon="clock" pendingLabel="Enregistrement…">Je le ferai plus tard</Submit>}
          {linked ? <Submit icon="arrow" name="intent" value="next" pendingLabel="Enregistrement…">Continuer</Submit> : <button type="button" className="btn btn-primary" disabled aria-disabled="true" title={`Confirmez d'abord ${sh ? "le logement" : "l'annonce"}, ou reportez cette étape`}><Icon name="arrow" />Continuer</button>}
        </Foot>
      </ActionForm>
    </>
  );
}

/** Étape 4 : séjour minimum et majorations par canal. */
export function ReglesStep({ propertyId, minStay, markups, seenNote }: { propertyId: string; minStay: number | null; markups: ChannelMarkup[]; seenNote?: string }) {
  return (
    <>
      <div className="fn-head"><h1>Vos règles de vente</h1><p>La durée minimale d'un séjour, et ce que SuperHote ajoute au prix PriceLabs sur chaque canal.</p></div>
      <ActionForm action={saveReglesAction} id="funnel-form" hidden={{ propertyId }}>
        {/* bouton par défaut : la touche Entrée vaut toujours « Continuer » */}
        <button type="submit" name="intent" value="next" className="sr-only" tabIndex={-1} aria-hidden="true">Continuer</button>
        <div className="fn-card">
          <h2 className="fn-h2">Séjour minimum</h2>
          <p className="help" style={{ margin: "0 0 12px" }}>Les prix de base, minimum et maximum sont lus directement dans PriceLabs.</p>
          <div style={{ maxWidth: 280 }}><Fld name="minStay" label="Séjour minimum habituel (nuits)" value={n(minStay)} numeric /></div>
        </div>
        <div className="fn-card">
          <h2 className="fn-h2">Majorations SuperHote par canal</h2>
          <p className="help" style={{ margin: "0 0 14px" }}>Prix publié estimé = prix recommandé PriceLabs × (1 + majoration). SuperHote ne transmet pas ces pourcentages : reprenez ceux de votre paramétrage. Un canal sans pourcentage reste « inconnu », jamais 0 %.{seenNote ? ` ${seenNote}` : ""}</p>
          <MarkupsEditor initial={markups} />
        </div>
        <Foot back={stepHref(propertyId, "pricelabs")}>
          <Submit icon="arrow" name="intent" value="next" pendingLabel="Enregistrement…">Continuer</Submit>
        </Foot>
      </ActionForm>
    </>
  );
}

type Check = { key: StepKey; ok: boolean; warn?: boolean; summary: React.ReactNode };
/** Étape 6 : récapitulatif, chaque ligne renvoie à son étape ; lancement bloqué sans PriceLabs. */
export function VerificationStep({ propertyId, checks, blockers, ines, shMissing }: { propertyId: string; checks: Check[]; blockers: StepKey[]; ines: string; shMissing: boolean }) {
  return (
    <>
      <div className="fn-head"><h1>Tout est prêt ?</h1><p>Vérifiez le dossier avant de lancer l'observation par l'équipe. Chaque ligne renvoie à son étape.</p></div>
      {blockers.length > 0
        ? <Say name={ines}>Il me manque encore {blockers.map((b) => stepLabel(b)).join(" et ")} pour lancer l'observation.{blockers.includes("pricelabs") && " PriceLabs est indispensable : sans calendrier de prix, aucune revue n'est possible."}</Say>
        : shMissing
          ? <Say name={ines}>Tout est prêt, sauf SuperHote : en attendant, vos réservations sont lues via PriceLabs, moins fiable. Vous pouvez lancer maintenant et le connecter ensuite depuis la fiche du logement.</Say>
          : <Say name={ines}>Le dossier est complet. Au lancement, l'équipe lit vos données et vous propose ses premières situations.</Say>}
      <ul className="fn-check">
        {checks.map((c) => (
          <li key={c.key}>
            <span className={`fn-ic ${c.ok ? "is-ok" : c.warn ? "is-warn" : "is-block"}`} aria-hidden="true"><Icon name={c.ok ? "check" : c.warn ? "clock" : "alert"} /></span>
            <div className="fn-grow"><p className="fn-t">{stepLabel(c.key)} <span className="sr-only">: {c.ok ? "complet" : c.warn ? "à faire plus tard" : "bloquant"}</span></p><p className="fn-s">{c.summary}</p></div>
            <Link className="btn btn-ghost btn-sm" href={stepHref(propertyId, c.key)}>{c.ok ? "Modifier" : c.key === "superhote" || c.key === "pricelabs" ? "Connecter" : "Compléter"}</Link>
          </li>
        ))}
      </ul>
      <Banner role="tech" title="Ce qui se passe au lancement" style={{ marginTop: 18 }}>Le logement passe en Observation : l'équipe lit vos données et propose des situations, sans rien appliquer sans votre accord.</Banner>
      <ActionForm action={launchAction} id="funnel-form" hidden={{ propertyId }}>
        <Foot back={stepHref(propertyId, "couts")} note={blockers.length ? `À compléter avant le lancement : ${blockers.map((b) => stepLabel(b)).join(", ")}.` : undefined}>
          {blockers.length
            ? <button type="button" className="btn btn-primary" disabled aria-disabled="true"><Icon name="check" />Lancer l'observation</button>
            : <Submit icon="check" name="intent" value="launch" pendingLabel="Lancement et première revue…">Lancer l'observation</Submit>}
        </Foot>
      </ActionForm>
    </>
  );
}
