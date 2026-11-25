import Link from "next/link";
import { logoutEverywhereAction } from "@/app/actions/auth";
import { resetDemoAction } from "@/app/actions/decisions";
import { saveAgentModelsAction } from "@/app/actions/llm";
import { renameTenantAction } from "@/app/actions/portfolio";
import { renameAgentsAction, saveScoringAction } from "@/app/actions/settings";
import { IMPLEMENTED_PLAYBOOKS, PLAYBOOKS } from "@/lib/engine/playbooks";
import { EXECUTION_MODES, MODE_LABEL, RISK_LABEL, RISKS, resolveScoring, SCORING_LIMITS } from "@/lib/engine/scoring";
import { AgentModelSelect } from "@/components/AgentModelSelect";
import { FlagsPanel } from "@/components/FlagsPanel";
import { loadFlags } from "@/lib/services/flags";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { Avatar } from "@/components/Avatar";
import { ActionForm, Submit } from "@/components/forms";
import { Page } from "@/components/Page";
import { Recap } from "@/components/ui";
import { AUTO_LABEL, getLlmStatus, selectableModels } from "@/lib/agents/llm-config";
import { AGENTS } from "@/lib/agents/registry";
import { requireUser } from "@/lib/auth";
import { fmtDate } from "@/lib/dates";
import { rememberDaysFromEnv } from "@/lib/remember-policy";
import { can, PERMISSIONS, PERMISSION_LABEL, ROLE_LABEL, ROLE_SUMMARY } from "@/lib/rbac";

export const metadata = { title: "Réglages" };
export default async function Reglages() {
  const user = await requireUser();
  const names: Record<string, string> = user.settings.agentNames ?? {};
  const models: Record<string, string> = user.settings.agentModels ?? {};
  const llm = await getLlmStatus(user.tenantId);
  const scoring = resolveScoring(user.settings.scoring);
  const [flagRows, props] = await Promise.all([loadFlags(user.tenantId), db.select({ id: schema.properties.id, name: schema.properties.name }).from(schema.properties).where(eq(schema.properties.tenantId, user.tenantId)).orderBy(schema.properties.name)]);
  return (
    <Page title="Réglages" sub="Compte, équipe et démonstration" crumbs={[{ label: "Configuration" }, { label: "Réglages" }]}>
      <div className="page-head"><h1>Réglages</h1><p>Votre espace est isolé : vos logements, vos décisions et votre journal ne sont visibles que de vous.</p></div>
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
      <section className="section">
        <h2>Sécurité</h2>
        <p className="section-note">Si vous avez coché « Rester connecté » sur un appareil, il reste reconnu jusqu'à {rememberDaysFromEnv()} jours. « Se déconnecter partout » ferme toutes vos sessions et fait oublier tous vos appareils, celui-ci compris.</p>
        <ActionForm action={logoutEverywhereAction}><Submit className="btn btn-danger" icon="cross" pendingLabel="Déconnexion…">Se déconnecter partout</Submit></ActionForm>
      </section>
      <section className="section" id="priorisation" data-testid="priorisation">
        <h2>Priorisation des dossiers</h2>
        <p className="section-note">Les dossiers sont classés par : gain net attendu × confiance × urgence × poids du playbook − coût d'exécution − pénalité de risque. Ce classement organise le travail ; il ne contourne jamais un veto ni une approbation, et les dossiers sous veto restent en tête.</p>
        <p className="section-note">Laissez les valeurs par défaut tant que vous n'avez pas de raison de les changer (poids : 1 = neutre). Saisissez les décimales avec un point.</p>
        <ActionForm action={saveScoringAction}>
          <h3 className="sub">Poids par playbook</h3>
          <div className="form-grid">
            {IMPLEMENTED_PLAYBOOKS.map((c) => (
              <div className="field" key={c}>
                <label htmlFor={"w-" + c}>{c} · {PLAYBOOKS[c].label}</label>
                <input id={"w-" + c} name={"w-" + c} type="number" inputMode="decimal" step="0.1" min={SCORING_LIMITS.weight.min} max={SCORING_LIMITS.weight.max} defaultValue={scoring.strategicWeight[c]} />
              </div>
            ))}
          </div>
          <h3 className="sub">Pénalité selon le risque (points)</h3>
          <div className="form-grid">
            {RISKS.map((r) => (
              <div className="field" key={r}>
                <label htmlFor={"r-" + r}>Risque {RISK_LABEL[r]}</label>
                <input id={"r-" + r} name={"r-" + r} type="number" inputMode="decimal" step="1" min={SCORING_LIMITS.penalty.min} max={SCORING_LIMITS.penalty.max} defaultValue={scoring.riskPenalty[r]} />
              </div>
            ))}
          </div>
          <h3 className="sub">Coût d'exécution (euros)</h3>
          <div className="form-grid">
            {EXECUTION_MODES.filter((m) => m !== "NONE").map((m) => (
              <div className="field" key={m}>
                <label htmlFor={"c-" + m}>{MODE_LABEL[m][0].toUpperCase() + MODE_LABEL[m].slice(1)}</label>
                <input id={"c-" + m} name={"c-" + m} type="number" inputMode="decimal" step="1" min={SCORING_LIMITS.cost.min} max={SCORING_LIMITS.cost.max} defaultValue={scoring.executionCost[m]} />
              </div>
            ))}
          </div>
          <div className="btn-row" style={{ marginTop: 16 }}>
            <Submit icon="check" pendingLabel="Enregistrement…">Enregistrer la priorisation</Submit>
            <button type="submit" name="reset" value="1" className="btn" formNoValidate>Rétablir les valeurs par défaut</button>
          </div>
        </ActionForm>
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
      <section className="section">
        <h2>Démonstration</h2>
        <p className="section-note">Les deux logements de démonstration sont ancrés à une date. Les réinstaller efface leurs dossiers et repart d'aujourd'hui ; vos propres logements ne sont pas touchés.</p>
        <Recap rows={[["Ancrage actuel", user.settings.demoAnchor ? fmtDate(user.settings.demoAnchor) : "aucun", true]]} />
        {can(user.role, "decision.decide") && <ActionForm action={resetDemoAction} style={{ marginTop: 14 }}><Submit className="btn btn-danger" icon="undo" pendingLabel="Réinstallation…">Réinstaller la démonstration à la date du jour</Submit></ActionForm>}
      </section>
    </Page>
  );
}
