import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { AgentChat } from "@/components/AgentChat";
import { Avatar } from "@/components/Avatar";
import { ActionForm, Submit } from "@/components/forms";
import { Icon } from "@/components/Icon";
import { Page } from "@/components/Page";
import { Recap, State } from "@/components/ui";
import { db, schema } from "@/db";
import { saveAgentModelAction } from "@/app/actions/llm";
import { AgentModelSelect } from "@/components/AgentModelSelect";
import { serverDefaultModel } from "@/lib/agents/llm";
import { effectiveModel, getLlmStatus } from "@/lib/agents/llm-config";
import { budgetLimits } from "@/lib/agents/budget";
import { FALLBACK_LABEL, tokensUsedToday } from "@/lib/agents/runner";
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
  const llm = await getLlmStatus(user.tenantId);
  const chosen: string | undefined = (user.settings.agentModels ?? {})[a.id];
  const effective = effectiveModel(llm.source, chosen, serverDefaultModel());
  const [usedToday, runs, talk] = await Promise.all([
    tokensUsedToday(user.tenantId),
    db.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.tenantId, user.tenantId), eq(schema.agentRuns.agentId, a.id))).orderBy(desc(schema.agentRuns.createdAt)).limit(40),
    db.select().from(schema.chatMessages).where(and(eq(schema.chatMessages.tenantId, user.tenantId), eq(schema.chatMessages.agentId, a.id), isNull(schema.chatMessages.opportunityId))).orderBy(asc(schema.chatMessages.createdAt)).limit(60),
  ]);
  const usesLlm = a.reasoning !== "Règles déterministes";
  const limits = budgetLimits();
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
            ["Mode de raisonnement", a.reasoning], ["Modèle de langage", effective ? effective + (chosen && llm.source === "utilisateur" ? " (choisi pour ce poste)" : " (par défaut)") : "non configuré — repli déterministe", true],
          ]} />
          <section className="stratum">
            <header><h3>Modèle de langage de {name}</h3></header>
            <div className="stratum-body">
              <p className="muted" style={{ margin: "0 0 12px" }}>{usesLlm ? "Ce modèle rédige les synthèses et répond dans la conversation de ce poste." : "Les calculs de ce poste restent déterministes : aucun modèle n'y intervient. Le modèle choisi sert uniquement à sa conversation."}</p>
              {llm.source === "utilisateur" ? (
                <ActionForm action={saveAgentModelAction} hidden={{ agentId: a.id }}>
                  <div className="field" style={{ maxWidth: 560 }}>
                    <label htmlFor="agent-model">Modèle</label>
                    <AgentModelSelect id="agent-model" name="model" models={llm.models} current={chosen} defaultLabel={`Modèle par défaut (${serverDefaultModel()})`} />
                    <span className="help">Liste des modèles disponibles avec votre clé API.</span>
                  </div>
                  <div style={{ marginTop: 12 }}><Submit icon="check" pendingLabel="Enregistrement…">Enregistrer le modèle</Submit></div>
                </ActionForm>
              ) : (
                <p className="muted" style={{ margin: 0 }}>Pour choisir un modèle, <Link href="/integrations">saisissez d'abord votre clé API Anthropic</Link> : la liste dépend d'elle.</p>
              )}
            </div>
          </section>
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
          <Recap rows={[["Interventions récentes", String(runs.length), true], ["Dont avec modèle de langage", String(runs.filter((r) => r.mode === "LLM").length), true], ["Jetons consommés", tokens ? tokens.toLocaleString("fr-FR") : "aucun", true], ["En erreur", String(runs.filter((r) => r.error).length), true], ["Budget de jetons du jour (tous agents)", limits.dailyTokens === 0 ? "appels de modèle désactivés" : `${usedToday.toLocaleString("fr-FR")} sur ${limits.dailyTokens.toLocaleString("fr-FR")}`, true]]} />
          {runs.length === 0 ? <p className="muted">Aucune intervention enregistrée.</p> : (
            <ul className="timeline">{runs.map((r) => (
              <li key={r.id}><span className={`tl-dot ${r.error ? "is-attention" : r.mode === "LLM" ? "is-tech" : "is-sain"}`}><Icon name={r.error ? "alert" : "check"} /></span>
                <div><span className="tl-when">{fmtDateTime(r.createdAt)} · {r.operation} · {r.mode === "LLM" ? `modèle ${r.model}${r.provider ? ` (${r.provider})` : ""}` : "règles"}</span><p className="tl-what">{r.summary}</p>
                  {r.promptId && <p className="tl-who" data-testid="trace-prompt">Prompt {r.promptId} · version {r.promptVersion}{r.attempts ? ` · ${r.attempts} appel${r.attempts > 1 ? "s" : ""}${r.repaired ? " (une correction)" : ""}` : ""}</p>}
                  {r.fallbackReason && <p className="tl-who" data-testid="trace-fallback">Repli : {FALLBACK_LABEL[r.fallbackReason] ?? r.fallbackReason}</p>}
                  {r.error && !r.fallbackReason && <p className="tl-who">Repli : {r.error}</p>}</div></li>
            ))}</ul>
          )}
        </div>
      )}
      {tab === "conversation" && (
        <div className="agent-talk">
          <header><h3><Icon name="chat" />Échanger avec {name}</h3><p>{llm.source !== "aucune" ? "Les réponses sont des interprétations fondées sur son poste et son activité récente." : "Aucune clé API renseignée : " + name + " répond par règles, sur son rôle, ses limites et sa cadence."}</p></header>
          <AgentChat agentId={a.id} opportunityId={null} agentLabel={name} inputId="q" placeholder={`Écrire à ${name}…`} emptyText="Aucun échange pour l'instant."
            shortcuts={["Quel est ton rôle ?", "Quelles sont tes limites ?", "À quelle cadence travailles-tu ?"]}
            initial={talk.map((m) => ({ id: m.id, role: m.role === "user" ? "user" as const : "agent" as const, content: m.content, mode: m.mode ?? null, createdAt: m.createdAt.toISOString() }))} />
        </div>
      )}
      {tab !== "conversation" && <p style={{ marginTop: 20 }}><State role="neutre">{a.reasoning}</State></p>}
    </Page>
  );
}
