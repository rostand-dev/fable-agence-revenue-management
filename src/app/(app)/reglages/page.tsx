import Link from "next/link";
import { resetDemoAction } from "@/app/actions/decisions";
import { saveAgentModelsAction } from "@/app/actions/llm";
import { renameAgentsAction } from "@/app/actions/settings";
import { AgentModelSelect } from "@/components/AgentModelSelect";
import { FlagsPanel } from "@/components/FlagsPanel";
import { loadFlags } from "@/lib/services/flags";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { Avatar } from "@/components/Avatar";
import { ActionForm, Submit } from "@/components/forms";
import { Page } from "@/components/Page";
import { Recap } from "@/components/ui";
import { serverDefaultModel } from "@/lib/agents/llm";
import { getLlmStatus } from "@/lib/agents/llm-config";
import { AGENTS } from "@/lib/agents/registry";
import { requireUser } from "@/lib/auth";
import { fmtDate } from "@/lib/dates";

export const metadata = { title: "Réglages" };
export default async function Reglages() {
  const user = await requireUser();
  const names: Record<string, string> = user.settings.agentNames ?? {};
  const models: Record<string, string> = user.settings.agentModels ?? {};
  const llm = await getLlmStatus(user.tenantId);
  const [flagRows, props] = await Promise.all([loadFlags(user.tenantId), db.select({ id: schema.properties.id, name: schema.properties.name }).from(schema.properties).where(eq(schema.properties.tenantId, user.tenantId)).orderBy(schema.properties.name)]);
  return (
    <Page title="Réglages" sub="Compte, équipe et démonstration" crumbs={[{ label: "Configuration" }, { label: "Réglages" }]}>
      <div className="page-head"><h1>Réglages</h1><p>Votre espace est isolé : vos logements, vos décisions et votre journal ne sont visibles que de vous.</p></div>
      <section className="section" style={{ marginTop: 0 }}>
        <h2>Compte</h2>
        <Recap rows={[["Nom", user.name], ["Adresse e-mail", user.email, true], ["Rôle", "Propriétaire — seule autorité d'approbation"]]} />
      </section>
      <section className="section" id="fonctions">
        <h2>Fonctions activées</h2>
        <p className="section-note">Chaque fonction est active par défaut. Vous pouvez la couper pour tout votre espace, pour un logement ou pour une intégration. Couper n'ouvre jamais rien de plus : un niveau coupé ne peut pas être rétabli par un niveau plus fin, et chaque changement est inscrit au journal.</p>
        <FlagsPanel rows={flagRows} properties={props} />
      </section>
      <section className="section">
        <h2>Prénoms de l'équipe</h2>
        <p className="section-note">Le prénom se modifie ; le poste, les droits et les limites ne changent pas.</p>
        <ActionForm action={renameAgentsAction}>
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
      <section className="section">
        <h2>Modèles par agent</h2>
        <p className="section-note">Chaque agent peut utiliser son propre modèle de langage. La liste vient de votre clé API Anthropic : seuls les modèles qu'elle peut utiliser sont proposés. Les postes à règles gardent des calculs déterministes ; leur modèle sert à leur conversation.</p>
        {llm.source === "utilisateur" ? (
          <ActionForm action={saveAgentModelsAction}>
            <div className="form-grid">
              {AGENTS.map((a) => (
                <div className="field" key={a.id}>
                  <label htmlFor={"model-" + a.id} style={{ display: "flex", alignItems: "center", gap: 10 }}><Avatar agent={a.id} size={30} />{a.title}</label>
                  <AgentModelSelect id={"model-" + a.id} name={"model-" + a.id} models={llm.models} current={models[a.id]} defaultLabel={`Modèle par défaut (${serverDefaultModel()})`} />
                </div>
              ))}
            </div>
            <div style={{ marginTop: 16 }}><Submit icon="check" pendingLabel="Enregistrement…">Enregistrer les modèles</Submit></div>
          </ActionForm>
        ) : (
          <p className="muted">Pour choisir un modèle par agent, <Link href="/integrations">saisissez d'abord votre clé API Anthropic</Link> dans Intégrations : la liste des modèles dépend d'elle.</p>
        )}
      </section>
      <section className="section">
        <h2>Démonstration</h2>
        <p className="section-note">Les deux logements de démonstration sont ancrés à une date. Les réinstaller efface leurs dossiers et repart d'aujourd'hui ; vos propres logements ne sont pas touchés.</p>
        <Recap rows={[["Ancrage actuel", user.settings.demoAnchor ? fmtDate(user.settings.demoAnchor) : "aucun", true]]} />
        <ActionForm action={resetDemoAction} style={{ marginTop: 14 }}><Submit className="btn btn-danger" icon="undo" pendingLabel="Réinstallation…">Réinstaller la démonstration à la date du jour</Submit></ActionForm>
      </section>
    </Page>
  );
}
