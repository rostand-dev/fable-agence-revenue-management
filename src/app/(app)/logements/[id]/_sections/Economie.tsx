import Link from "next/link";
import { Icon } from "@/components/Icon";
import { Term } from "@/components/Term";
import { Byline, Cascade, Money, Recap, Vq } from "@/components/ui";
import { agentName } from "@/lib/agents/registry";
import { promosOn } from "@/lib/engine/detect";
import { simulateStack } from "@/lib/engine/economics";
import { medianLos } from "@/lib/engine/metrics";
import { seasonalFloorGrid } from "@/lib/engine/seasons";
import { CHANNEL_LABEL, type Channel } from "@/lib/engine/types";
import { euro } from "@/lib/format";
import type { Fiche } from "./context";

/** Commissions, coûts, seuils et planchers par canal. */
export function Economie({ p, input, today, model, strat, names, miss }: Fiche) {
  const los = medianLos(input.resas);
  return (
        <section className="stack">
          {!p.isDemo && p.economicsVersion > 0 && <p style={{ margin: 0 }}><Link className="btn btn-ghost btn-sm" href={`/logements/${p.id}/versions-economie`}><Icon name="history" />Versions du modèle économique (en vigueur : v{p.economicsVersion})</Link></p>}
          {!p.isDemo && <p style={{ margin: 0 }}><Link className="btn btn-ghost btn-sm" href={`/logements/${p.id}/couts`}><Icon name="chat" />{miss.length ? "Renseigner" : "Revoir"} coûts et seuils avec {agentName("onboarding", names)}</Link></p>}
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
                <tbody>{seasonalFloorGrid(model).map((f) => <tr key={f.channel + f.nights}><th scope="row">{CHANNEL_LABEL[f.channel]}</th><td className="num">{f.nights} nuits</td><td className="num">{euro(f.hardCents)}</td><td className="num">{euro(f.strategyCents)}{f.seasons.map((x) => <span key={x.seasonId} className="muted" style={{ display: "block", fontSize: 13 }} data-testid="floor-season">{x.label} : {euro(x.strategyCents)}</span>)}</td></tr>)}</tbody></table></div>
              {!p.isDemo && <p style={{ margin: 0 }}><Link className="btn btn-ghost btn-sm" href={`/logements/${p.id}/saisons`} data-testid="seasons-link"><Icon name="calendar" />{(model.seasons?.length ?? 0) ? `Saisons du plancher (${model.seasons!.length})` : "Ajouter des saisons au plancher"}</Link></p>}
              {strat.basePriceCents && model.channels.BOOKING && (
                <div className="cascade-wrap"><header><h3>Ce que laisse une nuit au prix de base · Booking.com · séjour de {los ?? 2} nuits</h3><p>Calcul déterministe du simulateur, remises du canal actives aujourd'hui comprises.</p></header>
                  <Cascade current={null} proposed={simulateStack({ model, channel: "BOOKING", nights: los ?? 2, publishedNightlyCents: strat.basePriceCents, promos: promosOn(input.promos, "BOOKING", today) })} /></div>
              )}
              <p><Byline agent="onboarding" names={names} what="a calculé ces planchers à partir des coûts" /></p>
            </>
          )}
        </section>
  );
}
