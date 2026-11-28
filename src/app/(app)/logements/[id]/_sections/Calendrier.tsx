import Link from "next/link";
import { IfRight } from "@/components/Rights";
import { Fragment } from "react";
import { Metric, Vq } from "@/components/ui";
import { fmtDate, fmtDay } from "@/lib/dates";
import { flaggedNights, horizonSummary } from "@/lib/engine/horizon";
import { euro, insecable, pct, signedEuro } from "@/lib/format";
import { estimateAllChannels, pickDefaultChannel, sentMinusRecommended, shownPriceCents, type ChannelMarkup } from "@/lib/pricing/published";
import type { Fiche } from "./context";

/** Calendrier à 90 jours : synthèse de l'horizon, prix par nuit et détail d'une date. */
export function Calendrier({ p, sp, input, opps, hasCal }: Fiche) {
  if (!hasCal) return <div className="empty"><h3>Aucun calendrier</h3><p>Le calendrier apparaît dès que les intégrations sont connectées.</p></div>;
  const flagged = flaggedNights(opps);
  const markups = (p.channelMarkups ?? []) as ChannelMarkup[];
  const channel = pickDefaultChannel(markups, sp.canal);            // null tant qu'aucune majoration n'est renseignée
  const unknownChannels = markups.filter((m) => m.pct === null).map((m) => m.label);
  const calHref = (extra: { canal?: string; jour?: string }) => `/logements/${p.id}?tab=calendrier${extra.canal ? "&canal=" + encodeURIComponent(extra.canal) : ""}${extra.jour ? "&jour=" + extra.jour : ""}`;
  const shownCents = (d: (typeof input.days)[number]) => shownPriceCents(d, channel);
  const stateLabel = (st: string) => (st === "BOOKED" ? "réservé" : st === "BLOCKED" ? "bloqué" : "libre");
  const detailDay = sp.jour ? input.days.find((d) => d.date === sp.jour) : undefined;
  const hz = horizonSummary(input.days.map((d) => ({ date: d.date, state: d.state, priceCents: d.state === "FREE" ? shownCents(d) : d.priceCents })), flagged);
  return (
        <section>
          <div className="synth" data-testid="horizon-synthese" style={{ marginBottom: 14 }}>
            <Metric label="Nuits réservées" value={hz.booked} source={`sur ${hz.nights} nuits lues (D+0 à D+${Math.max(hz.nights - 1, 0)})`} />
            <Metric label="Nuits libres" value={hz.free} source={hz.freeUnpriced ? `dont ${hz.freeUnpriced} sans prix affiché` : "toutes avec un prix affiché"} />
            <Metric label="Occupation des nuits vendables" value={hz.occupancy === null ? <Vq>inconnue</Vq> : pct(hz.occupancy)} source={`${hz.blocked} nuit${hz.blocked > 1 ? "s" : ""} bloquée${hz.blocked > 1 ? "s" : ""}, hors vente`} />
            <Metric label="Nuits touchées par un dossier" value={hz.flagged} tone={hz.vetoed ? "veto" : undefined} source={`${hz.vetoed} sous veto · dossiers ouverts uniquement`} />
          </div>
          <div className="legend" style={{ marginBottom: 12 }}>
            <span className="legend-item"><span className="cal-day is-booked" style={{ minHeight: 14, width: 22, padding: 0 }} />réservé</span>
            <span className="legend-item"><span className="cal-day" style={{ minHeight: 14, width: 22, padding: 0 }} />{channel ? `libre · prix publié estimé (${channel.label})` : "libre · prix envoyé à SuperHote"}</span>
            <span className="legend-item"><span className="cal-day is-flag" style={{ minHeight: 14, width: 22, padding: 0 }} />dossier ouvert</span>
            <span className="legend-item"><span className="cal-day is-veto" style={{ minHeight: 14, width: 22, padding: 0 }} />veto</span>
          </div>
          {channel && (
            <div className="cal-tools" role="group" aria-label="Canal du prix estimé">
              <span className="muted">Prix estimé pour :</span>
              {markups.filter((m) => m.pct !== null).map((m) => <Link key={m.key} href={calHref({ canal: m.key, jour: sp.jour })} scroll={false} className="chip" aria-current={m.key === channel.key ? "true" : undefined}>{m.label} · {String(m.pct).replace(".", ",")} %</Link>)}
            </div>
          )}
          <div className="cal">{input.days.map((d) => {
            const fl = flagged.get(d.date), cents = d.state === "FREE" ? shownCents(d) : null;
            return (
              <Link key={d.date} href={calHref({ canal: channel?.key, jour: d.date })} scroll={false} aria-current={sp.jour === d.date ? "date" : undefined}
                className={`cal-day${d.state === "BOOKED" ? " is-booked" : d.state === "BLOCKED" ? " is-blocked" : ""}${fl === true ? " is-veto" : fl === false ? " is-flag" : ""}${d.date.endsWith("-01") ? " is-month" : ""}`}
                title={`${fmtDate(d.date)} · ${stateLabel(d.state)}${cents !== null ? (channel ? " · prix estimé " + channel.label + " " : " · envoyé à SuperHote ") + euro(cents) : ""}${d.minStay ? " · séjour min. " + d.minStay : ""}${d.rule ? " · " + d.rule : ""}${d.event ? " · " + d.event : ""}`}>
                <span className="d">{fmtDay(d.date)}</span>
                <span className={`p${channel && cents !== null ? " is-est" : ""}`}>{d.state === "BOOKED" ? "rés." : d.state === "BLOCKED" ? "bloqué" : cents === null ? "?" : (channel ? "~" : "") + insecable(euro(cents))}</span>
                <span className="m">{d.marketOccupancy === null ? "m. ?" : "m. " + insecable(pct(d.marketOccupancy))}{d.event ? " ★" : ""}</span>
              </Link>
            );
          })}</div>
          <p className="foot">{channel ? <>« ~ » : prix publié <strong>estimé</strong> sur {channel.label} = prix recommandé par PriceLabs × (1 + {String(channel.pct).replace(".", ",")} %), arrondi à l'euro. Ce n'est pas le prix lu chez SuperHote.{unknownChannels.length > 0 && <> Majoration non renseignée : {unknownChannels.join(", ")}.</>}</> : <>Prix envoyé à SuperHote, avant majoration des canaux : aucune majoration n'est renseignée, le prix publié aux voyageurs est donc inconnu.{!p.isDemo && <IfRight need="property.manage"> <Link href={`/logements/${p.id}/modifier`}>Renseigner les majorations</Link>.</IfRight>}</>} « m. » : occupation du marché ; « rés. » : nuit réservée ; ★ : événement déclaré. Touchez une case pour le détail.</p>
          {sp.jour && !detailDay && <p className="foot">Date hors du calendrier lu.</p>}
          {detailDay && (
            <div className="date-detail" aria-live="polite">
              <div className="detail-head"><h3>{fmtDate(detailDay.date)} · {stateLabel(detailDay.state)}</h3><Link className="btn btn-ghost btn-sm" href={calHref({ canal: channel?.key })} scroll={false}>Fermer</Link></div>
              {(() => {
                const gap = sentMinusRecommended(detailDay.sentPriceCents, detailDay.recommendedPriceCents);
                const rows = estimateAllChannels({ state: detailDay.state, recommendedPriceCents: detailDay.priceCents ?? detailDay.recommendedPriceCents }, markups);
                return (
                  <dl>
                    <dt>Prix recommandé (PriceLabs)</dt><dd>{euro(detailDay.recommendedPriceCents, true)}</dd>
                    <dt>Prix envoyé à SuperHote</dt><dd>{detailDay.state === "FREE" ? euro(detailDay.sentPriceCents, true) : "sans objet"}</dd>
                    {gap !== null && <><dt>Écart envoyé − recommandé</dt><dd>{signedEuro(gap, true)}</dd></>}
                    {rows.map((r) => (
                      <Fragment key={r.key}><dt>Prix publié estimé · {r.label}{r.pct !== null ? ` (+${String(r.pct).replace(".", ",")} %)` : ""}</dt>
                        <dd>{r.pct === null ? "majoration inconnue" : r.estimate ? `~ ${euro(r.estimate.displayEuros * 100)} (${euro(r.estimate.exactCents, true)})` : "—"}</dd></Fragment>
                    ))}
                    {markups.length === 0 && <><dt>Prix publié estimé</dt><dd>aucune majoration renseignée</dd></>}
                  </dl>
                );
              })()}
              {detailDay.minStay ? <p className="foot" style={{ marginBottom: 0 }}>Séjour minimum : {detailDay.minStay} nuits.</p> : null}
            </div>
          )}
        </section>
  );
}
