import Link from "next/link";
import { and, eq, inArray } from "drizzle-orm";
import { Page } from "@/components/Page";
import { Banner, Metric, State, Vq } from "@/components/ui";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { fmtDateTime, todayISO } from "@/lib/dates";
import { lastMonths } from "@/lib/engine/metrics";
import { STATE_LABEL, type ActionState } from "@/lib/engine/stateMachine";
import { PROVIDER_INFO, providerStatus, type ProviderStatus } from "@/lib/integrations/capabilities";
import { PROPERTY_STATUS as STATUS } from "@/lib/labels";
import { pct } from "@/lib/format";
import { listOpportunities, listProperties } from "@/lib/queries";
import { portfolioOccupation, summarizePortfolio } from "@/lib/portfolio-summary";
import { loadProviderFacts } from "@/lib/services/capabilities";
import { ingestionErrorCount } from "@/lib/services/ingestion-errors";
import type { InboxItem } from "@/lib/inbox";

export const metadata = { title: "Tableau de bord" };
const ST: Record<ProviderStatus, [string, "sain" | "tech" | "attention" | "neutre"]> = { DEMO: ["Source simulée", "tech"], CONNECTED: ["Connectée", "sain"], NOT_CONNECTED: ["Non connectée", "neutre"], DEGRADED: ["Dégradée", "attention"] };
const WAITING = ["APPROVED", "EXECUTED", "FAILED"] as const;

export default async function Portefeuille() {
  const user = await requireUser();
  const today = todayISO();
  const [props, opps, acts, facts, ingestErrors, resas] = await Promise.all([
    listProperties(user.tenantId),
    listOpportunities(user.tenantId, ["OPEN"]),
    db.select({ status: schema.revenueActions.status, opportunityId: schema.revenueActions.opportunityId, label: schema.revenueActions.label, propertyId: schema.revenueActions.propertyId, updatedAt: schema.revenueActions.updatedAt })
      .from(schema.revenueActions).where(and(eq(schema.revenueActions.tenantId, user.tenantId), inArray(schema.revenueActions.status, [...WAITING]))),
    loadProviderFacts(user.tenantId),
    ingestionErrorCount(user.tenantId),
    db.select().from(schema.reservations).where(eq(schema.reservations.tenantId, user.tenantId)),
  ]);
  const s = summarizePortfolio(props, opps as InboxItem[], acts, today);
  const pname = new Map(props.map((p) => [p.id, p.name]));
  const sortedActs = [...acts].sort((a, b) => +b.updatedAt - +a.updatedAt);
  const waiting = sortedActs.slice(0, 10);
  // code du dossier de chaque action en attente, pour y mener directement
  const codes = new Map((waiting.length ? await db.select({ id: schema.opportunities.id, code: schema.opportunities.code }).from(schema.opportunities).where(and(eq(schema.opportunities.tenantId, user.tenantId), inArray(schema.opportunities.id, waiting.map((a) => a.opportunityId)))) : []).map((o) => [o.id, o.code]));
  // occupation des trois derniers mois complets, tous logements observés confondus
  const months = lastMonths(today, 3);
  const occ = portfolioOccupation(props, resas as never, months);
  const capped = opps.length >= 200; // listOpportunities plafonne à 200 dossiers
  const kill = (["superhote", "pricelabs"] as const).some((p) => facts[p].killSwitch);

  if (props.length === 0) {
    return (
      <Page title="Tableau de bord" sub="Portefeuille" crumbs={[{ label: "Tableau de bord" }]}>
        <div className="page-head"><h1>Votre portefeuille est vide</h1><p>Le tableau de bord se remplit dès le premier logement.</p></div>
        <div className="empty"><h3>Aucun logement</h3><p style={{ marginBottom: 16 }}>Ajoutez votre premier logement pour commencer.</p><Link className="btn btn-primary" href="/logements/nouveau">Ajouter un logement</Link></div>
      </Page>
    );
  }
  return (
    <Page title="Tableau de bord" sub={`${s.properties} logement${s.properties > 1 ? "s" : ""}`} crumbs={[{ label: "Tableau de bord" }]}>
      <div className="page-head">
        <h1>{s.open === 0 ? "Rien à arbitrer sur le portefeuille" : `${s.open} situation${s.open > 1 ? "s" : ""} à arbitrer sur ${s.properties} logement${s.properties > 1 ? "s" : ""}`}</h1>
        {capped && <Banner role="tech" title="Portefeuille volumineux" style={{ marginBottom: 14 }}>Les listes sont limitées à 200 dossiers : les totaux ci-dessous peuvent être partiels.</Banner>}
        <p>Vue d'ensemble : ce qui attend une décision, ce qui attend une exécution ou une vérification, et l'état des connexions. Chaque chiffre mène à la liste qui le détaille.</p>
      </div>
      {kill && <Banner role="attention" title="Coupe-circuit actif" style={{ marginBottom: 14 }}>L'écriture automatique par API est bloquée sur au moins une intégration. <Link href="/integrations">Voir les intégrations</Link></Banner>}

      <section className="section" aria-labelledby="pf-decider">
        <h2 id="pf-decider">À décider</h2>
        <div className="synth" data-testid="pf-decider">
          <Link href="/" className="metric-link"><Metric label="Situations ouvertes" value={s.open} source="Ouvrir la boîte d'opportunités" /></Link>
          <Link href="/?u=veto" className="metric-link"><Metric label="Sous veto" value={s.vetoes} tone={s.vetoes ? "veto" : undefined} source="Décision économique bloquée" /></Link>
          <Link href="/?u=urgent" className="metric-link"><Metric label="Séjours urgents" value={s.urgent} source="En cours ou sous 14 jours" /></Link>
          <Link href="/?u=renforcee" className="metric-link"><Metric label="Validation renforcée" value={s.reinforced} source="L'auditeur demande un commentaire" /></Link>
        </div>
      </section>

      <section className="section" aria-labelledby="pf-actions">
        <h2 id="pf-actions">Actions en attente</h2>
        <div className="synth synth-fit" data-testid="pf-actions">
          <Metric label="À exécuter" value={s.actions.toExecute} source="Approuvées, pas encore appliquées" />
          <Metric label="À vérifier" value={s.actions.toVerify} source="Exécutées, relecture externe attendue" />
          <Metric label="En échec" value={s.actions.failed} tone={s.actions.failed ? "veto" : undefined} source="Exécution ou vérification échouée" />
        </div>
        {sortedActs.length > waiting.length && <p className="foot" style={{ margin: "10px 0 0" }}>Et {sortedActs.length - waiting.length} autre{sortedActs.length - waiting.length > 1 ? "s" : ""} action{sortedActs.length - waiting.length > 1 ? "s" : ""} en attente : les plus récentes sont listées.</p>}
        {waiting.length === 0 ? <p className="muted" style={{ margin: "10px 0 0" }}>Aucune action n'attend d'exécution ni de vérification.</p> : (
          <ul className="timeline" style={{ marginTop: 12 }}>{waiting.map((a) => (
            <li key={a.opportunityId + a.status}><span className={`tl-dot ${a.status === "FAILED" ? "is-attention" : "is-tech"}`} aria-hidden="true" /><div>
              <span className="tl-when">{pname.get(a.propertyId) ?? "Logement"} · {fmtDateTime(a.updatedAt)}</span>
              <p className="tl-what">{codes.get(a.opportunityId) ? <Link href={`/dossier/${codes.get(a.opportunityId)}`}>{a.label}</Link> : a.label}</p>
              <p className="tl-who"><State role={a.status === "FAILED" ? "attention" : "tech"}>{STATE_LABEL[a.status as ActionState]}</State></p></div></li>
          ))}</ul>
        )}
      </section>

      <section className="section" aria-labelledby="pf-logements">
        <h2 id="pf-logements">Logements</h2>
        <p className="section-note">Classés : veto d'abord, puis urgence, puis nombre de situations ouvertes.</p>
        <div className="table-wrap"><table className="econ" data-testid="pf-logements">
          <thead><tr><th scope="col">Logement</th><th scope="col">État</th><th scope="col" className="num">Ouvertes</th><th scope="col" className="num">Veto</th><th scope="col" className="num">Urgentes</th></tr></thead>
          <tbody>{s.rows.map((r) => { const [label] = STATUS[r.status] ?? STATUS.ONBOARDING; return (
            <tr key={r.id}><th scope="row"><Link href={`/logements/${r.id}`}>{r.name}</Link>{r.isDemo && <span className="src">démonstration</span>}</th><td>{label}</td>
              <td className="num">{r.open > 0 ? <Link href={`/?p=${r.id}`}>{r.open}</Link> : 0}</td><td className="num">{r.vetoes > 0 ? <Link href={`/?p=${r.id}&u=veto`}>{r.vetoes}</Link> : 0}</td><td className="num">{r.urgent > 0 ? <Link href={`/?p=${r.id}&u=urgent`}>{r.urgent}</Link> : 0}</td></tr>
          ); })}</tbody></table></div>
      </section>

      <section className="section" aria-labelledby="pf-kpi">
        <h2 id="pf-kpi">Performance récente</h2>
        <div className="synth synth-fit" data-testid="pf-kpi">
          <Metric label="Occupation · 3 derniers mois" value={occ.rate !== null ? pct(occ.rate) : <Vq>inconnue</Vq>} source={occ.rate !== null ? `${occ.nights} nuits vendues sur ${occ.available} disponibles · ${occ.properties} logement${occ.properties > 1 ? "s" : ""} avec historique` : "Aucun historique de réservations lu"} />
        </div>
        <p className="foot">Le détail par logement, le revenu net et sa tendance sont dans chaque fiche logement. <Link href="/bilan">Bilan mensuel</Link> · <Link href="/rapports">Rapports mensuels</Link></p>
      </section>

      <section className="section" aria-labelledby="pf-integr">
        <h2 id="pf-integr">Santé des intégrations</h2>
        <div className="table-wrap"><table className="econ" data-testid="pf-integrations">
          <thead><tr><th scope="col">Intégration</th><th scope="col">État</th><th scope="col">Dernière synchronisation</th></tr></thead>
          <tbody>{(["superhote", "pricelabs"] as const).map((p) => { const f = facts[p]; const [label, role] = ST[providerStatus(p, f)]; return (
            <tr key={p}><th scope="row">{PROVIDER_INFO[p].name}</th><td><State role={f.killSwitch ? "attention" : role}>{f.killSwitch ? "Coupe-circuit actif" : label}</State></td><td>{f.lastSyncAt ? fmtDateTime(f.lastSyncAt) : <Vq>aucune</Vq>}</td></tr>
          ); })}</tbody></table></div>
        <p className="foot">{ingestErrors > 0 ? <><State role="attention">{ingestErrors} erreur{ingestErrors > 1 ? "s" : ""} d'ingestion SuperHote</State> <Link href="/integrations/erreurs">Les examiner</Link></> : "Aucune erreur d'ingestion SuperHote en attente."} <Link href="/integrations">Détail des intégrations</Link></p>
      </section>
    </Page>
  );
}
