import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { BarChart } from "@/components/BarChart";
import { Icon } from "@/components/Icon";
import { Page } from "@/components/Page";
import { Badge, Banner, Byline, Cascade, Metric, Money, Recap, State, Vq } from "@/components/ui";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { addDays, diffDays, fmtDate, fmtDateTime, fmtDay, fmtMonth, fmtMonthShort, todayISO } from "@/lib/dates";
import { promosOn } from "@/lib/engine/detect";
import { floorGrid, missingEconomics, simulateStack } from "@/lib/engine/economics";
import { channelShare, lastMonths, leadTimes, medianLos, monthlyKpis, windowStats } from "@/lib/engine/metrics";
import { CHANNEL_LABEL, type Channel, type EconomicModel, type Strategy } from "@/lib/engine/types";
import { euro, pct, pts } from "@/lib/format";
import { loadEngineInput } from "@/lib/services/review";
import { PROPERTY_STATUS as STATUS } from "@/lib/labels";

const TABS = [["apercu", "Vue d'ensemble"], ["calendrier", "90 jours"], ["strategie", "Stratégie"], ["economie", "Économie"], ["canaux", "Canaux et promotions"], ["donnees", "Qualité des données"]] as const;

export default async function Logement({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const tab = (await searchParams).tab ?? "apercu";
  const [p] = await db.select().from(schema.properties).where(and(eq(schema.properties.id, id), eq(schema.properties.tenantId, user.tenantId)));
  if (!p) notFound();
  const today = todayISO(), now = new Date();
  const input = (await loadEngineInput(user.tenantId, p.id, today, now))!;
  const opps = await db.select().from(schema.opportunities).where(and(eq(schema.opportunities.propertyId, p.id), eq(schema.opportunities.status, "OPEN")));
  const model = p.economics as EconomicModel, strat = p.strategy as Strategy, names = user.settings.agentNames ?? null;
  const miss = missingEconomics(model);
  const [label, fam, ico] = STATUS[p.status] ?? STATUS.ONBOARDING;
  const months = lastMonths(today, 12), kpis = monthlyKpis(input.resas, months);
  const hasHistory = input.resas.length > 0, hasCal = input.days.length > 0;
  const sum = (f: (k: (typeof kpis)[number]) => number) => kpis.reduce((a, k) => a + f(k), 0);
  const stats = windowStats(input.days, today);
  const lead = leadTimes(input.resas), los = medianLos(input.resas), share = channelShare(input.resas);
  const flagged = new Map<string, boolean>();
  for (const o of opps.filter((x) => x.playbook !== "PB-10")) for (let d = o.stayFrom; d < o.stayTo; d = addDays(d, 1)) flagged.set(d, flagged.get(d) || o.veto);
  const first3 = sum((k) => 1) && kpis.slice(0, 3).reduce((a, k) => a + k.netRevpanCents, 0) / 3, last3 = kpis.slice(-3).reduce((a, k) => a + k.netRevpanCents, 0) / 3;
  const trend = !hasHistory ? null : last3 > first3 * 1.05 ? "croissante" : last3 < first3 * 0.95 ? "décroissante" : "stable";
  const allPromos = await db.select().from(schema.promotions).where(eq(schema.promotions.propertyId, p.id));

  return (
    <Page title={p.name} sub={`${p.kind} · ${p.city} · stratégie v${p.strategyVersion}`} crumbs={[{ label: "Logements", href: "/logements" }, { label: p.name }]}>
      <div className="idhead">
        <div>
          <h1>{p.name} {p.isDemo && <span className="demo-pill" style={{ verticalAlign: "middle" }}>démonstration</span>}</h1>
          <div className="idmeta"><span>{p.kind}{p.bedrooms ? ` · ${p.bedrooms} chambres` : ""}{p.capacity ? ` · ${p.capacity} voyageurs` : ""}</span><span>{p.city}</span><span>{p.profile?.positioning ?? "positionnement non renseigné"}</span></div>
        </div>
        <div className="idsync"><Badge family={fam} icon={ico}>{label}</Badge><span className="read-date"><Icon name="clock" />{hasCal ? `Calendrier lu jusqu'au ${fmtDate(input.days[input.days.length - 1].date)}` : "Aucun calendrier lu"}</span></div>
      </div>
      {p.isDemo && <Banner role="tech" title="Logement de démonstration" style={{ marginBottom: 16 }}>Réservations, prix, marché et coûts sont synthétiques. Les coûts et commissions affichés sont des hypothèses à remplacer par vos valeurs lors de l'onboarding de votre propre logement.</Banner>}
      {miss.length > 0 && <Banner role="attention" title="Modèle économique incomplet" style={{ marginBottom: 16 }}>Valeurs inconnues : {miss.join(", ")}. Aucun plancher n'est calculé et aucune opportunité financière n'est ouverte tant qu'elles manquent — elles ne sont jamais remplacées par zéro.</Banner>}
      {!hasCal && <Banner role="tech" title="Calendrier non connecté" style={{ marginBottom: 16 }}>La revue quotidienne démarre dès que les réservations (SuperHote) et la grille (PriceLabs) sont lisibles. <Link href="/integrations">Voir les intégrations</Link></Banner>}

      <div className="subnav" role="tablist" aria-label="Sections du logement" style={{ marginBottom: 22 }}>
        {TABS.map(([k, l]) => <Link key={k} role="tab" aria-selected={tab === k} href={`/logements/${p.id}?tab=${k}`} scroll={false} className="subnav-link">{l}</Link>)}
      </div>

      {tab === "apercu" && (
        <>
          <div className="synth">
            <Metric label="Revenu net · 12 mois" value={hasHistory ? euro(sum((k) => k.netCents)) : <Vq>inconnu</Vq>} source="Hébergement − commissions − frais de paiement" />
            <Metric label="Occupation · 12 mois" value={hasHistory ? pct(sum((k) => k.nights) / sum((k) => k.available)) : <Vq>inconnue</Vq>} source={`${sum((k) => k.nights)} nuits vendues`} />
            <Metric label="Prix moyen net" value={hasHistory && sum((k) => k.nights) ? euro(sum((k) => k.netCents) / sum((k) => k.nights)) : <Vq>inconnu</Vq>} source="Par nuit occupée" />
            <Metric label="Revenu net par nuit disponible" value={hasHistory ? euro(sum((k) => k.netCents) / sum((k) => k.available)) : <Vq>inconnu</Vq>} source={trend ? `Tendance ${trend} sur 12 mois` : "Tendance inconnue"} />
          </div>
          {hasHistory && (
            <section className="section">
              <h2>Revenu net mensuel</h2>
              <p className="section-note">Chaque nuit est rattachée à son mois de séjour. Tendance du revenu net par nuit disponible : <strong>{trend}</strong> (trois derniers mois comparés aux trois premiers).</p>
              <BarChart title="Revenu net d'hébergement par mois" unit="Euros, hors ménage et taxes de séjour · douze derniers mois complets" data={kpis.map((k) => ({ label: fmtMonthShort(k.month), full: fmtMonth(k.month), cents: k.netCents, note: `occupation ${pct(k.occupancy)}` }))} />
            </section>
          )}
          {hasCal && (
            <section className="section">
              <h2>Rythme de réservation face au marché</h2>
              <p className="section-note">Relevé par l'analyste marché sur les cinq fenêtres canoniques. Un écart négatif n'est pas un ordre de baisser : il ouvre un diagnostic.</p>
              <div className="table-wrap"><table className="econ">
                <thead><tr><th scope="col">Fenêtre</th><th scope="col" className="num">Logement</th><th scope="col" className="num">Marché</th><th scope="col" className="num">Écart</th><th scope="col" className="num">Nuits libres</th><th scope="col" className="num">Position de prix</th></tr></thead>
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

      {tab === "calendrier" && (hasCal ? (
        <section>
          <div className="legend" style={{ marginBottom: 12 }}>
            <span className="legend-item"><span className="cal-day is-booked" style={{ minHeight: 14, width: 22, padding: 0 }} />réservé</span>
            <span className="legend-item"><span className="cal-day" style={{ minHeight: 14, width: 22, padding: 0 }} />libre · prix publié</span>
            <span className="legend-item"><span className="cal-day is-flag" style={{ minHeight: 14, width: 22, padding: 0 }} />dossier ouvert</span>
            <span className="legend-item"><span className="cal-day is-veto" style={{ minHeight: 14, width: 22, padding: 0 }} />veto</span>
          </div>
          <div className="cal">{input.days.map((d) => {
            const fl = flagged.get(d.date);
            return (
              <div key={d.date} className={`cal-day${d.state === "BOOKED" ? " is-booked" : d.state === "BLOCKED" ? " is-blocked" : ""}${fl === true ? " is-veto" : fl === false ? " is-flag" : ""}${d.date.endsWith("-01") ? " is-month" : ""}`}
                title={`${fmtDate(d.date)} · ${d.state === "BOOKED" ? "réservé" : d.state === "BLOCKED" ? "bloqué" : "libre"}${d.priceCents !== null ? " · " + euro(d.priceCents) : ""}${d.minStay ? " · séjour min. " + d.minStay : ""}${d.rule ? " · " + d.rule : ""}${d.event ? " · " + d.event : ""}`}>
                <span className="d">{fmtDay(d.date)}</span>
                <span className="p">{d.state === "BOOKED" ? "rés." : d.state === "BLOCKED" ? "bloqué" : d.priceCents === null ? "?" : euro(d.priceCents)}</span>
                <span className="m">{d.marketOccupancy === null ? "m. ?" : "m. " + pct(d.marketOccupancy)}{d.event ? " ★" : ""}</span>
              </div>
            );
          })}</div>
          <p className="foot">Prix publiés par PriceLabs et occupation du marché (« m. »), par nuit ; « rés. » : nuit réservée. ★ : événement déclaré. Survolez une case pour le détail.</p>
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
          <Banner role="tech" title="PriceLabs reste le moteur de prix">L'agence règle les paramètres transmis à PriceLabs ; elle ne recalcule pas ses prix journaliers. Une seule hypothèse structurante est testée à la fois.</Banner>
          <p><Byline agent="pricing" names={names} what="tient cette stratégie et propose ses évolutions" /></p>
        </section>
      )}

      {tab === "economie" && (
        <section className="stack">
          <Recap rows={[
            ...(["AIRBNB", "BOOKING"] as Channel[]).map((c) => [`Commission ${CHANNEL_LABEL[c]}`, model.channels?.[c] ? `${String(model.channels[c]!.commissionPct).replace(".", ",")} % + ${String(model.channels[c]!.paymentFeePct).replace(".", ",")} % de frais de paiement` : <Vq>inconnue</Vq>, true] as [string, React.ReactNode, boolean]),
            ["Frais de ménage facturés", <Money key="1" cents={model.cleaningFeeChargedCents} />, true], ["Coût du ménage", <Money key="2" cents={model.cleaningCostCents} />, true], ["Coût du linge", <Money key="3" cents={model.linenCostCents} />, true],
            ["Coûts variables par nuit", <Money key="4" cents={model.nightlyVariableCostCents} />, true],
            ["Contribution minimale absolue · par nuit", <Money key="5" cents={model.hardContributionPerNightCents} />, true], ["Contribution de sécurité · par nuit", <Money key="6" cents={model.strategyContributionPerNightCents} />, true], ["Contribution visée · par nuit", <Money key="7" cents={model.targetContributionPerNightCents} />, true],
            ["Origine", model.origin === "DEMO" ? "Valeurs de démonstration, à remplacer" : "Déclarées par vous à l'onboarding"],
          ]} />
          {miss.length === 0 && (
            <>
              <h2 style={{ fontSize: 18, margin: "14px 0 0" }}>Planchers par canal et durée de séjour</h2>
              <p className="section-note" style={{ margin: 0 }}>Prix vendu minimal par nuit, après remises. Sous le plancher absolu, l'auditeur oppose son veto ; entre les deux, il demande une validation commentée.</p>
              <div className="table-wrap"><table className="econ">
                <thead><tr><th scope="col">Canal</th><th scope="col" className="num">Durée</th><th scope="col" className="num">Plancher absolu</th><th scope="col" className="num">Plancher stratégique</th></tr></thead>
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

      {tab === "donnees" && (
        <section className="stack">
          <div className="table-wrap"><table className="econ">
            <thead><tr><th scope="col">Donnée</th><th scope="col">Source</th><th scope="col">État</th><th scope="col">Détail</th></tr></thead>
            <tbody>
              <tr><th scope="row">Réservations</th><td>{p.isDemo ? "Démonstration" : "SuperHote"}</td><td>{hasHistory ? <State role="sain">lues</State> : <State role="attention">absentes</State>}</td><td>{input.resas.length} réservations{hasHistory ? ` · dernière arrivée ${fmtDate(input.resas.map((r) => r.checkIn).sort().at(-1)!)}` : ""}</td></tr>
              <tr><th scope="row">Calendrier et prix</th><td>{p.isDemo ? "Démonstration" : "PriceLabs"}</td><td>{hasCal ? <State role="sain">lus</State> : <State role="attention">absents</State>}</td><td>{input.days.length} jours · {input.days.filter((d) => d.priceCents === null).length} prix inconnus</td></tr>
              <tr><th scope="row">Marché</th><td>{p.isDemo ? "Démonstration" : "PriceLabs"}</td><td>{input.days.some((d) => d.marketOccupancy !== null) ? <State role="sain">lu</State> : <State role="attention">absent</State>}</td><td>{input.days.filter((d) => d.marketOccupancy === null).length} jours sans occupation de marché</td></tr>
              <tr><th scope="row">Promotions</th><td>Registre manuel</td><td>{input.promos.some((x) => !x.verifiedAt || +now - +x.verifiedAt > 7 * 86400000) ? <State role="attention">à vérifier</State> : <State role="sain">à jour</State>}</td><td>{input.promos.length} active(s)</td></tr>
              <tr><th scope="row">Modèle économique</th><td>{model.origin === "DEMO" ? "Démonstration" : "Onboarding"}</td><td>{miss.length ? <State role="attention">incomplet</State> : <State role="sain">complet</State>}</td><td>{miss.length ? miss.join(", ") : "Planchers calculables"}</td></tr>
            </tbody></table></div>
          <p><Byline agent="onboarding" names={names} what="contrôle ces sources à chaque revue" /> <span className="muted">· relevé du {fmtDateTime(now)}</span></p>
        </section>
      )}
    </Page>
  );
}
