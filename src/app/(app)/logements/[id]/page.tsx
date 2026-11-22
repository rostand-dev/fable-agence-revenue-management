import Link from "next/link";
import { Term } from "@/components/Term";
import { Fragment } from "react";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { BarChart } from "@/components/BarChart";
import { CadencePanel } from "@/components/CadencePanel";
import { Icon } from "@/components/Icon";
import { Page } from "@/components/Page";
import { ListingsPanel } from "@/components/ListingsPanel";
import { PriceLabsPanel } from "@/components/PriceLabsPanel";
import { SuperhotePanel } from "@/components/SuperhotePanel";
import { badgeHref, pricelabsBadge, superhoteBadge } from "@/lib/integrations/connection-badge";
import { getSnapshotState } from "@/lib/services/snapshots";
import { rentalLinkedElsewhere } from "@/lib/services/superhote-sync";
import { webhookStatus } from "@/lib/services/superhote-webhook";
import { Badge, Banner, Byline, Cascade, Metric, Money, Recap, State, Vq } from "@/components/ui";
import { db, schema } from "@/db";
import { agentName } from "@/lib/agents/registry";
import { requireUser } from "@/lib/auth";
import { addDays, diffDays, fmtDate, fmtDateTime, fmtDay, fmtMonth, fmtMonthShort, todayISO } from "@/lib/dates";
import { promosOn } from "@/lib/engine/detect";
import { floorGrid, missingEconomics, simulateStack } from "@/lib/engine/economics";
import { channelShare, lastMonths, leadTimes, medianLos, monthlyKpis, windowStats } from "@/lib/engine/metrics";
import { computeKpi, monthPeriod, nightFactsFromResas, NET_STATUS_LABEL } from "@/lib/metrics/kpi";
import { CHANNEL_LABEL, type Channel, type EconomicModel, type Strategy } from "@/lib/engine/types";
import { euro, pct, pts, signedEuro } from "@/lib/format";
import { estimateAllChannels, estimatePublishedPrice, pickDefaultChannel, sentMinusRecommended, type ChannelMarkup } from "@/lib/pricing/published";
import { loadEngineInput } from "@/lib/services/review";
import { linkedElsewhere } from "@/lib/services/pricelabs-sync";
import { PROPERTY_STATUS as STATUS } from "@/lib/labels";
import { listListings } from "@/lib/services/portfolio";

async function noChannelRows(propertyId: string, overrides: Record<string, string>) {
  const rows = await db.select().from(schema.reservations).where(eq(schema.reservations.propertyId, propertyId));
  return rows.filter((r) => overrides[r.externalId] || (r.channel === "INCONNU" && r.status === "CONFIRMED")).sort((a, b) => a.checkIn.localeCompare(b.checkIn))
    .map((r) => ({ externalId: r.externalId, checkIn: r.checkIn, checkOut: r.checkOut, nights: r.nights, grossRoomCents: r.grossRoomCents, commissionCents: r.commissionCents, choice: overrides[r.externalId] ?? "" }));
}

const TABS = [["apercu", "Vue d'ensemble"], ["calendrier", "90 jours"], ["strategie", "Stratégie"], ["economie", "Économie"], ["canaux", "Canaux et promotions"], ["donnees", "Qualité des données"], ["annonces", "Annonces"], ["pricelabs", "PriceLabs"], ["superhote", "SuperHote"]] as const;

export default async function Logement({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; erreur?: string; erreurSh?: string; canal?: string; jour?: string; lance?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const tab = sp.tab ?? "apercu";
  const [p] = await db.select().from(schema.properties).where(and(eq(schema.properties.id, id), eq(schema.properties.tenantId, user.tenantId)));
  if (!p) notFound();
  const today = todayISO(), now = new Date();
  const input = (await loadEngineInput(user.tenantId, p.id, today, now))!;
  const opps = await db.select().from(schema.opportunities).where(and(eq(schema.opportunities.propertyId, p.id), eq(schema.opportunities.status, "OPEN")));
  const model = p.economics as EconomicModel, strat = p.strategy as Strategy, names = user.settings.agentNames ?? null;
  const miss = missingEconomics(model);
  // pendant la création, tout se complète dans le parcours guidé : une seule bannière, qui y ramène
  const onboarding = !p.isDemo && p.status === "ONBOARDING";
  const [label, fam, ico] = STATUS[p.status] ?? STATUS.ONBOARDING;
  const months = lastMonths(today, 12), kpis = monthlyKpis(input.resas, months);
  const hasHistory = input.resas.length > 0, hasCal = input.days.length > 0;
  const period = `${fmtMonth(months[0])} → ${fmtMonth(months[months.length - 1])}`;
  const firstStay = input.resas.filter((r) => r.status === "CONFIRMED").map((r) => r.checkIn).sort()[0];
  const partial = !!firstStay && firstStay.slice(0, 7) > months[0];
  const sum = (f: (k: (typeof kpis)[number]) => number) => kpis.reduce((a, k) => a + f(k), 0);
  // KPI canoniques sur les douze mois (US-050) : le net inconnu n'est jamais compté comme nul
  const yearKpi = (() => { const { sold, blocked } = nightFactsFromResas(input.resas); blocked.push(...input.days.filter((d) => d.state === "BLOCKED").map((d) => d.date)); return computeKpi({ from: monthPeriod(months[0]).from, to: monthPeriod(months[months.length - 1]).to }, sold, blocked); })();
  const netNote = yearKpi.netStatus === "PARTIAL" || yearKpi.netStatus === "UNKNOWN" ? ` · ${NET_STATUS_LABEL[yearKpi.netStatus].toLowerCase()}${yearKpi.netCoverage !== null ? ` (${Math.round(yearKpi.netCoverage * 100)} % des nuits)` : ""}` : "";
  const stats = windowStats(input.days, today);
  const lead = leadTimes(input.resas), los = medianLos(input.resas), share = channelShare(input.resas);
  const flagged = new Map<string, boolean>();
  for (const o of opps.filter((x) => x.playbook !== "PB-10" && x.playbook !== "PB-13")) for (let d = o.stayFrom; d < o.stayTo; d = addDays(d, 1)) flagged.set(d, flagged.get(d) || o.veto);
  const first3 = sum((k) => 1) && kpis.slice(0, 3).reduce((a, k) => a + k.netRevpanCents, 0) / 3, last3 = kpis.slice(-3).reduce((a, k) => a + k.netRevpanCents, 0) / 3;
  const trendKnown = !kpis.some((k) => k.netIncomplete);
  const trend = !hasHistory || !trendKnown ? null : last3 > first3 * 1.05 ? "croissante" : last3 < first3 * 0.95 ? "décroissante" : "stable";
  const markups = (p.channelMarkups ?? []) as ChannelMarkup[];
  const channel = pickDefaultChannel(markups, sp.canal);            // null tant qu'aucune majoration n'est renseignée
  const unknownChannels = markups.filter((m) => m.pct === null).map((m) => m.label);
  const calHref = (extra: { canal?: string; jour?: string }) => `/logements/${p.id}?tab=calendrier${extra.canal ? "&canal=" + encodeURIComponent(extra.canal) : ""}${extra.jour ? "&jour=" + extra.jour : ""}`;
  /** Prix affiché pour une nuit libre, en centimes : estimé sur le canal choisi (à partir du prix recommandé), sinon prix du calendrier (SuperHote, avant majoration) ; null = inconnu. */
  const shownCents = (d: (typeof input.days)[number]): number | null => {
    if (!channel) return d.priceCents ?? null;
    const e = estimatePublishedPrice({ state: d.state, recommendedPriceCents: d.priceCents ?? d.recommendedPriceCents }, channel.pct);
    return e ? e.displayEuros * 100 : null;
  };
  const stateLabel = (st: string) => (st === "BOOKED" ? "réservé" : st === "BLOCKED" ? "bloqué" : "libre");
  const detailDay = sp.jour ? input.days.find((d) => d.date === sp.jour) : undefined;
  const allPromos = await db.select().from(schema.promotions).where(eq(schema.promotions.propertyId, p.id));
  const [owner] = p.ownerId ? await db.select({ name: schema.owners.name }).from(schema.owners).where(and(eq(schema.owners.id, p.ownerId), eq(schema.owners.tenantId, user.tenantId))) : [];
  const listingRows = tab === "annonces" ? await listListings(user.tenantId, p.id) : [];

  return (
    <Page title={p.name} sub={`${[p.kind, p.city].filter(Boolean).join(" · ") || "dossier en cours de saisie"} · stratégie v${p.strategyVersion}`} crumbs={[{ label: "Logements", href: "/logements" }, { label: p.name }]}>
      <div className="idhead">
        <div>
          <h1>{p.name} {p.isDemo && <span className="demo-pill" style={{ verticalAlign: "middle" }}>démonstration</span>}</h1>
          <div className="idmeta"><span>{p.kind || "type non renseigné"}{p.bedrooms ? ` · ${p.bedrooms} chambres` : ""}{p.capacity ? ` · ${p.capacity} voyageurs` : ""}</span><span>{p.city || "ville non renseignée"}</span><span>{p.profile?.positioning ?? "positionnement non renseigné"}</span>{owner && <span data-testid="property-owner">propriétaire : {owner.name}</span>}</div>
        </div>
        <div className="idsync"><Badge family={fam} icon={ico}>{label}</Badge>{([["pricelabs", pricelabsBadge(p.pricelabs, p.isDemo)], ["superhote", superhoteBadge(p.superhote, p.isDemo)]] as const).map(([k, b]) => b && <Link key={k} href={badgeHref(k, p.id, p.status)} scroll={false} className="state-link"><State role={b.role}>{b.label}</State></Link>)}<span className="read-date"><Icon name="clock" />{hasCal ? `Calendrier lu jusqu'au ${fmtDate(input.days[input.days.length - 1].date)}` : "Aucun calendrier lu"}</span></div>
      </div>
      {!p.isDemo && p.status !== "ONBOARDING" && (() => {
        const missing = Object.keys((p.economics as any)?.channels ?? {}).map((c) => (c === "AIRBNB" ? { k: "airbnb", l: "Airbnb" } : { k: "booking", l: "Booking.com" })).filter((c) => !markups.some((m) => (m.key === c.k || m.key.startsWith(c.k + "-")) && m.pct !== null)).map((c) => c.l);
        return missing.length ? <Banner role="attention" title="Majoration non renseignée" style={{ marginBottom: 16 }}>Majoration SuperHote manquante pour {missing.join(" et ")}. Sans elle, le prix vendu sur ce canal ne peut pas être calculé : il est exclu de la revue des agents. Saisissez-la dans « Modifier le dossier ».</Banner> : null;
      })()}
      {p.isDemo && <Banner role="tech" title="Logement de démonstration" style={{ marginBottom: 16 }}>Réservations, prix, marché et coûts sont synthétiques. Les coûts et commissions affichés sont des hypothèses à remplacer par vos valeurs lors de l'onboarding de votre propre logement.</Banner>}
      {!p.isDemo && p.status === "ONBOARDING" && <Banner role="tech" title="Création du logement en cours" style={{ marginBottom: 16 }}>Ce logement n'est pas encore lancé. Reprenez le parcours de création là où vous l'avez laissé. <span style={{ display: "block", marginTop: 10 }}><Link className="btn btn-primary btn-sm" href={`/logements/${p.id}/creation`}><Icon name="arrow" />Reprendre la création</Link> <Link className="btn btn-ghost btn-sm" href={`/logements/${p.id}/supprimer`}><Icon name="cross" />Supprimer ce brouillon</Link></span></Banner>}
      {miss.length > 0 && !onboarding && <Banner role="attention" title="Modèle économique incomplet" style={{ marginBottom: 16 }}>Il manque : {miss.join(", ")}. Aucun plancher n'est calculé et aucune situation n'est ouverte tant que ces valeurs manquent ; une estimation provisoire suffit pour démarrer.{!p.isDemo && <> <Link href={`/logements/${p.id}/couts`}>Les renseigner pas à pas avec {agentName("onboarding", names)}</Link></>}</Banner>}
      {!hasCal && !onboarding && tab !== "pricelabs" && <Banner role="tech" title="Calendrier non connecté" style={{ marginBottom: 16 }}>La revue démarre dès que la clé API PriceLabs de ce logement est renseignée. <Link href={`/logements/${p.id}?tab=pricelabs`}>Connecter PriceLabs</Link></Banner>}

      {sp.lance && <Banner role="sain" title="Observation lancée" style={{ marginBottom: 16 }}>Le dossier est complet : l'équipe lit vos données et vous proposera ses premières situations, sans rien appliquer sans votre accord.</Banner>}
      {!p.isDemo && p.status !== "ONBOARDING" && <p className="row-wrap" style={{ margin: "0 0 16px" }}><Link className="btn btn-ghost btn-sm" href={`/logements/${p.id}/modifier`}><Icon name="sliders" />Modifier le dossier</Link><Link className="btn btn-ghost btn-sm" href={`/logements/${p.id}/mapping`}><Icon name="link" />Mapping des identifiants</Link><Link className="btn btn-ghost btn-sm" href={`/logements/${p.id}/qualite`}><Icon name="check" />Checklist de qualité</Link><Link className="btn btn-ghost btn-sm" href={`/logements/${p.id}/validations`}><Icon name="check" />Validations avant activation</Link><Link className="btn btn-ghost btn-sm" href={`/logements/${p.id}/supprimer`}><Icon name="cross" />Supprimer</Link></p>}
      <div className="subnav" role="tablist" aria-label="Sections du logement" style={{ marginBottom: 22 }}>
        {TABS.map(([k, l]) => <Link key={k} role="tab" aria-selected={tab === k} href={`/logements/${p.id}?tab=${k}`} scroll={false} className="subnav-link">{l}</Link>)}
      </div>

      {tab === "apercu" && (
        <>
          <div className="synth">
            <Metric label={<><Term id="revenu-net">Revenu net</Term> · 12 mois</>} value={hasHistory && yearKpi.netRoomCents !== null ? <>{euro(yearKpi.netRoomCents)}{yearKpi.netStatus === "PARTIAL" && <span className="muted"> · partiel</span>}</> : <Vq>inconnu</Vq>} source={`${period} · montant des réservations${model.touristTaxPct ? " hors taxe de séjour" : ""} − commissions − frais de paiement${netNote}`} />
            <Metric label={<><Term id="occupation">Occupation</Term> · 12 mois</>} value={hasHistory ? pct(sum((k) => k.nights) / sum((k) => k.available)) : <Vq>inconnue</Vq>} source={`${sum((k) => k.nights)} nuits vendues · ${period}`} />
            <Metric label={<Term id="adr">Prix moyen net</Term>} value={hasHistory && yearKpi.netAdrCents !== null ? euro(yearKpi.netAdrCents) : <Vq>inconnu</Vq>} source={`Par nuit occupée${yearKpi.netStatus === "PARTIAL" ? " · nuits dont la commission est connue" : ""}`} />
            <Metric label={<Term id="revpar">Revenu net par nuit disponible</Term>} value={hasHistory && yearKpi.netRevpanCents !== null ? euro(yearKpi.netRevpanCents) : <Vq>inconnu</Vq>} source={yearKpi.netStatus === "PARTIAL" ? "Inconnu tant que le net n'est pas connu pour toutes les nuits vendues" : trend ? `Tendance ${trend} sur 12 mois` : "Tendance inconnue"} />
          </div>
          {hasHistory && (
            <p className="kpi-note">Période : <strong>{period}</strong>, soit les douze derniers mois complets ; le mois en cours et les séjours à venir n'y figurent pas. Chaque nuit est comptée dans son mois de séjour.{partial && ` L'historique lu ne commence que le ${fmtDate(firstStay!)} : les mois antérieurs sont vides, pas nuls.`}{!p.isDemo && (model.touristTaxPct === null || model.touristTaxPct === undefined ? " Le montant transmis par PriceLabs est ce que paie le voyageur, ménage et taxe de séjour compris : tant que la part de taxe n'est pas déclarée (Coûts et seuils), ce revenu net est surestimé d'autant." : " Le montant des réservations comprend les frais de ménage ; la taxe de séjour déclarée en est retirée.")}</p>
          )}
          {hasHistory && (
            <section className="section">
              <h2>Revenu net mensuel</h2>
              <p className="section-note">Chaque nuit est rattachée à son mois de séjour. Tendance du revenu net par nuit disponible : <strong>{trend}</strong> (trois derniers mois comparés aux trois premiers).</p>
              <BarChart title="Revenu net d'hébergement par mois" unit={`Euros · ${period}${p.isDemo ? " · hors ménage et taxes de séjour" : " · montant total des réservations, net de commissions"}`} data={kpis.map((k) => ({ label: fmtMonthShort(k.month), full: fmtMonth(k.month), cents: k.netCents, note: `occupation ${pct(k.occupancy)}` }))} />
            </section>
          )}
          <CadencePanel cadence={p.cadence} isDemo={p.isDemo} hasPriceLabs={!!p.pricelabs?.listingId} hasSuperhote={!!p.superhote?.rentalId} nextReservationsAt={p.nextReservationsAt} nextPricesAt={p.nextPricesAt} nextReviewAt={p.nextReviewAt} now={now} />
          {hasCal && (
            <section className="section">
              <h2>Rythme de réservation face au marché</h2>
              <p className="section-note">Relevé par l'analyste marché sur les cinq fenêtres canoniques. Un écart négatif n'est pas un ordre de baisser : il ouvre un diagnostic.</p>
              <div className="table-wrap"><table className="econ">
                <thead><tr><th scope="col"><Term id="fenetre-reservation">Fenêtre</Term></th><th scope="col" className="num">Logement</th><th scope="col" className="num"><Term id="occupation-marche">Marché</Term></th><th scope="col" className="num"><Term id="ecart-marche">Écart</Term></th><th scope="col" className="num">Nuits libres</th><th scope="col" className="num"><Term id="position-de-prix">Position de prix</Term></th></tr></thead>
                <tbody>{stats.map((s) => (
                  <tr key={s.key}><th scope="row">{s.label}<span className="src">{fmtDay(s.from)} → {fmtDay(addDays(s.to, -1))}</span></th>
                    <td className="num">{pct(s.occupancy)}</td><td className="num">{s.marketOccupancy === null ? <Vq>inconnu</Vq> : pct(s.marketOccupancy)}</td>
                    <td className="num">{s.gap === null ? "—" : pts(s.gap)}</td><td className="num">{s.free}</td><td className="num">{s.avgPercentile === null ? "—" : s.avgPercentile + "e pct."}</td></tr>
                ))}</tbody></table></div>
              <p className="kpi-note"><Byline agent="marche" names={names} what={`délai de réservation ${lead ? `médian ${lead.median} j` : "inconnu"} · durée médiane ${los ? los + " nuits" : "inconnue"}`} /></p>
            </section>
          )}
          <section className="section">
            <h2>Situations ouvertes</h2>
            {opps.length === 0 ? <p className="muted">Aucune situation ouverte sur ce logement.</p> : (
              <ul className="timeline">{opps.sort((a, b) => b.priority - a.priority).map((o) => (
                <li key={o.id}><span className={`tl-dot ${o.veto ? "is-veto" : "is-tech"}`}><Icon name={o.veto ? "ban" : "dot"} /></span><div><span className="tl-when">{o.code} · {fmtDay(o.stayFrom)} → {fmtDay(o.stayTo)}</span><p className="tl-what"><Link href={`/dossier/${o.code}`}>{o.title}</Link></p><p className="tl-who">{o.candidates[o.selected]?.label}</p></div></li>
              ))}</ul>
            )}
          </section>
        </>
      )}

      {!p.isDemo && (tab === "annonces" || tab === "pricelabs" || tab === "superhote") && <p style={{ margin: "0 0 16px" }}><Link className="btn btn-ghost btn-sm" href={`/logements/${p.id}/mapping`}><Icon name="link" />Mapping des identifiants</Link></p>}
      {tab === "annonces" && <ListingsPanel propertyId={p.id} listings={listingRows} editable={!p.isDemo} />}

      {tab === "calendrier" && (hasCal ? (
        <section>
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
                <span className={`p${channel && cents !== null ? " is-est" : ""}`}>{d.state === "BOOKED" ? "rés." : d.state === "BLOCKED" ? "bloqué" : cents === null ? "?" : (channel ? "~" : "") + euro(cents)}</span>
                <span className="m">{d.marketOccupancy === null ? "m. ?" : "m. " + pct(d.marketOccupancy)}{d.event ? " ★" : ""}</span>
              </Link>
            );
          })}</div>
          <p className="foot">{channel ? <>« ~ » : prix publié <strong>estimé</strong> sur {channel.label} = prix recommandé par PriceLabs × (1 + {String(channel.pct).replace(".", ",")} %), arrondi à l'euro. Ce n'est pas le prix lu chez SuperHote.{unknownChannels.length > 0 && <> Majoration non renseignée : {unknownChannels.join(", ")}.</>}</> : <>Prix envoyé à SuperHote, avant majoration des canaux : aucune majoration n'est renseignée, le prix publié aux voyageurs est donc inconnu.{!p.isDemo && <> <Link href={`/logements/${p.id}/modifier`}>Renseigner les majorations</Link>.</>}</>} « m. » : occupation du marché ; « rés. » : nuit réservée ; ★ : événement déclaré. Touchez une case pour le détail.</p>
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
      ) : <div className="empty"><h3>Aucun calendrier</h3><p>Le calendrier apparaît dès que les intégrations sont connectées.</p></div>)}

      {tab === "strategie" && (
        <section className="stack">
          <Recap rows={[
            ["Objectif", strat.objective ?? <Vq>non renseigné</Vq>], ["Positionnement", strat.positioning ?? p.profile?.positioning ?? <Vq>non renseigné</Vq>],
            ["Prix de base", <Money key="b" cents={strat.basePriceCents} />, true], ["Prix minimum", <Money key="m" cents={strat.minPriceCents} />, true], ["Prix maximum", <Money key="x" cents={strat.maxPriceCents} />, true],
            ["Séjour minimum", strat.minStay ? `${strat.minStay} nuits` : <Vq>inconnu</Vq>, true],
            ["Cumul de remises maximal", `${strat.maxDiscountStackPct ?? 20} %`, true], ["Variation de prix sans validation renforcée", `± ${strat.maxPriceChangePct ?? 5} %`, true],
            ["Version", `v${p.strategyVersion}`, true],
          ]} />
          {!p.isDemo && p.status !== "ONBOARDING" && <p style={{ margin: 0 }}><Link className="btn btn-ghost btn-sm" href={`/logements/${p.id}/strategie`}><Icon name="sliders" />Strategy Builder : brouillon, publication, historique</Link></p>}
          <Banner role="tech" title="PriceLabs reste le moteur de prix">L'agence règle les paramètres transmis à PriceLabs ; elle ne recalcule pas ses prix journaliers. Une seule hypothèse structurante est testée à la fois.</Banner>
          <p><Byline agent="pricing" names={names} what="tient cette stratégie et propose ses évolutions" /></p>
        </section>
      )}

      {tab === "economie" && (
        <section className="stack">
          {!p.isDemo && p.economicsVersion > 0 && <p style={{ margin: 0 }}><Link className="btn btn-ghost btn-sm" href={`/logements/${p.id}/versions-economie`}><Icon name="history" />Versions du modèle économique (en vigueur : v{p.economicsVersion})</Link></p>}
          {!p.isDemo && <p style={{ margin: 0 }}><Link className="btn btn-ghost btn-sm" href={`/logements/${p.id}/couts`}><Icon name="chat" />{miss.length ? "Renseigner" : "Revoir"} coûts et seuils avec {agentName("onboarding", names)}</Link></p>}
          {(model.provisional?.length ?? 0) > 0 && <Banner role="tech" title={`Planchers provisoires : ${model.provisional!.length} valeur${model.provisional!.length > 1 ? "s" : ""} à confirmer`}>{model.provisional!.join(", ")}. Les planchers ci-dessous en dépendent ; les dossiers ouverts portent la même mention.</Banner>}
          <Recap rows={[
            ...(["AIRBNB", "BOOKING"] as Channel[]).map((c) => [`Commission ${CHANNEL_LABEL[c]}`, model.channels?.[c] ? `${String(model.channels[c]!.commissionPct).replace(".", ",")} % + ${String(model.channels[c]!.paymentFeePct).replace(".", ",")} % de frais de paiement` : <Vq>inconnue</Vq>, true] as [string, React.ReactNode, boolean]),
            [<Term key="m1" id="menage">Frais de ménage facturés</Term>, <Money key="1" cents={model.cleaningFeeChargedCents} />, true], ["Coût du ménage", <Money key="2" cents={model.cleaningCostCents} />, true], ["Coût du linge", <Money key="3" cents={model.linenCostCents} />, true],
            [<Term key="m2" id="couts-variables">Coûts variables par nuit</Term>, <Money key="4" cents={model.nightlyVariableCostCents} />, true],
            [<><Term id="plancher-absolu">Seuil de dérangement</Term> · par nuit (plancher absolu)</>, <Money key="5" cents={model.hardContributionPerNightCents} />, true], [<><Term id="charges-fixes">Charges fixes</Term> à couvrir · par nuit vendue (<Term id="plancher-strategique">plancher stratégique</Term>)</>, <Money key="6" cents={model.strategyContributionPerNightCents} />, true], [<><Term id="objectif-nuit">Objectif</Term> · par nuit vendue</>, <Money key="7" cents={model.targetContributionPerNightCents} />, true],
            ["Taxe de séjour dans les montants", model.touristTaxPct === null || model.touristTaxPct === undefined ? <Vq key="t">inconnue : le revenu net affiché l'inclut</Vq> : `${String(model.touristTaxPct).replace(".", ",")} % retirés de chaque réservation`],
            ["Origine", model.origin === "DEMO" ? "Valeurs de démonstration, à remplacer" : "Déclarées par vous, pas à pas"],
          ]} />
          {miss.length === 0 && (
            <>
              <h2 style={{ fontSize: 18, margin: "14px 0 0" }}>Planchers par canal et durée de séjour</h2>
              <p className="section-note" style={{ margin: 0 }}>Prix vendu minimal par nuit, après remises. Sous le plancher absolu, l'auditeur oppose son veto ; entre les deux, il demande une validation commentée.</p>
              <div className="table-wrap"><table className="econ">
                <thead><tr><th scope="col">Canal</th><th scope="col" className="num"><Term id="los">Durée</Term></th><th scope="col" className="num"><Term id="plancher-absolu">Plancher absolu</Term></th><th scope="col" className="num"><Term id="plancher-strategique">Plancher stratégique</Term></th></tr></thead>
                <tbody>{floorGrid(model).map((f) => <tr key={f.channel + f.nights}><th scope="row">{CHANNEL_LABEL[f.channel]}</th><td className="num">{f.nights} nuits</td><td className="num">{euro(f.hardCents)}</td><td className="num">{euro(f.strategyCents)}</td></tr>)}</tbody></table></div>
              {strat.basePriceCents && model.channels.BOOKING && (
                <div className="cascade-wrap"><header><h3>Ce que laisse une nuit au prix de base · Booking.com · séjour de {los ?? 2} nuits</h3><p>Calcul déterministe du simulateur, remises du canal actives aujourd'hui comprises.</p></header>
                  <Cascade current={null} proposed={simulateStack({ model, channel: "BOOKING", nights: los ?? 2, publishedNightlyCents: strat.basePriceCents, promos: promosOn(input.promos, "BOOKING", today) })} /></div>
              )}
              <p><Byline agent="onboarding" names={names} what="a calculé ces planchers à partir des coûts" /></p>
            </>
          )}
        </section>
      )}

      {tab === "canaux" && (
        <section className="stack">
          <div className="synth">{Object.entries(share).map(([c, s]) => <Metric key={c} label={`Part ${CHANNEL_LABEL[c] ?? c}`} value={pct(s)} source="Nuits vendues · historique" />)}{Object.keys(share).length === 0 && <Metric label="Mix de canaux" value={<Vq>inconnu</Vq>} source="Aucune réservation importée" />}</div>
          <h2 style={{ fontSize: 18, margin: "14px 0 0" }}>Registre des promotions</h2>
          <p className="section-note" style={{ margin: 0 }}>Tenu à la main tant que les accès partenaires officiels ne sont pas obtenus. Au-delà de 7 jours sans vérification, une promotion est considérée comme incertaine.</p>
          {allPromos.length === 0 ? <p className="muted">Aucune promotion déclarée.</p> : (
            <div className="table-wrap"><table className="econ">
              <thead><tr><th scope="col">Promotion</th><th scope="col">Canal</th><th scope="col" className="num">Remise</th><th scope="col">Séjours</th><th scope="col">État</th><th scope="col">Dernière vérification</th></tr></thead>
              <tbody>{allPromos.map((x) => {
                const age = x.verifiedAt ? Math.floor((+now - +x.verifiedAt) / 86400000) : null;
                return <tr key={x.id}><th scope="row">{x.label}</th><td>{CHANNEL_LABEL[x.channel]}</td><td className="num">−{x.discountPct} %</td><td>{x.stayFrom ? `${fmtDay(x.stayFrom)} → ${fmtDay(x.stayTo!)}` : "permanente"}</td>
                  <td>{x.status === "ACTIVE" ? <State role="sain">active</State> : <State role="neutre">terminée</State>}</td>
                  <td>{age === null ? <Vq>jamais</Vq> : age > 7 && x.status === "ACTIVE" ? <Vq kind="obsolete">il y a {age} j</Vq> : `il y a ${age} j`}</td></tr>;
              })}</tbody></table></div>
          )}
          <p><Byline agent="distribution" names={names} what="tient ce registre" /></p>
        </section>
      )}

      {tab === "pricelabs" && sp.erreurSh && <Banner role="attention" title="La connexion à SuperHote a échoué" style={{ marginBottom: 14 }}>{sp.erreurSh} Ressaisissez le jeton dans l'onglet SuperHote.</Banner>}
      {tab === "pricelabs" && <PriceLabsPanel costsMissing={miss.length} propertyId={p.id} propertyName={p.name} propertyCity={p.city} isDemo={p.isDemo} pl={p.pricelabs ?? null} error={sp.erreur} taken={tab === "pricelabs" && !p.isDemo ? Object.fromEntries(await linkedElsewhere(user.tenantId, p.id)) : {}} noChannel={tab === "pricelabs" && !p.isDemo ? await noChannelRows(p.id, p.pricelabs?.overrides ?? {}) : []} snapshots={tab === "pricelabs" && !p.isDemo && p.pricelabs?.apiKeyEnc ? await getSnapshotState(user.tenantId, p.id, { limit: 5 }) : null} />}

      {tab === "superhote" && <SuperhotePanel propertyId={p.id} propertyName={p.name} propertyCity={p.city} isDemo={p.isDemo} sh={p.superhote ?? null} plLinked={!!p.pricelabs?.listingId} taken={!p.isDemo ? Object.fromEntries(await rentalLinkedElsewhere(user.tenantId, p.id)) : {}} error={sp.erreurSh} webhook={!p.isDemo && p.superhote?.apiKeyEnc ? await webhookStatus(user.tenantId, p.id) : undefined} />}

      {tab === "donnees" && (
        <section className="stack">
          <div className="table-wrap"><table className="econ">
            <thead><tr><th scope="col">Donnée</th><th scope="col">Source</th><th scope="col">État</th><th scope="col">Détail</th></tr></thead>
            <tbody>
              <tr><th scope="row">Réservations</th><td>{p.isDemo ? "Démonstration" : "PriceLabs · relais du PMS"}</td><td>{hasHistory ? <State role="sain">lues</State> : <State role="attention">absentes</State>}</td><td>{input.resas.length} réservations{hasHistory ? ` · dernière arrivée ${fmtDate(input.resas.map((r) => r.checkIn).sort().at(-1)!)}` : ""}</td></tr>
              <tr><th scope="row">Calendrier et prix</th><td>{p.isDemo ? "Démonstration" : "PriceLabs"}</td><td>{hasCal ? <State role="sain">lus</State> : <State role="attention">absents</State>}</td><td>{input.days.length} jours · {input.days.filter((d) => d.priceCents === null).length} prix inconnus</td></tr>
              <tr><th scope="row">Marché</th><td>{p.isDemo ? "Démonstration" : "PriceLabs"}</td><td>{input.days.some((d) => d.marketOccupancy !== null) ? <State role="sain">lu</State> : <State role="attention">absent ou périmé</State>}</td><td>{input.days.filter((d) => d.marketOccupancy === null).length} jours sans occupation de marché</td></tr>
              <tr><th scope="row">Promotions</th><td>Registre manuel</td><td>{input.promos.some((x) => !x.verifiedAt || +now - +x.verifiedAt > 7 * 86400000) ? <State role="attention">à vérifier</State> : <State role="sain">à jour</State>}</td><td>{input.promos.length} active(s)</td></tr>
              <tr><th scope="row">Modèle économique</th><td>{model.origin === "DEMO" ? "Démonstration" : "Onboarding"}</td><td>{miss.length ? <State role="attention">incomplet</State> : <State role="sain">complet</State>}</td><td>{miss.length ? miss.join(", ") : "Planchers calculables"}</td></tr>
            </tbody></table></div>
          <p><Byline agent="onboarding" names={names} what="contrôle ces sources à chaque revue" /> <span className="muted">· relevé du {fmtDateTime(now)}</span></p>
        </section>
      )}
    </Page>
  );
}
