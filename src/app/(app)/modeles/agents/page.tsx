import Link from "next/link";
import { saveAgentModelsAction } from "@/app/actions/llm";
import { renameAgentsAction } from "@/app/actions/settings";
import { AgentModelSelect } from "@/components/AgentModelSelect";
import { Avatar } from "@/components/Avatar";
import { CapBanner } from "@/components/CapBanner";
import { ActionForm, Submit } from "@/components/forms";
import { Icon } from "@/components/Icon";
import { Page } from "@/components/Page";
import { AUTO_LABEL, getLlmStatus, selectableModels } from "@/lib/agents/llm-config";
import { AGENTS } from "@/lib/agents/registry";
import { requireUser } from "@/lib/auth";
import { getCapState } from "@/lib/llm-registry/cap-state";
import { RightsNotice } from "@/components/Rights";

export const metadata = { title: "Agents" };
export default async function Agents() {
  const user = await requireUser();
  const names: Record<string, string> = user.settings.agentNames ?? {};
  const models: Record<string, string> = user.settings.agentModels ?? {};
  const [llm, cap] = await Promise.all([getLlmStatus(user.tenantId), getCapState(user.tenantId)]);
  return (
    <Page title="Agents" sub="Prénom et modèle de chaque agent" crumbs={[{ label: "Paramètres", href: "/parametres" }, { label: "IA & modèles", href: "/modeles" }, { label: "Agents" }]}>
      <p style={{ margin: "0 0 16px" }}><Link className="btn btn-ghost btn-sm" href="/modeles"><Icon name="back" />Retour à IA &amp; modèles</Link></p>
      <div className="page-head"><h1>Agents</h1><p>Le prénom et le modèle de langage de chaque agent de l'équipe.</p></div>
      <RightsNotice need="workspace.manage" />
      <CapBanner cap={cap} />
      <section className="section" id="equipe-ia" style={{ marginTop: 0 }}>
        <h2>Prénoms de l'équipe</h2>
        <p className="section-note">Le prénom se modifie ; le poste, les droits et les limites ne changent pas.</p>
        <ActionForm need="workspace.manage" action={renameAgentsAction}>
          <div className="form-grid">
            {AGENTS.map((a) => (
              <div className="field" key={a.id}>
                <label htmlFor={"agent-" + a.id} style={{ display: "flex", alignItems: "center", gap: 10 }}><Avatar agent={a.id} size={30} />{a.title}</label>
                <input id={"agent-" + a.id} name={"agent-" + a.id} type="text" maxLength={24} defaultValue={names[a.id] ?? a.name} />
              </div>
            ))}
          </div>
          <div style={{ marginTop: 16 }}><Submit icon="check">Enregistrer les prénoms</Submit></div>
        </ActionForm>
      </section>
      <section className="section" id="modeles-agents">
        <h2>Modèles par agent</h2>
        <p className="section-note">Chaque agent peut utiliser son propre modèle de langage. Par défaut, « Automatique » : le routeur prend le modèle le moins cher qui convient parmi vos fournisseurs. Un choix manuel prime toujours ; la liste vient de vos clés API. Les postes à règles gardent des calculs déterministes ; leur modèle sert à leur conversation. Prix et qualification : <Link href="/modeles/catalogue">Catalogue</Link> ; plafond et coûts : <Link href="/modeles/budget">Budget</Link>.</p>
        {llm.source === "utilisateur" ? (
          <ActionForm need="workspace.manage" action={saveAgentModelsAction}>
            <div className="form-grid">
              {AGENTS.map((a) => (
                <div className="field" key={a.id}>
                  <label htmlFor={"model-" + a.id} style={{ display: "flex", alignItems: "center", gap: 10 }}><Avatar agent={a.id} size={30} />{a.title}</label>
                  <AgentModelSelect id={"model-" + a.id} name={"model-" + a.id} models={selectableModels(llm)} current={models[a.id]} defaultLabel={AUTO_LABEL} />
                </div>
              ))}
            </div>
            <div style={{ marginTop: 16 }}><Submit icon="check" pendingLabel="Enregistrement…">Enregistrer les modèles</Submit></div>
          </ActionForm>
        ) : (
          <p className="muted">Pour choisir un modèle par agent, <Link href="/modeles/cles">saisissez d'abord une clé API</Link> : la liste des modèles dépend d'elle.</p>
        )}
      </section>
    </Page>
  );
}
