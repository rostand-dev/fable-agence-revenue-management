import Link from "next/link";
import { connectSuperhoteAction, detachRentalAction, disableWebhookAction, disconnectSuperhoteAction, enableWebhookAction, selectRentalAction, syncSuperhoteAction } from "@/app/actions/superhote";
import type { WebhookStatus } from "@/lib/services/superhote-webhook";
import { fmtDate, fmtDateTime } from "@/lib/dates";
import { euro } from "@/lib/format";
import { ActionForm, Submit } from "./forms";
import { SuperhoteGuide } from "./SuperhoteGuide";
import { Banner, Recap, State, Vq } from "./ui";

/** Connexion SuperHote d'un logement (lecture seule) : jeton, logement rattaché, canaux relevés, comparaison de prix. */
export function SuperhotePanel({ propertyId, propertyName, propertyCity, isDemo, sh, plLinked, taken, error, webhook }: { propertyId: string; propertyName: string; propertyCity: string; isDemo: boolean; sh: Record<string, any> | null; plLinked: boolean; taken: Record<string, string>; error?: string; webhook?: WebhookStatus }) {
  if (isDemo) return <Banner role="tech" title="Logement de démonstration">Ses données sont simulées : il ne se connecte pas à SuperHote. Ajoutez votre propre logement pour brancher votre jeton.</Banner>;
  const ls = sh?.lastSync, pc = ls?.priceCheck, oc: Record<string, any> = ls?.observedCommission ?? {}, pf = ls?.observedPaymentFee, rc = ls?.reservationCheck, cands: any[] = sh?.candidates ?? [];
  return (
    <section className="stack">
      {error && <Banner role="attention" title="La connexion à SuperHote a échoué">{error} Le dossier du logement est créé ; vous pouvez ressaisir le jeton ci-dessous.</Banner>}
      {!sh?.apiKeyEnc ? (
        <>
          <Banner role="tech" title="SuperHote n'est pas connecté à ce logement">Sans lui, les réservations transmises sans canal restent à préciser à la main, et le prix réellement publié ne peut pas être comparé à l'estimation.</Banner>
          <ActionForm action={connectSuperhoteAction} hidden={{ propertyId }}>
            <div className="field" style={{ marginBottom: 12, maxWidth: 560 }}>
              <label htmlFor="shKey">Jeton API SuperHote <span className="req" aria-hidden="true">*</span></label>
              <input id="shKey" name="apiKey" type="password" autoComplete="off" spellCheck={false} required minLength={20} aria-describedby="shKey-h" />
              <span className="help" id="shKey-h">Vérifié auprès de SuperHote, puis chiffré. Jamais réaffiché en entier.</span>
            </div>
            <Submit icon="plug" pendingLabel="Vérification…">Vérifier et connecter</Submit>
          </ActionForm>
          <SuperhoteGuide open />
        </>
      ) : (
        <>
          <Recap rows={[
            ["Jeton API", <span key="k">{sh.keyHint} · chiffré</span>, true],
            ["Logement rattaché", sh.rentalId ? `${sh.rentalName ?? sh.rentalId} · identifiant ${sh.rentalId}` : <Vq>à confirmer</Vq>],
            ["Dernière lecture", ls?.at ? <>{fmtDateTime(new Date(ls.at))} · {ls.ok ? <State role="sain">réussie</State> : <State role="attention">en échec</State>}</> : <Vq>aucune</Vq>],
            ...(sh.lastReconcile ? [["Dernière réconciliation", (() => {
              const r = sh.lastReconcile, parts = [[r.created, "créée", "créées"], [r.modified, "modifiée", "modifiées"], [r.cancelled + r.vanished, "annulée", "annulées"], [r.reactivated, "réactivée", "réactivées"]].filter(([n]) => (n as number) > 0).map(([n, one, many]) => `${n} ${(n as number) > 1 ? many : one}`);
              return <span key="rc" data-testid="reconcile-summary">{fmtDateTime(new Date(r.at))} · {parts.length ? <>{parts.join(", ")} {r.unchanged === 0 && r.modified + r.cancelled + r.vanished + r.reactivated === 0 ? <State role="sain">première lecture</State> : <State role="attention">écart rattrapé</State>}</> : <State role="sain">aucun écart</State>}{r.suspicious && <> · <State role="attention">lecture vide ignorée</State></>}</span>;
            })()] as [string, React.ReactNode]] : []),
            ...(ls?.ok ? [
              ["Réservations lues", `${ls.reservations} non annulée${ls.reservations > 1 ? "s" : ""} · ${ls.nights} nuits de calendrier (J+0 à J+90)`],
              ...(plLinked ? [["Canaux relevés", ls.autoChannels > 0 ? `${ls.autoChannels} réservation${ls.autoChannels > 1 ? "s" : ""} transmise${ls.autoChannels > 1 ? "s" : ""} sans canal par PriceLabs ${ls.autoChannels > 1 ? "ont reçu leur canal" : "a reçu son canal"} depuis SuperHote` : "aucune réservation sans canal à compléter"] as [string, React.ReactNode]] : []),
              ["Commissions relevées", Object.keys(oc).length === 0 ? <Vq key="c">aucune réservation avec commission transmise</Vq>
                : <span key="c">{Object.entries(oc).map(([ch, v]: [string, any]) => `${ch === "AIRBNB" ? "Airbnb" : "Booking.com"} ${String(v.pct).replace(".", ",")} % sur ${v.n} réservation${v.n > 1 ? "s" : ""} (séjours du ${fmtDate(v.from)} au ${fmtDate(v.to)})${v.excluded ? `, ${v.excluded} écartée${v.excluded > 1 ? "s" : ""} car taux invraisemblable` : ""}`).join(" · ")}{pf ? ` · frais de paiement Booking.com ${String(pf.pct).replace(".", ",")} % sur ${pf.n} réservation${pf.n > 1 ? "s" : ""}` : ""}</span>],
              ...(plLinked ? [["Réservations vs PriceLabs", !rc ? <Vq key="r">pas encore comparées</Vq>
                : rc.onlySuperhote + rc.onlyPriceLabs + rc.amountDiffs === 0 ? <span key="r"><State role="sain">concordantes</State> {rc.compared} réservations comparées.</span>
                : <span key="r"><State role="attention">écarts</State> {rc.compared} comparées : {rc.amountDiffs} montant{rc.amountDiffs > 1 ? "s" : ""} différent{rc.amountDiffs > 1 ? "s" : ""}, {rc.onlySuperhote} absente{rc.onlySuperhote > 1 ? "s" : ""} de PriceLabs, {rc.onlyPriceLabs} absente{rc.onlyPriceLabs > 1 ? "s" : ""} de SuperHote. SuperHote fait foi. <Link href={`/logements/${propertyId}/ecarts-reservations`}>Voir le détail</Link></span>]] as [string, React.ReactNode][] : []),
              ["Prix du calendrier", !plLinked ? <Vq key="p">comparaison possible une fois PriceLabs rattaché</Vq>
                : !pc || pc.verdict === "INCONNU" ? <Vq key="p">aucune nuit libre à comparer</Vq>
                : pc.verdict === "IDENTIQUE" ? <span key="p"><State role="sain">identique</State> {pc.compared} nuits libres comparées : le prix du calendrier SuperHote est le prix recommandé par PriceLabs, donc <strong>avant majoration par canal</strong>. Le moteur retient le prix SuperHote.</span>
                : <span key="p"><State role="attention">écarts</State> {pc.differing} nuit{pc.differing > 1 ? "s" : ""} sur {pc.compared} diffèrent du prix recommandé par PriceLabs (écart maximal {euro(pc.maxGapCents)}). {pc.samples.map((x: any) => `${fmtDate(x.date)} : SuperHote ${euro(x.shCents)}, PriceLabs ${euro(x.sentCents)}`).join(" · ")}</span>],
            ] as [string, React.ReactNode][] : []),
          ]} />
          {ls && !ls.ok && <Banner role="attention" title="Dernière lecture en échec">{ls.error} Les données précédentes sont conservées.</Banner>}
          {!sh.rentalId && (() => {
            const free = cands.filter((c) => !taken[String(c.id)]);
            const desc = (c: any) => `${c.name}${c.city ? " — " + c.city : ""}${c.capacity ? ` — ${c.capacity} voyageurs` : ""}`;
            return (
              <>
                <Banner role="attention" title="Rattachement à confirmer">Le lien se fait sur votre confirmation, pas sur le nom : vérifiez que le logement SuperHote est bien <strong>{propertyName}</strong> ({propertyCity}). Rien n'est lu tant que vous n'avez pas confirmé.</Banner>
                {cands.filter((c) => taken[String(c.id)]).map((c) => <p key={c.id} className="muted" style={{ margin: 0 }}>« {c.name} » est déjà rattaché à votre logement « {taken[String(c.id)]} » : il n'est pas proposé.</p>)}
                {free.length === 0 ? (
                  <Banner role="tech" title="Aucun logement disponible sur ce compte">Tous les logements visibles avec ce jeton sont déjà rattachés à vos autres logements.</Banner>
                ) : free.length === 1 ? (
                  <ActionForm action={selectRentalAction} hidden={{ propertyId, rentalId: String(free[0].id) }}>
                    <Recap rows={[["Logement SuperHote", free[0].name], ["Ville", free[0].city ?? <Vq key="v">inconnue</Vq>], ["Identifiant", String(free[0].id), true]]} />
                    <div style={{ marginTop: 14 }}><Submit icon="check" pendingLabel="Première lecture…">Oui, c'est bien ce logement : rattacher</Submit></div>
                  </ActionForm>
                ) : (
                  <ActionForm action={selectRentalAction} hidden={{ propertyId }}>
                    <div className="field" style={{ marginBottom: 12, maxWidth: 560 }}>
                      <label htmlFor="rentalId">Quel logement SuperHote correspond à celui-ci ? <span className="req" aria-hidden="true">*</span></label>
                      <select id="rentalId" name="rentalId" required defaultValue="">
                        <option value="" disabled>Choisir un logement</option>
                        {free.map((c) => <option key={c.id} value={String(c.id)}>{desc(c)}</option>)}
                      </select>
                    </div>
                    <Submit icon="check" pendingLabel="Première lecture…">Rattacher ce logement</Submit>
                  </ActionForm>
                )}
              </>
            );
          })()}
          {sh.rentalId && webhook && (
            <div className="stack" data-testid="webhook-panel">
              <Recap rows={[
                ["Webhooks SuperHote", webhook.active ? <State role="sain">actifs</State> : <State role="attention">non activés</State>],
                ...(webhook.active ? [
                  ["Dernière livraison", webhook.lastReceivedAt ? fmtDateTime(webhook.lastReceivedAt) : <Vq key="l">aucune pour l'instant</Vq>],
                  ["Livraisons", `${webhook.counts.PROCESSED ?? 0} traitée${(webhook.counts.PROCESSED ?? 0) > 1 ? "s" : ""} · ${webhook.counts.IGNORED ?? 0} ignorée${(webhook.counts.IGNORED ?? 0) > 1 ? "s" : ""} · ${webhook.counts.FAILED ?? 0} en échec`],
                ] as [string, React.ReactNode][] : []),
              ]} />
              {webhook.active && webhook.lastFailure && <Banner role="attention" title="Une livraison n'a pas pu être traitée">{webhook.lastFailure} La lecture planifiée rattrapera l'écart.</Banner>}
              {!webhook.active && webhook.reason && <p className="muted" style={{ margin: 0 }}>{webhook.reason}</p>}
              <div className="row-wrap">
                {!webhook.active
                  ? <ActionForm action={enableWebhookAction} hidden={{ propertyId }} className="inline"><Submit icon="plug" pendingLabel="Activation…">Activer les webhooks</Submit></ActionForm>
                  : <ActionForm action={disableWebhookAction} hidden={{ propertyId }} className="inline"><Submit className="btn btn-ghost btn-sm" icon="cross">Désactiver les webhooks</Submit></ActionForm>}
              </div>
              <p className="muted" style={{ margin: 0 }}>Avec les webhooks, SuperHote prévient NuitSignal à chaque réservation créée, modifiée ou annulée, sans attendre la prochaine lecture. Le jeton doit porter le scope « public-api:webhooks.manage ». Un seul webhook sert tous les logements d'un même compte SuperHote.</p>
            </div>
          )}
          <div className="row-wrap">
            {sh.rentalId && <ActionForm action={syncSuperhoteAction} hidden={{ propertyId }} className="inline"><Submit icon="spin" pendingLabel="Lecture en cours…">Relire SuperHote maintenant</Submit></ActionForm>}
            {sh.rentalId && <ActionForm action={detachRentalAction} hidden={{ propertyId }} className="inline"><Submit className="btn btn-ghost btn-sm" icon="undo">Changer de logement</Submit></ActionForm>}
            <ActionForm action={disconnectSuperhoteAction} hidden={{ propertyId }} className="inline"><Submit className="btn btn-danger btn-sm" icon="cross">Supprimer le jeton</Submit></ActionForm>
          </div>
          <p className="muted" style={{ margin: 0 }}>Lecture seule. Les réservations et disponibilités SuperHote sont relues de toutes les heures à toutes les 6 h, selon le rythme de suivi de ce logement.{!plLinked && " Rattachez aussi PriceLabs pour que les canaux relevés et la comparaison de prix soient appliqués."}</p>
        </>
      )}
    </section>
  );
}
