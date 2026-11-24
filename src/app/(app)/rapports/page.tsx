import Link from "next/link";
import { Page } from "@/components/Page";
import { ReportStart } from "@/components/ReportStart";
import { Banner, State } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { fmtDate, fmtMonth, todayISO } from "@/lib/dates";
import { can, denyMessage, rolesWith, ROLE_LABEL } from "@/lib/rbac";
import { reportableMonths } from "@/lib/reports/monthly";
import { listProperties } from "@/lib/queries";
import { listReports } from "@/lib/services/reports";

export const metadata = { title: "Rapports mensuels" };

export default async function Rapports({ searchParams }: { searchParams: Promise<{ logement?: string }> }) {
  const user = await requireUser();
  const props = await listProperties(user.tenantId);
  const sel = (await searchParams).logement;
  const p = props.find((x) => x.id === sel) ?? props[0];
  const crumbs = [{ label: "Analyse" }, { label: "Rapports mensuels" }];
  if (!p) return <Page title="Rapports mensuels" crumbs={crumbs}><div className="empty"><h3>Aucun logement</h3><p>Les rapports apparaissent dès qu'un logement a un historique.</p></div></Page>;
  const rows = await listReports(user.tenantId, p.id);
  const months = reportableMonths(todayISO()).map((m) => ({ value: m, label: fmtMonth(m) }));
  const canWrite = can(user.role, "report.certify");
  const hasDraft = new Set(rows.filter((r) => r.status === "DRAFT").map((r) => r.month));
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
        {canWrite && rows.some((r) => r.status === "CERTIFIED") && <p className="muted" style={{ marginTop: 8 }}>Sur un mois déjà certifié, la préparation ouvre une nouvelle version ; la version certifiée reste intacte.</p>}
      </section>
      <section className="section" data-testid="rapports-liste">
        <h2>Rapports existants</h2>
        {rows.length === 0 ? <p className="muted">Aucun rapport pour ce logement : choisissez un mois ci-dessus.</p> : (
          <div className="table-wrap"><table className="econ"><thead><tr><th scope="col">Mois</th><th scope="col">Version</th><th scope="col">État</th><th scope="col">Certifié</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} data-testid="rapport-ligne" data-status={r.status}>
                <th scope="row"><Link href={`/rapports/${r.id}`}>{fmtMonth(r.month)}</Link></th>
                <td>{r.version}</td>
                <td>{r.status === "CERTIFIED" ? <State role="sain">Certifié</State> : <State role="attention">Brouillon</State>}{r.status === "CERTIFIED" && hasDraft.has(r.month) && <span className="src">une nouvelle version est en brouillon</span>}</td>
                <td>{r.certifiedAt ? `${fmtDate(todayISO(r.certifiedAt))} · ${r.certifiedByName ?? ""}` : "—"}</td>
              </tr>))}</tbody></table></div>
        )}
      </section>
    </Page>
  );
}
