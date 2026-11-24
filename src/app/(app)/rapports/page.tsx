import Link from "next/link";
import { Page } from "@/components/Page";
import { ReportStart } from "@/components/ReportStart";
import { Banner, State } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { fmtDate, fmtMonth, todayISO } from "@/lib/dates";
import { can, denyMessage, rolesWith, ROLE_LABEL } from "@/lib/rbac";
import { reportableMonths } from "@/lib/reports/monthly";
import { listProperties } from "@/lib/queries";
import { activeFilters, filtersQuery, parseHistoryFilters } from "@/lib/reports/filters";
import { OUTCOME_LABEL, OUTCOMES } from "@/lib/experiments/outcome";
import { listMeasures, listReports } from "@/lib/services/reports";

export const metadata = { title: "Rapports mensuels" };

export default async function Rapports({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const props = await listProperties(user.tenantId);
  const sp = await searchParams;
  const sel = typeof sp.logement === "string" ? sp.logement : undefined;
  const f = parseHistoryFilters(sp);
  const p = props.find((x) => x.id === sel) ?? props[0];
  const crumbs = [{ label: "Analyse" }, { label: "Rapports mensuels" }];
  if (!p) return <Page title="Rapports mensuels" crumbs={crumbs}><div className="empty"><h3>Aucun logement</h3><p>Les rapports apparaissent dès qu'un logement a un historique.</p></div></Page>;
  const all = await listReports(user.tenantId, p.id);
  const rows = all.filter((r) => (!f.etat || r.status === f.etat) && (!f.annee || r.month.startsWith(f.annee + "-")));
  const measures = await listMeasures(user.tenantId, p.id, f);
  const years = Array.from(new Set([...Array.from({ length: 4 }, (_, i) => String(Number(todayISO().slice(0, 4)) - i)), ...(f.annee ? [f.annee] : [])])).sort().reverse();
  const qs = filtersQuery(f), nf = activeFilters(f);
  const months = reportableMonths(todayISO()).map((m) => ({ value: m, label: fmtMonth(m) }));
  const canWrite = can(user.role, "report.certify");
  const hasDraft = new Set(all.filter((r) => r.status === "DRAFT").map((r) => r.month));
  return (
    <Page title="Rapports mensuels" sub={p.name} crumbs={crumbs}>
      <div className="filters" role="group" aria-label="Choisir le logement">{props.map((x) => <Link key={x.id} className="chip" href={`/rapports?logement=${x.id}`} aria-current={x.id === p.id ? "true" : undefined}>{x.name}</Link>)}</div>
      <div className="page-head">
        <h1>Rapports mensuels — {p.name}</h1>
        <p>Un rapport par mois terminé : les faits marquants et la tendance nommée, certifiés par les métriques. Aucun chiffre n'y figure en dehors des métriques du mois, et un effet qui n'est pas mesuré est dit « inconnu ».</p>
      </div>
      <section className="section">
        <h2>Préparer un rapport</h2>
        {canWrite
          ? <ReportStart propertyId={p.id} months={months} label="Préparer ou actualiser le rapport" />
          : <div data-testid="rapport-reserve"><Banner role="tech" icon="shield" title="Lecture seule">{denyMessage(user.role, "report.certify")} Il est possible pour : {rolesWith("report.certify").map((r) => ROLE_LABEL[r].toLowerCase()).join(", ")}.</Banner></div>}
        {canWrite && all.some((r) => r.status === "CERTIFIED") && <p className="muted" style={{ marginTop: 8 }}>Sur un mois déjà certifié, la préparation ouvre une nouvelle version ; la version certifiée reste intacte.</p>}
      </section>
      <section className="section" data-testid="rapports-liste">
        <h2>Historique des rapports</h2>
        <form method="get" action="/rapports" className="inbox-filters" data-testid="rapports-filtres" aria-label="Affiner l'historique">
          <input type="hidden" name="logement" value={p.id} />
          <div className="field"><label htmlFor="f-etat">Rapports : état</label>
            <select id="f-etat" name="etat" defaultValue={f.etat ?? ""}><option value="">Tous</option><option value="CERTIFIED">Certifiés</option><option value="DRAFT">Brouillons</option></select></div>
          <div className="field"><label htmlFor="f-annee">Année (rapports et mesures)</label>
            <select id="f-annee" name="annee" defaultValue={f.annee ?? ""}><option value="">Toutes</option>{years.map((y) => <option key={y} value={y}>{y}</option>)}</select></div>
          <div className="field"><label htmlFor="f-res">Mesures : résultat</label>
            <select id="f-res" name="resultat" defaultValue={f.resultat ?? ""}><option value="">Tous</option>{OUTCOMES.map((o) => <option key={o} value={o}>{OUTCOME_LABEL[o]}</option>)}</select></div>
          <div className="btn-row"><button type="submit" className="btn btn-secondary btn-sm">Filtrer</button>{nf > 0 && <Link className="btn btn-ghost btn-sm" href={`/rapports?logement=${p.id}`} data-testid="rapports-reinit">Réinitialiser</Link>}</div>
        </form>
        <p className="muted" data-testid="rapports-compteur" style={{ margin: "8px 0" }}>{rows.length} rapport{rows.length > 1 ? "s" : ""} sur {all.length}{f.etat || f.annee ? " (filtres actifs)" : ""}.</p>
        {rows.length === 0 ? <p className="muted" data-testid="rapports-vide">{all.length === 0 ? "Aucun rapport pour ce logement : choisissez un mois ci-dessus." : "Aucun rapport ne correspond à ces filtres."}</p> : (
          <div className="table-wrap"><table className="econ"><thead><tr><th scope="col">Mois</th><th scope="col">Version</th><th scope="col">État</th><th scope="col">Certifié</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} data-testid="rapport-ligne" data-status={r.status}>
                <th scope="row"><Link href={`/rapports/${r.id}`}>{fmtMonth(r.month)}</Link></th>
                <td>{r.version}</td>
                <td>{r.status === "CERTIFIED" ? <State role="sain">Certifié</State> : <State role="attention">Brouillon</State>}{r.status === "CERTIFIED" && hasDraft.has(r.month) && <span className="src">une nouvelle version est en brouillon</span>}</td>
                <td>{r.certifiedAt ? `${fmtDate(todayISO(r.certifiedAt))} · ${r.certifiedByName ?? ""}` : "—"}</td>
              </tr>))}</tbody></table></div>
        )}
        <p style={{ marginTop: 10 }}><a className="btn btn-ghost btn-sm" data-testid="export-historique-rapports" href={`/api/rapports/historique?logement=${p.id}&type=rapports${qs ? "&" + qs : ""}`} download>Exporter l'historique des rapports (CSV)</a></p>
      </section>
      <section className="section" data-testid="mesures-liste">
        <h2>Historique des mesures</h2>
        <p className="muted">Résultat de chaque action refermée, tel que mesuré : le rythme observé après l'action, jamais un effet attribué.</p>
        {measures.length === 0 ? <p className="muted" data-testid="mesures-vide">{f.resultat || f.annee ? "Aucune mesure ne correspond à ces filtres." : "Aucune action mesurée pour ce logement."}</p> : (
          <div className="table-wrap"><table className="econ"><thead><tr><th scope="col">Dossier</th><th scope="col">Résultat</th><th scope="col">Mesuré le</th><th scope="col">Observé</th></tr></thead>
            <tbody>{measures.map((m) => <tr key={m.id} data-testid="mesure-ligne" data-outcome={m.outcome}>
              <th scope="row"><Link href={`/dossier/${m.code}`}>{m.label}</Link><span className="src">{m.code}{m.legacy ? " · mesure antérieure au suivi des expériences" : ""}</span></th>
              <td>{OUTCOME_LABEL[m.outcome]}</td><td>{fmtDate(todayISO(m.measuredAt))}</td><td>{m.summary}</td></tr>)}</tbody></table></div>
        )}
        <p style={{ marginTop: 10 }}><a className="btn btn-ghost btn-sm" data-testid="export-historique-mesures" href={`/api/rapports/historique?logement=${p.id}&type=mesures${qs ? "&" + qs : ""}`} download>Exporter l'historique des mesures (CSV)</a></p>
      </section>
    </Page>
  );
}
