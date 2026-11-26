import Link from "next/link";
import { Icon } from "@/components/Icon";
import { PropertyHubLinks } from "@/components/PropertyHub";
import { Term } from "@/components/Term";
import { Metric, Vq } from "@/components/ui";
import { fmtDate, fmtDay } from "@/lib/dates";
import { computeKpi, monthPeriod, nightFactsFromResas, NET_STATUS_LABEL } from "@/lib/metrics/kpi";
import { euro, pct } from "@/lib/format";
import { can } from "@/lib/rbac";
import type { Fiche } from "./context";

/** Situations montrées sur la vue d'ensemble : les vetos d'abord, puis les plus prioritaires. */
const SHOWN = 3;

export function Apercu({ user, p, input, opps, model, hasHistory, months, kpis, period, trend }: Fiche) {
  const firstStay = input.resas.filter((r) => r.status === "CONFIRMED").map((r) => r.checkIn).sort()[0];
  const partial = !!firstStay && firstStay.slice(0, 7) > months[0];
  const sum = (f: (k: (typeof kpis)[number]) => number) => kpis.reduce((a, k) => a + f(k), 0);
  // KPI canoniques sur les douze mois (US-050) : le net inconnu n'est jamais compté comme nul
  const yearKpi = (() => { const { sold, blocked } = nightFactsFromResas(input.resas); blocked.push(...input.days.filter((d) => d.state === "BLOCKED").map((d) => d.date)); return computeKpi({ from: monthPeriod(months[0]).from, to: monthPeriod(months[months.length - 1]).to }, sold, blocked); })();
  const netNote = yearKpi.netStatus === "PARTIAL" || yearKpi.netStatus === "UNKNOWN" ? ` · ${NET_STATUS_LABEL[yearKpi.netStatus].toLowerCase()}${yearKpi.netCoverage !== null ? ` (${Math.round(yearKpi.netCoverage * 100)} % des nuits)` : ""}` : "";
  const shown = [...opps].sort((a, b) => Number(b.veto) - Number(a.veto) || b.priority - a.priority).slice(0, SHOWN);
  return (
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
          <p style={{ margin: "0 0 4px" }}><Link className="btn btn-ghost btn-sm" href={`/logements/${p.id}?tab=performance`}>Revenu mensuel et rythme de réservation <Icon name="arrow" /></Link></p>
          <section className="section">
            <h2>Aller plus loin</h2>
            <PropertyHubLinks property={p} canEdit={can(user.role, "property.manage")} canDelete={can(user.role, "property.delete")} />
          </section>
          <section className="section">
            <h2>Situations ouvertes{opps.length > SHOWN ? ` · ${SHOWN} sur ${opps.length}` : ""}</h2>
            {opps.length === 0 ? <p className="muted">Aucune situation ouverte sur ce logement.</p> : (
              <>
                <ul className="timeline">{shown.map((o) => (
                  <li key={o.id}><span className={`tl-dot ${o.veto ? "is-veto" : "is-tech"}`}><Icon name={o.veto ? "ban" : "dot"} /></span><div><span className="tl-when">{o.code} · {fmtDay(o.stayFrom)} → {fmtDay(o.stayTo)}</span><p className="tl-what"><Link href={`/dossier/${o.code}`}>{o.title}</Link></p><p className="tl-who">{o.candidates[o.selected]?.label}</p></div></li>
                ))}</ul>
                <p style={{ margin: 0 }}><Link href={`/?p=${p.id}`}>Toutes les situations de ce logement ({opps.length}) →</Link></p>
              </>
            )}
          </section>
    </>
  );
}
