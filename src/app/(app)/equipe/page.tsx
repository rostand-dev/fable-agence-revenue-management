import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import { Page } from "@/components/Page";
import { db, schema } from "@/db";
import { AGENTS, agentName } from "@/lib/agents/registry";
import { requireUser } from "@/lib/auth";
import { fmtDateTime } from "@/lib/dates";

export const metadata = { title: "Équipe" };
export default async function Equipe() {
  const user = await requireUser();
  const names = user.settings.agentNames ?? null;
  const runs = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.tenantId, user.tenantId)).orderBy(desc(schema.agentRuns.createdAt)).limit(400);
  const last = (id: string) => runs.find((r) => r.agentId === id);
  const direct = AGENTS.filter((a) => a.reportsTo === "direction");
  return (
    <Page title="Équipe IA" sub="Huit postes · un agent par poste" crumbs={[{ label: "Équipe" }]}>
      <div className="page-head">
        <h1>Votre agence</h1>
        <p>Huit postes, comme dans une agence de revenue management. Chacun a une mission, des droits et des limites. Le prénom se modifie dans Réglages, le rôle ne change pas. Aucun agent n'est mis en avant par la couleur.</p>
      </div>
      <div className="roster">
        {AGENTS.map((a) => {
          const l = last(a.id);
          return (
            <Link className="agent-card" href={`/equipe/${a.id}`} key={a.id}>
              <Avatar agent={a.id} size={76} />
              <span className="agent-id">
                <span className="agent-name">{agentName(a.id, names)}</span>
                <span className="agent-role">{a.title}</span>
                <span className="agent-foot"><span className="badge badge-verif"><Icon name="check" />Actif</span><span className="metric-source">{l ? fmtDateTime(l.createdAt) : a.cadence}</span></span>
              </span>
            </Link>
          );
        })}
      </div>
      <section className="section">
        <h2>Organisation</h2>
        <p className="section-note">La direction coordonne six spécialistes. L'auditeur est indépendant : il ne rend compte qu'à vous, et son veto ne se contourne pas.</p>
        <div className="org">
          <div className="org-row" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
            <div className="org-node" style={{ borderColor: "rgb(96 165 250 / 45%)" }}><Icon name="home" size={22} /><span className="t"><strong>Vous · propriétaire</strong><span>Approuve, rejette, diffère. Seule autorité de décision.</span></span></div>
          </div>
          <div className="org-row">
            {(["direction", "audit"] as const).map((id) => { const a = AGENTS.find((x) => x.id === id)!; return <Link key={id} className="org-node" href={`/equipe/${id}`}><Avatar agent={id} size={40} /><span className="t"><strong>{agentName(id, names)}</strong><span>{a.title}{id === "audit" ? " · indépendant" : ""}</span></span></Link>; })}
          </div>
          <div className="org-row org-row-3">
            {direct.map((a) => <Link key={a.id} className="org-node" href={`/equipe/${a.id}`}><Avatar agent={a.id} size={40} /><span className="t"><strong>{agentName(a.id, names)}</strong><span>{a.short} · pôle {a.pole.toLowerCase()}</span></span></Link>)}
          </div>
        </div>
        <p style={{ marginTop: 16 }}><Link className="btn btn-ghost btn-sm" href="/methode"><Icon name="book" />Voir les workflows de l'agence</Link></p>
      </section>
      <p className="foot">Les avatars sont des illustrations identiques en traitement. Ils représentent un rôle, pas une personne réelle.</p>
    </Page>
  );
}
