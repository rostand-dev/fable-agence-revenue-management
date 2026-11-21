import { channelOverridesAction, connectPriceLabsAction, detachListingAction, disconnectPriceLabsAction, selectListingAction, syncPriceLabsAction, testPriceLabsAction } from "@/app/actions/pricelabs";
import { fmtDate, fmtDateTime, fmtDay } from "@/lib/dates";
import { euro } from "@/lib/format";
import { ActionForm, Submit } from "./forms";
import type { getSnapshotState } from "@/lib/services/snapshots";
import { PriceLabsGuide } from "./PriceLabsGuide";
import { Banner, Recap, State, Vq } from "./ui";

const CHECK_ROLE: Record<string, "sain" | "attention" | "violation" | "neutre"> = { OK: "sain", WARN: "attention", FAIL: "violation", SKIPPED: "neutre" };
const CHECK_WORD: Record<string, string> = { OK: "disponible", WARN: "à vérifier", FAIL: "en échec", SKIPPED: "non vérifié" };

/** Résultat du dernier test de connexion : une ligne par lecture, avec son état en toutes lettres (jamais la couleur seule). */
function ConnectionCheckResult({ check }: { check: Record<string, any> }) {
  return (
    <div className="stack" style={{ gap: 6 }} data-testid="pricelabs-check" aria-live="polite">
      <p className="section-note" style={{ margin: 0 }}>
        <State role={check.ok === null ? "attention" : check.ok ? "sain" : "violation"}>{check.ok === null ? "Clé valide, annonce à rattacher" : check.ok ? "Essentiel disponible" : "Lecture impossible"}</State>{" "}
        Test du {fmtDateTime(new Date(check.at))}. Rien n'a été modifié : seul ce résultat est mémorisé.
      </p>
      <ul role="list" className="plain-list" style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "grid", gap: 6 }}>
        {(check.checks ?? []).map((c: any) => (
          <li key={c.id} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
            <span style={{ minWidth: 150, fontWeight: 600 }}>{c.label}</span>
            <State role={CHECK_ROLE[c.status] ?? "neutre"}>{CHECK_WORD[c.status] ?? c.status}</State>
            <span className="muted" style={{ flex: "1 1 220px", minWidth: 0, overflowWrap: "anywhere" }}>{c.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type SnapshotState = Awaited<ReturnType<typeof getSnapshotState>>;
const FRESH_WORD = { FRESH: "à jour", STALE: "périmé", MISSING: "jamais lu" } as const;
const FRESH_ROLE = { FRESH: "sain", STALE: "attention", MISSING: "neutre" } as const;
const KIND_LABEL = { CONFIG: "Configuration", PRICING: "Prix", MARKET: "Marché" } as const;
const ADAPTER_LABEL: Record<string, string> = { HTTP: "PriceLabs", FAKE: "jeu de données simulé", REPLAY: "rejeu d'une fixture" };

/** Fraîcheur des données lues (seuils du blueprint §7.4) : date du dernier snapshot, état en toutes lettres, origine réelle ou simulée. */
function SnapshotFreshness({ state }: { state: SnapshotState }) {
  return (
    <div className="stack" style={{ gap: 6 }} data-testid="pricelabs-snapshots">
      <h2 style={{ fontSize: 17, margin: "8px 0 2px" }}>Fraîcheur des données lues</h2>
      <ul role="list" style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "grid", gap: 6 }}>
        {(["CONFIG", "PRICING", "MARKET"] as const).map((k) => {
          const snap = state.latest[k], f = state.freshness[k];
          return (
            <li key={k} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
              <span style={{ minWidth: 110, fontWeight: 600 }}>{KIND_LABEL[k]}</span>
              <State role={FRESH_ROLE[f.state]}>{FRESH_WORD[f.state]}</State>
              <span className="muted" style={{ flex: "1 1 220px", minWidth: 0, overflowWrap: "anywhere" }}>
                {snap ? <>Lu le {fmtDateTime(new Date(snap.observedAt))} · {ADAPTER_LABEL[snap.adapter] ?? snap.adapter} · qualité {snap.qualityScore} %{snap.unchangedOf ? " · identique à la lecture précédente" : ""} · à renouveler après {f.maxHours} h</> : "Aucun snapshot : la première lecture n'a pas eu lieu."}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Contrôle de la dernière grille lue : complétude et anomalies, avec les dates concernées (statut toujours en toutes lettres). */
function GridReportView({ report }: { report: Record<string, any> }) {
  const warns = (report.issues ?? []).filter((i: any) => i.severity === "WARN").length, clean = warns === 0; // une simple information ne rend pas la grille « à vérifier"
  return (
    <div className="stack" style={{ gap: 6 }} data-testid="pricelabs-grid-report">
      <h2 style={{ fontSize: 17, margin: "8px 0 2px" }}>Contrôle de la grille de prix</h2>
      <p className="section-note" style={{ margin: 0 }}>
        <State role={clean ? "sain" : "attention"}>{clean ? "Grille complète" : `${warns} point${warns > 1 ? "s" : ""} à vérifier`}</State>{" "}
        {report.received} jour{report.received > 1 ? "s" : ""} lu{report.received > 1 ? "s" : ""} sur {report.expected} attendus · qualité {report.score} %.
      </p>
      {report.issues?.length > 0 && (
        <ul role="list" style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "grid", gap: 6 }}>
          {report.issues.map((i: any) => (
            <li key={i.code} style={{ overflowWrap: "anywhere", minWidth: 0 }}>
              <State role={i.severity === "WARN" ? "attention" : "neutre"}>{i.severity === "WARN" ? "à vérifier" : "information"}</State>{" "}
              {i.message}{i.dates?.length ? <span className="muted"> Dates : {i.dates.map((d: string) => fmtDay(d)).join(", ")}{(i.total ?? i.dates.length) > i.dates.length ? "…" : ""}.</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const CAP_WORD = { AVAILABLE: "disponible", LIMITED: "limité", NONE: "aucune donnée", UNAVAILABLE: "illisible" } as const;
const CAP_ROLE = { AVAILABLE: "sain", LIMITED: "attention", NONE: "attention", UNAVAILABLE: "violation" } as const;

/** Ce que PriceLabs a réellement fourni pour le marché : capacité, compset, couverture, limites (état en toutes lettres). */
function MarketReportView({ report }: { report: Record<string, any> }) {
  const cap = report.capability as keyof typeof CAP_WORD;
  return (
    <div className="stack" style={{ gap: 6 }} data-testid="pricelabs-market-report">
      <h2 style={{ fontSize: 17, margin: "8px 0 2px" }}>Contrôle du marché</h2>
      <p className="section-note" style={{ margin: 0 }}>
        <State role={CAP_ROLE[cap] ?? "neutre"}>{CAP_WORD[cap] ?? cap}</State>{" "}
        {cap === "UNAVAILABLE" || cap === "NONE" ? "Les signaux de marché restent inconnus." : <>Occupation connue pour {report.withOccupancy} jour{report.withOccupancy > 1 ? "s" : ""} sur {report.expected}{report.listingsUsed !== null ? ` · compset de ${report.listingsUsed} annonce${report.listingsUsed > 1 ? "s" : ""}` : ""}.</>}
      </p>
      {report.issues?.length > 0 && (
        <ul role="list" style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "grid", gap: 6 }}>
          {report.issues.map((i: any) => (
            <li key={i.code} style={{ overflowWrap: "anywhere", minWidth: 0 }}>
              <State role={i.severity === "WARN" ? "attention" : "neutre"}>{i.severity === "WARN" ? "à vérifier" : "information"}</State> {i.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Connexion PriceLabs d'un logement : saisie de la clé, choix de l'annonce, état de la dernière lecture. */
export type NoChannel = { externalId: string; checkIn: string; checkOut: string; nights: number; grossRoomCents: number; commissionCents: number | null; choice: string };

export function PriceLabsPanel({ propertyId, propertyName, propertyCity, isDemo, pl, error, taken, noChannel = [], costsMissing = 0, snapshots = null }: { propertyId: string; propertyName: string; propertyCity: string; isDemo: boolean; pl: Record<string, any> | null; error?: string; taken: Record<string, string>; noChannel?: NoChannel[]; costsMissing?: number; snapshots?: SnapshotState | null }) {
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
          {pl.listingId && costsMissing > 0 && <Banner role="attention" title="Étape suivante : vos coûts et vos seuils">PriceLabs est lu, mais il manque {costsMissing} valeur{costsMissing > 1 ? "s" : ""} pour calculer vos planchers : sans elles, aucune situation n'est ouverte. <a href={`/logements/${propertyId}/couts`}>Les renseigner pas à pas</a></Banner>}
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
          {pl.listingId && noChannel.length > 0 && (() => {
            const todo = noChannel.filter((r) => !r.choice), done = noChannel.filter((r) => r.choice);
            const LABEL: Record<string, string> = { AIRBNB: "Airbnb", BOOKING: "Booking.com", DIRECT: "Réservation directe", EXCLUDE: "Écartée du calcul" };
            const table = (rows: NoChannel[]) => (
              <div className="table-wrap"><table className="econ">
                <thead><tr><th scope="col">Séjour</th><th scope="col" className="num">Nuits</th><th scope="col" className="num">Montant</th><th scope="col" className="num">Commission retenue</th><th scope="col">Canal</th></tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={r.externalId}>
                    <th scope="row">{fmtDay(r.checkIn)} → {fmtDate(r.checkOut)}<span className="src">réservation {r.externalId}</span></th>
                    <td className="num">{r.nights}</td><td className="num">{euro(r.grossRoomCents)}</td>
                    <td className="num">{r.commissionCents === null ? "inconnue" : euro(r.commissionCents)}</td>
                    <td><label className="visually-hidden" htmlFor={"canal-" + r.externalId}>Canal de la réservation {r.externalId}</label>
                      <select id={"canal-" + r.externalId} name={"canal-" + r.externalId} defaultValue={r.choice} style={{ minHeight: 40, padding: "0 10px", borderRadius: 8, border: "1px solid var(--line-strong)", background: "rgb(4 5 10 / 60%)", color: "var(--ink)", font: "inherit", fontSize: 14 }}>
                        <option value="">Non identifié</option>{Object.entries(LABEL).map(([k, l]) => <option key={k} value={k}>{k === "EXCLUDE" ? "Écarter du calcul" : l}</option>)}
                      </select></td>
                  </tr>
                ))}</tbody></table></div>
            );
            return (
              <section>
                <h2 style={{ fontSize: 17, margin: "8px 0 2px" }}>Réservations transmises sans canal{todo.length > 0 && <span className="rail-count" style={{ marginLeft: 8, verticalAlign: "middle" }}>{todo.length}</span>}</h2>
                <ActionForm action={channelOverridesAction} hidden={{ propertyId }}>
                  {todo.length > 0 ? (
                    <>
                      <p className="section-note" style={{ margin: "0 0 10px" }}>Votre PMS a transmis {todo.length > 1 ? "ces réservations" : "cette réservation"} sans indiquer la plateforme. Précisez-la si vous la connaissez : la ligne quitte alors cette liste, et votre choix est réappliqué à chaque lecture.</p>
                      {table(todo)}
                    </>
                  ) : (
                    <p className="section-note" style={{ margin: "0 0 10px" }}><State role="sain">Liste vide</State> Toutes les réservations transmises sans canal ont été précisées.</p>
                  )}
                  {done.length > 0 && (
                    <details className="fold" style={{ marginTop: 12 }}>
                      <summary>Déjà précisées ({done.length}) — {Object.entries(LABEL).map(([k, l]) => [done.filter((r) => r.choice === k).length, l] as const).filter(([n]) => n > 0).map(([n, l]) => `${n} ${l}`).join(" · ")}</summary>
                      <div className="fold-body"><p className="muted" style={{ margin: "0 0 10px" }}>Pour corriger un choix, modifiez-le ici puis enregistrez. « Non identifié » renvoie la ligne dans la liste.</p>{table(done)}</div>
                    </details>
                  )}
                  <div style={{ marginTop: 12 }}><Submit className="btn btn-ghost" icon="check" pendingLabel="Enregistrement et relecture…">Enregistrer</Submit></div>
                </ActionForm>
              </section>
            );
          })()}
          {snapshots && <SnapshotFreshness state={snapshots} />}
          {ls?.ok && ls.gridReport && <GridReportView report={ls.gridReport} />}
          {ls?.ok && ls.marketReport && <MarketReportView report={ls.marketReport} />}
          {ls?.listingChanges?.length > 0 && <Banner role="attention" title="Annonce modifiée chez PriceLabs">{ls.listingChanges.join(" ; ")}. Vérifiez que l'annonce correspond toujours à ce logement.</Banner>}
          {pl.lastCheck && <ConnectionCheckResult check={pl.lastCheck} />}
          <div className="row-wrap">
            <ActionForm action={testPriceLabsAction} hidden={{ propertyId }} className="inline"><Submit className="btn btn-ghost btn-sm" icon="check" pendingLabel="Test en cours…">Tester la connexion</Submit></ActionForm>
            {pl.listingId && <ActionForm action={syncPriceLabsAction} hidden={{ propertyId }} className="inline"><Submit icon="spin" pendingLabel="Lecture en cours…">Relire PriceLabs maintenant</Submit></ActionForm>}
            {pl.listingId && <ActionForm action={detachListingAction} hidden={{ propertyId }} className="inline"><Submit className="btn btn-ghost btn-sm" icon="undo">Changer d'annonce</Submit></ActionForm>}
            <ActionForm action={disconnectPriceLabsAction} hidden={{ propertyId }} className="inline"><Submit className="btn btn-danger btn-sm" icon="cross">Supprimer la clé</Submit></ActionForm>
          </div>
          <p className="muted" style={{ margin: 0 }}>Lecture seule. PriceLabs est relu une à deux fois par jour, selon le rythme de suivi de ce logement ; ses prix sont recalculés par PriceLabs toutes les 24 heures.</p>
          <PriceLabsGuide />
        </>
      )}
    </section>
  );
}
