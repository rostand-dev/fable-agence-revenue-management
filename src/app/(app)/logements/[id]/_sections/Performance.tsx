import { BarChart } from "@/components/BarChart";
import { Term } from "@/components/Term";
import { Byline, Vq } from "@/components/ui";
import { addDays, fmtDay, fmtMonth, fmtMonthShort } from "@/lib/dates";
import { leadTimes, medianLos, windowStats } from "@/lib/engine/metrics";
import { PACE_REASON_LABEL, PACE_STATUS_LABEL } from "@/lib/metrics/pace";
import { getPace } from "@/lib/services/pace";
import { pct, pts } from "@/lib/format";
import type { Fiche } from "./context";

/** Revenu net mensuel et rythme de réservation face au marché. */
export async function Performance({ user, p, input, today, now, names, hasHistory, hasCal, kpis, period, trend }: Fiche) {
  const stats = windowStats(input.days, today);
  const pace = input.days.length > 0 ? new Map((await getPace(user.tenantId, p.id, now)).windows.map((w) => [w.key, w])) : new Map<string, Awaited<ReturnType<typeof getPace>>["windows"][number]>();
  const lead = leadTimes(input.resas), los = medianLos(input.resas);
  return (
    <>
          {!hasHistory && !hasCal && <div className="empty"><h3>Pas encore de données</h3><p>Le revenu mensuel et le rythme de réservation apparaissent dès que les intégrations sont connectées.</p></div>}
          {hasHistory && (
            <section className="section">
              <h2>Revenu net mensuel</h2>
              <p className="section-note">Chaque nuit est rattachée à son mois de séjour. Tendance du revenu net par nuit disponible : <strong>{trend ?? "inconnue"}</strong> (trois derniers mois comparés aux trois premiers).</p>
              <BarChart title="Revenu net d'hébergement par mois" unit={`Euros · ${period}${p.isDemo ? " · hors ménage et taxes de séjour" : " · montant total des réservations, net de commissions"}`} data={kpis.map((k) => ({ label: fmtMonthShort(k.month), full: fmtMonth(k.month), cents: k.netCents, note: `occupation ${pct(k.occupancy)}` }))} />
            </section>
          )}
          {hasCal && (
            <section className="section">
              <h2>Rythme de réservation face au marché</h2>
              <p className="section-note">Relevé par l'analyste marché sur les cinq fenêtres canoniques. Un écart négatif n'est pas un ordre de baisser : il ouvre un diagnostic. Pickup et « face à l'an dernier » sont calculés sur les réservations lues (SuperHote) ; « Logement » vient du calendrier : les deux peuvent légèrement différer.</p>
              <div className="table-wrap"><table className="econ">
                <thead><tr><th scope="col"><Term id="fenetre-reservation">Fenêtre</Term></th><th scope="col" className="num">Logement</th><th scope="col" className="num"><Term id="occupation-marche">Marché</Term></th><th scope="col" className="num"><Term id="ecart-marche">Écart</Term></th><th scope="col" className="num">Nuits libres</th><th scope="col" className="num"><Term id="position-de-prix">Position de prix</Term></th><th scope="col" className="num">Pickup 7 j</th><th scope="col">Face à l'an dernier</th></tr></thead>
                <tbody>{stats.map((s) => (
                  <tr key={s.key}><th scope="row">{s.label}<span className="src">{fmtDay(s.from)} → {fmtDay(addDays(s.to, -1))}</span></th>
                    <td className="num">{pct(s.occupancy)}</td><td className="num">{s.marketOccupancy === null ? <Vq>inconnu</Vq> : pct(s.marketOccupancy)}</td>
                    <td className="num">{s.gap === null ? "—" : pts(s.gap)}</td><td className="num">{s.free}</td><td className="num">{s.avgPercentile === null ? "—" : s.avgPercentile + "e pct."}</td>
                    <td className="num" data-testid="pickup-7">{pace.get(s.key) ? `${pace.get(s.key)!.pickup[7]} nuit${pace.get(s.key)!.pickup[7] > 1 ? "s" : ""}` : "—"}</td>
                    <td data-testid="pace-status">{(() => { const w = pace.get(s.key); if (!w) return "—"; return w.status === "UNKNOWN" ? <Vq>inconnu{w.unknownReason ? ` : ${PACE_REASON_LABEL[w.unknownReason]}` : ""}</Vq> : `${PACE_STATUS_LABEL[w.status]} (${w.gapPoints! > 0 ? "+" : ""}${Math.round(w.gapPoints! * 100)} pts)`; })()}</td></tr>
                ))}</tbody></table></div>
              <p className="kpi-note"><Byline agent="marche" names={names} what={`délai de réservation ${lead ? `médian ${lead.median} j` : "inconnu"} · durée médiane ${los ? los + " nuits" : "inconnue"}`} /></p>
            </section>
          )}
    </>
  );
}
