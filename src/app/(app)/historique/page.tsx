import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { Icon } from "@/components/Icon";
import { Page } from "@/components/Page";
import { Metric, OppStatus, State, Vq } from "@/components/ui";
import { db, schema } from "@/db";
import { agentName } from "@/lib/agents/registry";
import { requireUser } from "@/lib/auth";
import { fmtDateTime, fmtDay } from "@/lib/dates";
import { STATE_LABEL, type ActionState } from "@/lib/engine/stateMachine";
import { signedEuro } from "@/lib/format";
import { listOpportunities, listProperties } from "@/lib/queries";

export const metadata = { title: "Historique" };
const OUT: Record<string, [string, "sain" | "neutre" | "attention" | "tech"]> = { POSITIVE: ["Positif · corrélation", "sain"], NEUTRAL: ["Neutre", "neutre"], NEGATIVE: ["Négatif", "attention"], INCONCLUSIVE: ["Non concluant", "tech"] };

export default async function Historique() {
  const user = await requireUser();
  const names = user.settings.agentNames ?? null;
  const [props, opps, events] = await Promise.all([listProperties(user.tenantId), listOpportunities(user.tenantId, ["DECIDED", "DEFERRED", "EXPIRED"]), db.select().from(schema.auditEvents).where(eq(schema.auditEvents.tenantId, user.tenantId)).orderBy(desc(schema.auditEvents.createdAt)).limit(60)]);
  const pname = new Map(props.map((p) => [p.id, p.name]));
  const acts = opps.filter((o) => o.action).sort((a, b) => +b.action!.createdAt - +a.action!.createdAt);
  const measured = acts.filter((o) => o.action!.measurement);
  const count = (k: string) => measured.filter((o) => o.action!.measurement.outcome === k).length;
  const who = (actor: string) => actor.startsWith("agent:") ? agentName(actor.slice(6), names) : actor.startsWith("user:") ? "Vous" : actor === "demo" ? "Historique de démonstration" : "Système";
  return (
    <Page title="Historique" sub="Actions, mesures et journal d'audit" crumbs={[{ label: "Historique" }]}>
      <div className="page-head">
        <h1>Ce qui a été décidé, et ce que cela a produit</h1>
        <p>Chaque action garde son hypothèse, son exécution, sa vérification et son résultat mesuré. Exécuté, vérifié et réussi sont trois choses distinctes ; une réservation survenue après une action n'est pas présentée comme causée par elle.</p>
      </div>
      <div className="synth">
        <Metric label="Actions approuvées" value={acts.length} source="Toutes périodes" />
        <Metric label="Mesurées" value={measured.length} source={`${count("POSITIVE")} positive(s) · ${count("NEUTRAL")} neutre(s) · ${count("INCONCLUSIVE")} non concluante(s)`} />
        <Metric label="Inactions retenues" value={opps.filter((o) => o.decision === "NO_ACTION").length} source="Ne rien faire est une décision" />
        <Metric label="Effet incrémental attribué" value={<Vq>Inconnu</Vq>} source="Aucune période témoin : aucun gain n'est attribué" />
      </div>
      <section className="section">
        <h2>Actions et expériences</h2>
        <p className="section-note">Mémoire des playbooks : ce qui a été tenté, sur quel logement, avec quel résultat.</p>
        {acts.length === 0 ? <div className="empty"><h3>Aucune action</h3><p>Les actions approuvées apparaîtront ici avec leur mesure.</p></div> : (
          <div className="table-wrap"><table className="econ">
            <thead><tr><th scope="col">Action</th><th scope="col">Logement</th><th scope="col">Playbook</th><th scope="col" className="num">Simulé</th><th scope="col">État</th><th scope="col">Résultat mesuré</th></tr></thead>
            <tbody>{acts.map((o) => { const a = o.action!, m = a.measurement; return (
              <tr key={a.id}><th scope="row"><Link href={`/dossier/${o.code}`}>{a.label}</Link><span className="src">{o.code} · {fmtDay(o.stayFrom)} → {fmtDay(o.stayTo)}</span></th>
                <td>{pname.get(o.propertyId)}</td><td>{o.playbook}</td>
                <td className="num sim-cell">{a.simulation.expectedDeltaCents === null ? "n. c." : signedEuro(a.simulation.expectedDeltaCents)}</td>
                <td>{STATE_LABEL[a.status as ActionState]}</td>
                <td>{m ? <><State role={OUT[m.outcome]?.[1] ?? "neutre"}>{OUT[m.outcome]?.[0] ?? m.outcome}</State><span className="src">{m.observed}</span></> : <Vq>pas encore mesuré</Vq>}</td></tr>
            ); })}</tbody></table></div>
        )}
      </section>
      <section className="section">
        <h2>Autres décisions</h2>
        <ul className="timeline">{opps.filter((o) => !o.action).slice(0, 20).map((o) => (
          <li key={o.id}><span className="tl-dot is-tech"><Icon name="dot" /></span><div><span className="tl-when">{o.code} · {fmtDateTime(o.createdAt)} · {pname.get(o.propertyId)}</span><p className="tl-what"><Link href={`/dossier/${o.code}`}>{o.title}</Link></p><p className="tl-who"><OppStatus status={o.status} decision={o.decision} /></p></div></li>
        ))}{opps.filter((o) => !o.action).length === 0 && <li><div><p className="tl-who">Aucune.</p></div></li>}</ul>
      </section>
      <section className="section">
        <h2>Journal d'audit</h2>
        <p className="section-note">Journal en ajout seul des approbations, exécutions, vérifications et revues. Soixante dernières entrées.</p>
        <ul className="timeline">{events.map((e) => (
          <li key={e.id}><span className={`tl-dot ${e.type.includes("fail") || e.type.includes("rolled") ? "is-attention" : e.type.startsWith("action") ? "is-sain" : "is-tech"}`}><Icon name={e.type.startsWith("action") ? "check" : "dot"} /></span>
            <div><span className="tl-when">{fmtDateTime(e.createdAt)} · {e.type}</span><p className="tl-what">{e.summary}</p><p className="tl-who">{who(e.actor)}</p></div></li>
        ))}</ul>
      </section>
    </Page>
  );
}
