import Link from "next/link";
import { notFound } from "next/navigation";
import { Page } from "@/components/Page";
import { ReportEditor } from "@/components/ReportEditor";
import { ReportStart } from "@/components/ReportStart";
import { Banner, Metric, State, Vq } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { fmtDate, fmtMonth, todayISO } from "@/lib/dates";
import { OUTCOME_LABEL, OUTCOME_REASON_LABEL, type OutcomeReason } from "@/lib/experiments/outcome";
import { euro, pct } from "@/lib/format";
import { can, denyMessage } from "@/lib/rbac";
import { MAX_NARRATIVE, type Trend } from "@/lib/reports/monthly";
import { getReport } from "@/lib/services/reports";
import { DeskNote } from "@/components/DeskOnly";
import { getViewContext } from "@/lib/view-mode";

export const metadata = { title: "Rapport mensuel" };
const tr = (t: Trend, ref: string | null) => (t === "inconnue" ? "Tendance inconnue" : `Tendance ${t}${ref ? ` · ${ref}` : ""}`);

export default async function Rapport({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const r = await getReport(user.tenantId, (await params).id);
  if (!r) notFound();
  const s = r.snapshot, k = s.kpis, certified = r.status === "CERTIFIED";
  const canWrite = can(user.role, "report.certify");
  const view = await getViewContext();
  // mode poche : le rapport se lit, il se rédige et se certifie sur ordinateur
  const pocket = view.mode === "poche";
  const prev = s.previous?.kpis;
  const m = fmtMonth(r.month);
  return (
    <Page title="Rapport mensuel" sub={`${s.property.name} · ${m}`} crumbs={[{ label: "Analyse" }, { label: "Rapports mensuels", href: "/rapports" }, { label: m }]}>
      <div className="page-head">
        <h1>{s.property.name} — {m}</h1>
        <p data-testid="rapport-etat">{certified ? <State role="sain">Certifié</State> : <State role="attention">Brouillon</State>} Version {r.version}{certified && r.certifiedAt ? ` · certifié le ${fmtDate(todayISO(r.certifiedAt))} par ${r.certifiedByName ?? "—"}` : ""}.</p>
        {certified && <p className="muted" data-testid="rapport-empreinte">Empreinte du contenu certifié : <code>{(r.certifiedHash ?? "").slice(0, 16)}</code></p>}
      </div>
      {s.property.isDemo && <Banner role="tech" title="Logement de démonstration" style={{ marginBottom: 12 }}>Ce rapport porte sur des données de démonstration : il ne décrit pas un vrai logement.</Banner>}
      {certified && <p className="btn-row" data-testid="rapport-exports"><a className="btn btn-secondary btn-sm" href={`/api/rapports/${r.id}/export?format=pdf`} download>Exporter en PDF</a> <a className="btn btn-secondary btn-sm" href={`/api/rapports/${r.id}/export?format=csv`} download>Exporter en CSV</a></p>}
      {!certified && <Banner role="attention" title="Brouillon : rien n'est certifié">{pocket ? "La relecture et la certification se font sur ordinateur." : "Relisez les chiffres et le texte, puis certifiez."} Les chiffres ci-dessous ont été lus le {fmtDate(todayISO(new Date(s.generatedAt)))}.</Banner>}
      {k.nights > 0 && k.netIncomplete && <Banner role="attention" title="Revenu net partiel" style={{ marginTop: 12 }}>La commission est inconnue sur certaines nuits vendues : leur revenu net n'est pas compté et les chiffres nets sont sous-évalués. Ils ne sont pas complétés par un zéro.</Banner>}
      <div className="synth" style={{ marginTop: 16 }} data-testid="rapport-metriques">
        <Metric label="Revenu net" value={k.netCents === null ? <Vq>inconnu</Vq> : euro(k.netCents)} source={tr(s.trends.net, prev?.netCents != null ? `${euro(prev.netCents)} le mois précédent` : null)} />
        <Metric label="Occupation" value={k.occupancy === null ? <Vq>inconnu</Vq> : pct(k.occupancy)} source={tr(s.trends.occupancy, prev?.occupancy != null ? `${pct(prev.occupancy)} le mois précédent` : null)} />
        <Metric label="Prix moyen net" value={k.netAdrCents === null ? <Vq>inconnu</Vq> : euro(k.netAdrCents)} source={tr(s.trends.netAdr, "par nuit occupée")} />
        <Metric label="Revenu net par nuit disponible" value={k.netRevpanCents === null ? <Vq>inconnu</Vq> : euro(k.netRevpanCents)} source={tr(s.trends.netRevpan, null)} />
      </div>
      <section className="section">
        <h2>Rapport</h2>
        {certified || !canWrite || pocket
          ? <div className="report-text" data-testid="rapport-texte">{r.narrative.split(/\n{2,}/).filter((x) => x.trim()).map((para, i) => <p key={i} style={{ whiteSpace: "pre-line" }}>{para}</p>)}</div>
          : <ReportEditor key={s.generatedAt} readOn={fmtDate(todayISO(new Date(s.generatedAt)))} reportId={r.id} propertyId={r.propertyId} month={r.month} narrative={r.narrative} edited={r.edited} max={MAX_NARRATIVE} />}
        {!certified && canWrite && pocket && <DeskNote current={view.current} />}
        {!certified && !canWrite && <Banner role="tech" icon="shield" title="Lecture seule">{denyMessage(user.role, "report.certify")}</Banner>}
      </section>
      <section className="section" data-testid="rapport-actions">
        <h2>Actions mesurées ce mois-ci</h2>
        {s.actions.length === 0 ? <p className="muted">Aucune action mesurée ce mois-ci.</p> : (
          <div className="table-wrap"><table className="econ"><thead><tr><th scope="col">Dossier</th><th scope="col">Résultat</th><th scope="col">Ce qui a été observé</th></tr></thead>
            <tbody>{s.actions.map((a) => <tr key={a.code}><th scope="row"><Link href={`/dossier/${a.code}`}>{a.label}</Link><span className="src">{a.code}</span></th>
              <td>{OUTCOME_LABEL[a.outcome]}{a.reasons.length > 0 && <span className="src">{a.reasons.map((x) => OUTCOME_REASON_LABEL[x as OutcomeReason] ?? x).join(" · ")}</span>}</td>
              <td>{a.summary}<span className="src">{a.interpretation}</span></td></tr>)}</tbody></table></div>
        )}
        <p className="muted" style={{ marginTop: 8 }}>Effet incrémental des actions : <Vq>inconnu</Vq> — sans période témoin, le rapport décrit ce qui s'est passé, pas ce que les actions ont causé.</p>
      </section>
      {certified && canWrite && (
        <section className="section">
          <h2>Corriger</h2>
          <p className="muted">Ce rapport est figé. Pour le corriger, ouvrez une nouvelle version : celle-ci reste intacte.</p>
          {pocket ? <DeskNote current={view.current} /> : <ReportStart propertyId={r.propertyId} months={[{ value: r.month, label: m }]} label="Ouvrir une nouvelle version" />}
        </section>
      )}
    </Page>
  );
}
