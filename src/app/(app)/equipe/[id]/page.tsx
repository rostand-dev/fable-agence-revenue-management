import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { chatAction } from "@/app/actions/decisions";
import { Avatar } from "@/components/Avatar";
import { ActionForm, Submit } from "@/components/forms";
import { Icon } from "@/components/Icon";
import { Page } from "@/components/Page";
import { Recap, State } from "@/components/ui";
import { db, schema } from "@/db";
import { llmEnabled, llmModel } from "@/lib/agents/llm";
import { AGENT_BY_ID, agentName, WORKFLOWS, type AgentId } from "@/lib/agents/registry";
import { requireUser } from "@/lib/auth";
import { fmtDateTime } from "@/lib/dates";

const TABS = [["poste", "Fiche de poste"], ["workflows", "Workflows"], ["activite", "Activité"], ["conversation", "Conversation"]] as const;

export default async function Fiche({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const a = AGENT_BY_ID[id as AgentId];
  if (!a) notFound();
  const tab = (await searchParams).tab ?? "poste";
  const names = user.settings.agentNames ?? null, name = agentName(a.id, names);
  const [runs, talk] = await Promise.all([
    db.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.tenantId, user.tenantId), eq(schema.agentRuns.agentId, a.id))).orderBy(desc(schema.agentRuns.createdAt)).limit(40),
    db.select().from(schema.chatMessages).where(and(eq(schema.chatMessages.tenantId, user.tenantId), eq(schema.chatMessages.agentId, a.id), isNull(schema.chatMessages.opportunityId))).orderBy(asc(schema.chatMessages.createdAt)).limit(60),
  ]);
  const usesLlm = a.reasoning !== "Règles déterministes";
  const tokens = runs.reduce((s, r) => s + (r.inputTokens ?? 0) + (r.outputTokens ?? 0), 0);
  const flows = WORKFLOWS.filter((w) => w.steps.some((s) => s.agent === a.id));
  return (
    <Page title="Équipe IA" sub={`${a.title} · fiche agent`} crumbs={[{ label: "Équipe", href: "/equipe" }, { label: `${name} · ${a.short}` }]}>
      <p style={{ margin: "0 0 16px" }}><Link className="btn btn-ghost btn-sm" href="/equipe"><Icon name="back" />Retour à l'équipe</Link></p>
      <div className="agent-head">
        <Avatar agent={a.id} size={96} />
        <div className="agent-id">
          <span className="agent-name" style={{ fontSize: 22 }}>{name}</span>
          <span className="agent-role">{a.title} · pôle {a.pole.toLowerCase()}</span>
          <p style={{ margin: "8px 0 0", fontSize: 13.5, color: "var(--quiet)", maxWidth: "62ch" }}>{a.mission}</p>
        </div>
        <div className="idsync">
          <span className="badge badge-verif"><Icon name="check" />Actif</span>
          <span className="read-date"><Icon name="clock" />{runs[0] ? `Dernière intervention : ${fmtDateTime(runs[0].createdAt)}` : "Aucune intervention"}</span>
        </div>
      </div>
      <div className="subnav" role="tablist" aria-label="Sections de la fiche agent" style={{ marginBottom: 20 }}>
        {TABS.map(([k, l]) => <Link key={k} role="tab" aria-selected={tab === k} className="subnav-link" href={`/equipe/${a.id}?tab=${k}`} scroll={false}>{l}</Link>)}
      </div>

      {tab === "poste" && (
        <div className="stack">
          <Recap rows={[
            ["Poste", a.title], ["Rend compte à", a.reportsTo ? agentName(a.reportsTo, names) + " · direction" : a.id === "audit" ? "Vous — indépendant de la direction" : "Vous"],
            ["Cadence", a.cadence], ["Droits d'écriture", a.rights],
            ["Mode de raisonnement", a.reasoning], ["Modèle de langage", usesLlm ? (llmEnabled() ? llmModel() : "non configuré — repli déterministe") : "aucun : ce poste n'utilise pas de modèle de langage"],
          ]} />
          <div className="blocks" style={{ ["--cols" as any]: 2 }}>
            <div className="block block-faits"><h3>Responsabilités</h3><ul className="muted" style={{ margin: "8px 0 0", paddingLeft: 18, display: "grid", gap: 6 }}>{a.responsibilities.map((r) => <li key={r}>{r}</li>)}</ul></div>
            <div className="block block-interpretations"><h3>Limites du poste</h3><ul className="muted" style={{ margin: "8px 0 0", paddingLeft: 18, display: "grid", gap: 6 }}>{a.limits.map((r) => <li key={r}>{r}</li>)}</ul></div>
            <div className="block block-comparaisons"><h3>Ce qu'il reçoit</h3><ul className="muted" style={{ margin: "8px 0 0", paddingLeft: 18, display: "grid", gap: 6 }}>{a.inputs.map((r) => <li key={r}>{r}</li>)}</ul></div>
            <div className="block block-comparaisons"><h3>Ce qu'il livre</h3><ul className="muted" style={{ margin: "8px 0 0", paddingLeft: 18, display: "grid", gap: 6 }}>{a.deliverables.map((r) => <li key={r}>{r}</li>)}</ul></div>
          </div>
        </div>
      )}
      {tab === "workflows" && (
        <div className="stack" style={{ ["--gap" as any]: "22px" }}>
          {flows.map((w) => (
            <section key={w.id}>
              <h2 style={{ fontSize: 17, margin: "0 0 2px" }}>{w.name}</h2><p className="muted" style={{ margin: "0 0 10px" }}>{w.cadence} · {w.purpose}</p>
              <ol className="flow">{w.steps.map((s, i) => (
                <li key={i} style={s.agent === a.id ? { background: "rgb(37 99 235 / 12%)" } : undefined}><span className="n">{i + 1}</span>
                  <span className={`who${s.agent === "vous" ? " is-you" : ""}`}>{s.agent === "vous" ? "Vous" : <><Avatar agent={s.agent} size={24} />{agentName(s.agent, names)}</>}</span><span>{s.what}</span></li>
              ))}</ol>
            </section>
          ))}
        </div>
      )}
      {tab === "activite" && (
        <div className="stack">
          <Recap rows={[["Interventions récentes", String(runs.length), true], ["Dont avec modèle de langage", String(runs.filter((r) => r.mode === "LLM").length), true], ["Jetons consommés", tokens ? tokens.toLocaleString("fr-FR") : "aucun", true], ["En erreur", String(runs.filter((r) => r.error).length), true]]} />
          {runs.length === 0 ? <p className="muted">Aucune intervention enregistrée.</p> : (
            <ul className="timeline">{runs.map((r) => (
              <li key={r.id}><span className={`tl-dot ${r.error ? "is-attention" : r.mode === "LLM" ? "is-tech" : "is-sain"}`}><Icon name={r.error ? "alert" : "check"} /></span>
                <div><span className="tl-when">{fmtDateTime(r.createdAt)} · {r.operation} · {r.mode === "LLM" ? `modèle ${r.model}` : "règles"}</span><p className="tl-what">{r.summary}</p>{r.error && <p className="tl-who">Repli : {r.error}</p>}</div></li>
            ))}</ul>
          )}
        </div>
      )}
      {tab === "conversation" && (
        <div className="agent-talk">
          <header><h3><Icon name="chat" />Échanger avec {name}</h3><p>{llmEnabled() ? "Les réponses sont des interprétations fondées sur son poste et son activité récente." : "Aucune clé API renseignée : " + name + " répond par règles, sur son rôle, ses limites et sa cadence."}</p></header>
          <div className="talk-log" role="log" aria-live="polite">
            {talk.length === 0 && <p className="muted" style={{ margin: 0 }}>Aucun échange pour l'instant.</p>}
            {talk.map((m) => <div key={m.id} className={`talk-turn${m.role === "user" ? " is-me" : ""}`}><span className="talk-who">{m.role === "user" ? "Vous" : name}</span><div className="talk-bubble">{m.content}{m.role !== "user" && <span className="talk-mark">{m.mode === "LLM" ? "modèle de langage" : "composée par règles"} · {fmtDateTime(m.createdAt)}</span>}</div></div>)}
          </div>
          <div className="talk-form">
            <div className="talk-shortcuts">{["Quel est ton rôle ?", "Quelles sont tes limites ?", "À quelle cadence travailles-tu ?"].map((q) => <ActionForm key={q} action={chatAction} hidden={{ agentId: a.id, opportunityId: "", question: q }} className="inline"><Submit className="btn btn-ghost btn-sm" pendingLabel="…">{q}</Submit></ActionForm>)}</div>
            <ActionForm action={chatAction} hidden={{ agentId: a.id, opportunityId: "" }}>
              <div className="talk-row"><label className="visually-hidden" htmlFor="q">Votre question</label><textarea id="q" name="question" rows={1} placeholder={`Écrire à ${name}…`} required /><Submit icon="send" pendingLabel="Envoi…">Envoyer</Submit></div>
            </ActionForm>
          </div>
        </div>
      )}
      {tab !== "conversation" && <p style={{ marginTop: 20 }}><State role="neutre">{a.reasoning}</State></p>}
    </Page>
  );
}
