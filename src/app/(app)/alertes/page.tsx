import { and, eq, inArray } from "drizzle-orm";
import { Page } from "@/components/Page";
import { AlertCard } from "@/components/AlertCard";
import { Banner } from "@/components/ui";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { emailConfigured } from "@/lib/email/resend";
import { can } from "@/lib/rbac";
import { bySeverity, listAlerts } from "@/lib/services/execution-alerts";

export const metadata = { title: "Alertes d'exécution" };

/** US-094 : ce qui s'est mal passé ou a changé chez PriceLabs après une écriture. Les alertes ouvertes d'abord, les critiques en tête. */
export default async function Alertes() {
  const user = await requireUser();
  const { active, resolved } = await listAlerts(user.tenantId);
  const all = [...active, ...resolved];
  const propIds = [...new Set(all.map((a) => a.propertyId).filter((x): x is string => !!x))];
  const actIds = [...new Set(all.map((a) => a.actionId).filter((x): x is string => !!x))];
  const [props, acts] = await Promise.all([
    propIds.length ? db.select({ id: schema.properties.id, name: schema.properties.name }).from(schema.properties).where(and(eq(schema.properties.tenantId, user.tenantId), inArray(schema.properties.id, propIds))) : [],
    actIds.length ? db.select({ id: schema.revenueActions.id, opp: schema.revenueActions.opportunityId }).from(schema.revenueActions).where(and(eq(schema.revenueActions.tenantId, user.tenantId), inArray(schema.revenueActions.id, actIds))) : [],
  ]);
  const opps = acts.length ? await db.select({ id: schema.opportunities.id, code: schema.opportunities.code }).from(schema.opportunities).where(and(eq(schema.opportunities.tenantId, user.tenantId), inArray(schema.opportunities.id, acts.map((a) => a.opp)))) : [];
  const pname = new Map(props.map((p) => [p.id, p.name]));
  const codeOf = new Map(acts.map((a) => [a.id, opps.find((o) => o.id === a.opp)?.code ?? null]));
  const canAct = can(user.role, "action.rollback"), emailOn = emailConfigured();
  const open = active.filter((a) => a.status === "OPEN").sort(bySeverity), acked = active.filter((a) => a.status === "ACKNOWLEDGED").sort(bySeverity);
  const card = (a: (typeof all)[number]) => <AlertCard key={a.id} alert={a} property={a.propertyId ? pname.get(a.propertyId) : undefined} code={a.actionId ? codeOf.get(a.actionId) : null} canAct={canAct} emailOn={emailOn} />;
  return (
    <Page title="Alertes d'exécution" sub="Échecs d'écriture, écarts chez PriceLabs et actions bloquées" crumbs={[{ label: "Alertes d'exécution" }]}>
      <div className="page-head"><h1>Alertes d'exécution</h1></div>
      {open.length === 0 && <Banner role="sain" icon="check" title="Aucune alerte à traiter">Rien ne demande votre attention : les écritures PriceLabs sont conformes à ce qui a été approuvé.</Banner>}
      {open.length > 0 && (
        <section className="section" aria-labelledby="open-h" style={{ marginTop: 0 }}>
          <h2 id="open-h">À traiter <span className="muted">({open.length})</span></h2>
          <div className="alert-list">{open.map(card)}</div>
        </section>
      )}
      {acked.length > 0 && (
        <section className="section" aria-labelledby="ack-h">
          <h2 id="ack-h">Prises en compte <span className="muted">({acked.length})</span></h2>
          <p className="muted">Elles restent visibles tant que la situation n'est pas revenue à la normale (retour arrière, relecture conforme).</p>
          <div className="alert-list">{acked.map(card)}</div>
        </section>
      )}
      {resolved.length > 0 && (
        <section className="section" aria-labelledby="res-h">
          <h2 id="res-h">Résolues récemment</h2>
          <div className="alert-list">{resolved.map(card)}</div>
        </section>
      )}
    </Page>
  );
}
