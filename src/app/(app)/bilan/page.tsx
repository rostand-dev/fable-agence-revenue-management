import Link from "next/link";
import { and, eq, gte } from "drizzle-orm";
import { Page } from "@/components/Page";
import { Banner, Byline, Metric, Vq } from "@/components/ui";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { fmtMonth, todayISO } from "@/lib/dates";
import { lastMonths, monthlyKpis } from "@/lib/engine/metrics";
import { CHANNEL_LABEL } from "@/lib/engine/types";
import { euro, pct } from "@/lib/format";
import { listOpportunities, listProperties } from "@/lib/queries";

export const metadata = { title: "Bilan mensuel" };
const trend = (cur: number, prev: number) => (prev === 0 ? "sans référence" : cur > prev * 1.03 ? "croissante" : cur < prev * 0.97 ? "décroissante" : "stable");

export default async function Bilan({ searchParams }: { searchParams: Promise<{ logement?: string }> }) {
  const user = await requireUser();
  const props = await listProperties(user.tenantId);
  const sel = (await searchParams).logement;
  const p = props.find((x) => x.id === sel) ?? props[0];
  const names = user.settings.agentNames ?? null;
  if (!p) return <Page title="Bilan mensuel" crumbs={[{ label: "Analyse" }, { label: "Bilan mensuel" }]}><div className="empty"><h3>Aucun logement</h3><p>Le bilan apparaît dès qu'un logement a un historique.</p></div></Page>;
  const [m0, m1] = lastMonths(todayISO(), 2);
  const resas = await db.select().from(schema.reservations).where(and(eq(schema.reservations.propertyId, p.id), gte(schema.reservations.checkOut, m0 + "-01")));
  const [prev, cur] = monthlyKpis(resas, [m0, m1]);
  const opps = (await listOpportunities(user.tenantId, ["OPEN", "DECIDED"])).filter((o) => o.propertyId === p.id);
  const month = opps.filter((o) => o.status === "DECIDED" && o.createdAt.toISOString().slice(0, 7) >= m1);
  const open = opps.filter((o) => o.status === "OPEN");
  const has = cur.nights > 0;
  const mix = Object.entries(cur.byChannel).sort((a, b) => b[1] - a[1]);
  return (
    <Page title="Bilan mensuel" sub={`${p.name} · ${fmtMonth(m1)}`} crumbs={[{ label: "Analyse" }, { label: "Bilan mensuel" }]}>
      <div className="filters" role="group" aria-label="Choisir le logement">{props.map((x) => <Link key={x.id} className="chip" href={`/bilan?logement=${x.id}`} aria-current={x.id === p.id ? "true" : undefined}>{x.name}</Link>)}</div>
      <div className="page-head">
        <h1>{p.name} — {fmtMonth(m1)}</h1>
        <p>Dernier mois complet. Les faits marquants d'abord, la tendance nommée ensuite ; le détail reste accessible dans la fiche du logement.</p>
        <p style={{ marginTop: 10 }}><Byline agent="reporting" names={names} what="a assemblé ce bilan à partir des métriques certifiées, sans modèle de langage" /></p>
      </div>
      {!has ? <Banner role="tech" title="Aucune réservation sur ce mois">Le bilan ne peut pas être établi : l'historique de ce logement est vide ou non connecté. Aucun chiffre n'est estimé à la place.</Banner> : (
        <>
          <div className="synth">
            <Metric label="Revenu net" value={euro(cur.netCents)} source={`Tendance ${trend(cur.netCents, prev.netCents)} · ${euro(prev.netCents)} le mois précédent`} />
            <Metric label="Occupation" value={pct(cur.occupancy)} source={`Tendance ${trend(cur.occupancy, prev.occupancy)} · ${pct(prev.occupancy)} le mois précédent`} />
            <Metric label="Prix moyen net" value={euro(cur.netAdrCents)} source={`Tendance ${trend(cur.netAdrCents ?? 0, prev.netAdrCents ?? 0)} · par nuit occupée`} />
            <Metric label="Revenu net par nuit disponible" value={euro(cur.netRevpanCents)} source={`Tendance ${trend(cur.netRevpanCents, prev.netRevpanCents)}`} />
          </div>
          <section className="section">
            <h2>Faits marquants</h2>
            <div className="blocks" style={{ ["--cols" as any]: 3 }}>
              <div className="block block-faits"><h3>Performance</h3><p className="muted" style={{ margin: "6px 0 0" }}>{cur.nights} nuits vendues sur {cur.available}. Le revenu net par nuit disponible est en tendance <strong>{trend(cur.netRevpanCents, prev.netRevpanCents)}</strong> par rapport à {fmtMonth(m0)}.</p></div>
              <div className="block block-comparaisons"><h3>Canaux</h3><p className="muted" style={{ margin: "6px 0 0" }}>{mix.map(([c, v]) => `${CHANNEL_LABEL[c] ?? c} ${pct(v / cur.netCents)}`).join(" · ")} du revenu net.</p></div>
              <div className="block block-interpretations"><h3>Décisions</h3><p className="muted" style={{ margin: "6px 0 0" }}>{month.length} décision{month.length > 1 ? "s" : ""} enregistrée{month.length > 1 ? "s" : ""} depuis le début du mois, dont {month.filter((o) => o.decision === "NO_ACTION").length} inaction{month.filter((o) => o.decision === "NO_ACTION").length > 1 ? "s" : ""} retenue{month.filter((o) => o.decision === "NO_ACTION").length > 1 ? "s" : ""}. Effet incrémental : <Vq>inconnu</Vq></p></div>
            </div>
          </section>
        </>
      )}
      <section className="section">
        <h2>Actions menées et résultats</h2>
        {month.length === 0 ? <p className="muted">Aucune décision sur la période.</p> : (
          <div className="table-wrap"><table className="econ"><thead><tr><th scope="col">Dossier</th><th scope="col">Décision</th><th scope="col">Résultat mesuré</th></tr></thead>
            <tbody>{month.map((o) => <tr key={o.id}><th scope="row"><Link href={`/dossier/${o.code}`}>{o.title}</Link><span className="src">{o.code}</span></th><td>{o.decision === "NO_ACTION" ? "Inaction retenue" : o.decision === "REJECTED" ? "Proposition rejetée" : o.action?.label ?? "Approuvée"}</td><td>{o.action?.measurement ? o.action.measurement.observed : <Vq>pas encore mesuré</Vq>}</td></tr>)}</tbody></table></div>
        )}
      </section>
      <section className="section">
        <h2>Décisions proposées et risques</h2>
        {open.length === 0 ? <p className="muted">Aucune situation ouverte : rien à décider sur ce logement.</p> : (
          <ul className="muted" style={{ paddingLeft: 18, display: "grid", gap: 6 }}>{open.map((o) => <li key={o.id}><Link href={`/dossier/${o.code}`}>{o.title}</Link> — {o.candidates[o.selected]?.label}{o.veto && " · veto en cours"}</li>)}</ul>
        )}
      </section>
      <p className="foot">Revenu net = hébergement après remises, moins commissions et frais de paiement ; hors ménage et taxes de séjour. Aucun chiffre de ce bilan ne provient d'un modèle de langage.{p.isDemo && " Logement de démonstration : données synthétiques."}</p>
    </Page>
  );
}
