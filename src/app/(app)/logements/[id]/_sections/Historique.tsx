import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { Icon } from "@/components/Icon";
import { Banner } from "@/components/ui";
import { db, schema } from "@/db";
import { withTenant } from "@/db/tenant";
import { propertyAuditTrail } from "@/lib/audit/query";
import { auditLabel } from "@/lib/audit/types";
import { fmtDateTime } from "@/lib/dates";
import { can, denyMessage } from "@/lib/rbac";
import type { Fiche } from "./context";

/** Chronologie du logement, lue dans le journal d'audit. */
export async function Historique({ user, p }: Fiche) {
  const canAudit = can(user.role, "audit.read");
  const trail = canAudit ? await withTenant(user.tenantId, (tx) => propertyAuditTrail(user.tenantId, p.id, 50, tx)) : [];
  const oppCode = new Map((canAudit ? await db.select({ id: schema.opportunities.id, code: schema.opportunities.code }).from(schema.opportunities).where(and(eq(schema.opportunities.tenantId, user.tenantId), eq(schema.opportunities.propertyId, p.id))) : []).map((o) => [o.id, o.code]));
  return (
        <section className="stack" data-testid="historique-logement">
          <h2 style={{ fontSize: 18, margin: 0 }}>Chronologie du logement</h2>
          <p className="section-note" style={{ margin: 0 }}>Ce que le journal d'audit a inscrit pour ce logement, ses dossiers et ses actions, du plus récent au plus ancien (50 derniers événements).</p>
          {!canAudit ? <Banner role="tech" icon="shield" title="Chronologie réservée">{denyMessage(user.role, "audit.read")}</Banner>
            : trail.length === 0 ? <div className="empty"><h3>Aucun événement</h3><p>Le journal n'a encore rien inscrit pour ce logement. Ce n'est pas une confirmation qu'il ne s'est rien passé avant l'arrivée du journal.</p></div> : (
              <ul className="timeline">{trail.map((e) => (
                <li key={e.id}><span className={`tl-dot ${e.type.includes("fail") || e.type.includes("rolled") ? "is-attention" : e.type.startsWith("action") ? "is-sain" : "is-tech"}`}><Icon name={e.type.startsWith("action") ? "check" : "dot"} /></span>
                  <div><span className="tl-when" title={e.type}>{fmtDateTime(e.createdAt)} · {auditLabel(e.type)}</span><p className="tl-what">{e.summary}</p>
                    {e.entity === "Opportunity" && oppCode.get(e.entityId) && <p className="tl-who"><Link href={`/dossier/${oppCode.get(e.entityId)}`}>Ouvrir le dossier {oppCode.get(e.entityId)}</Link></p>}</div></li>
              ))}</ul>
            )}
          <p className="foot"><Link href="/historique#journal">Journal d'audit complet</Link></p>
        </section>
  );
}
