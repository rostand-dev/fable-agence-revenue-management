import Link from "next/link";
import { eq } from "drizzle-orm";
import { logoutEverywhereAction } from "@/app/actions/auth";
import { saveAgentModelsAction } from "@/app/actions/llm";
import { renameTenantAction } from "@/app/actions/portfolio";
import { renameAgentsAction } from "@/app/actions/settings";
import { AgentModelSelect } from "@/components/AgentModelSelect";
import { Avatar } from "@/components/Avatar";
import { CapBanner } from "@/components/CapBanner";
import { FlagsPanel } from "@/components/FlagsPanel";
import { ActionForm, Submit } from "@/components/forms";
import { Page } from "@/components/Page";
import { Recap } from "@/components/ui";
import { db, schema } from "@/db";
import { AUTO_LABEL, getLlmStatus, selectableModels } from "@/lib/agents/llm-config";
import { AGENTS } from "@/lib/agents/registry";
import { requireUser } from "@/lib/auth";
import { getCapState } from "@/lib/llm-registry/cap-state";
import { can, PERMISSIONS, PERMISSION_LABEL, ROLE_LABEL, ROLE_SUMMARY } from "@/lib/rbac";
import { rememberDaysFromEnv } from "@/lib/remember-policy";
import { loadFlags } from "@/lib/services/flags";

export const metadata = { title: "Compte & sécurité" };
export default async function Compte() {
  const user = await requireUser();
  const names: Record<string, string> = user.settings.agentNames ?? {};
  const models: Record<string, string> = user.settings.agentModels ?? {};
  const [llm, cap] = await Promise.all([getLlmStatus(user.tenantId), getCapState(user.tenantId)]);
  const [flagRows, props] = await Promise.all([loadFlags(user.tenantId), db.select({ id: schema.properties.id, name: schema.properties.name }).from(schema.properties).where(eq(schema.properties.tenantId, user.tenantId)).orderBy(schema.properties.name)]);
  return (
    <Page title="Compte & sécurité" sub="Compte, droits, fonctions et équipe IA" crumbs={[{ label: "Paramètres", href: "/parametres" }, { label: "Compte & sécurité" }]}>
      <div className="page-head"><h1>Compte &amp; sécurité</h1><p>Votre espace est isolé : vos logements, vos décisions et votre journal ne sont visibles que de vous.</p></div>
      <section className="section" style={{ marginTop: 0 }}>
        <h2>Compte</h2>
        <Recap rows={[["Nom", user.name], ["Adresse e-mail", user.email, true], ["Rôle", ROLE_LABEL[user.role]]]} />
        <ActionForm action={renameTenantAction} style={{ marginTop: 18, maxWidth: 520 }}>
          <div className="field">
            <label htmlFor="tenantName">Nom de l'espace</label>
            <input id="tenantName" name="tenantName" type="text" required minLength={2} maxLength={80} defaultValue={user.tenantName} autoComplete="off" />
            <span className="help">Le nom sous lequel votre espace apparaît. La liste des personnes ou sociétés propriétaires des biens se gère dans <Link href="/proprietaires">Propriétaires</Link>.</span>
          </div>
          <div style={{ marginTop: 12 }}><Submit icon="check" pendingLabel="Enregistrement…">Enregistrer le nom</Submit></div>
        </ActionForm>
      </section>
      <section className="section" id="droits" data-testid="droits">
        <h2>Vos droits</h2>
        <p className="section-note"><strong>{ROLE_LABEL[user.role]}.</strong> {ROLE_SUMMARY[user.role]} Les droits s'appliquent au circuit de décision ; le serveur les vérifie à chaque action, et un refus est inscrit au journal d'audit.</p>
        <div className="table-wrap"><table className="econ">
          <caption className="visually-hidden">Ce que votre rôle permet</caption>
          <thead><tr><th scope="col">Action</th><th scope="col">Votre rôle</th></tr></thead>
          <tbody>{PERMISSIONS.map((p) => <tr key={p}><th scope="row">{PERMISSION_LABEL[p]}</th><td>{can(user.role, p) ? "Autorisé" : "Non autorisé"}</td></tr>)}</tbody>
        </table></div>
      </section>
      <section className="section" id="fonctions">
        <h2>Fonctions activées</h2>
        <p className="section-note">Chaque fonction est active par défaut. Vous pouvez la couper pour tout votre espace, pour un logement ou pour une intégration. Couper n'ouvre jamais rien de plus : un niveau coupé ne peut pas être rétabli par un niveau plus fin, et chaque changement est inscrit au journal.</p>
        <FlagsPanel rows={flagRows} properties={props} />
      </section>
      <section className="section" id="securite">
        <h2>Sécurité</h2>
        <p className="section-note">Si vous avez coché « Rester connecté » sur un appareil, il reste reconnu jusqu'à {rememberDaysFromEnv()} jours. « Se déconnecter partout » ferme toutes vos sessions et fait oublier tous vos appareils, celui-ci compris.</p>
        <ActionForm action={logoutEverywhereAction}><Submit className="btn btn-danger" icon="cross" pendingLabel="Déconnexion…">Se déconnecter partout</Submit></ActionForm>
      </section>
      <section className="section" id="equipe-ia">
        <h2>Équipe IA</h2>
        <p className="section-note">Les prénoms et les modèles de langage des agents.</p>
        <h3 className="sub">Prénoms de l'équipe</h3>
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
        <h3 className="sub" id="modeles-agents" style={{ marginTop: 28 }}>Modèles par agent</h3>
        <p className="section-note">Chaque agent peut utiliser son propre modèle de langage. Par défaut, « Automatique » : le routeur prend le modèle le moins cher qui convient parmi vos fournisseurs. Un choix manuel prime toujours ; la liste vient de vos clés API. Les postes à règles gardent des calculs déterministes ; leur modèle sert à leur conversation. Prix, qualification, plafond et coûts : <Link href="/modeles">IA & modèles</Link>.</p>
        <CapBanner cap={cap} />
        {llm.source === "utilisateur" ? (
          <ActionForm action={saveAgentModelsAction}>
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
          <p className="muted">Pour choisir un modèle par agent, <Link href="/integrations">saisissez d'abord votre clé API Anthropic</Link> dans Intégrations : la liste des modèles dépend d'elle.</p>
        )}
      </section>
    </Page>
  );
}
