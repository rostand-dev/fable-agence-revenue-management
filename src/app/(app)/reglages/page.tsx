import { resetDemoAction } from "@/app/actions/decisions";
import { renameAgentsAction } from "@/app/actions/settings";
import { Avatar } from "@/components/Avatar";
import { ActionForm, Submit } from "@/components/forms";
import { Page } from "@/components/Page";
import { Recap } from "@/components/ui";
import { AGENTS } from "@/lib/agents/registry";
import { requireUser } from "@/lib/auth";
import { fmtDate } from "@/lib/dates";

export const metadata = { title: "Réglages" };
export default async function Reglages() {
  const user = await requireUser();
  const names: Record<string, string> = user.settings.agentNames ?? {};
  return (
    <Page title="Réglages" sub="Compte, équipe et démonstration" crumbs={[{ label: "Configuration" }, { label: "Réglages" }]}>
      <div className="page-head"><h1>Réglages</h1><p>Votre espace est isolé : vos logements, vos décisions et votre journal ne sont visibles que de vous.</p></div>
      <section className="section" style={{ marginTop: 0 }}>
        <h2>Compte</h2>
        <Recap rows={[["Nom", user.name], ["Adresse e-mail", user.email, true], ["Rôle", "Propriétaire — seule autorité d'approbation"]]} />
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
        <h2>Démonstration</h2>
        <p className="section-note">Les deux logements de démonstration sont ancrés à une date. Les réinstaller efface leurs dossiers et repart d'aujourd'hui ; vos propres logements ne sont pas touchés.</p>
        <Recap rows={[["Ancrage actuel", user.settings.demoAnchor ? fmtDate(user.settings.demoAnchor) : "aucun", true]]} />
        <ActionForm action={resetDemoAction} style={{ marginTop: 14 }}><Submit className="btn btn-danger" icon="undo" pendingLabel="Réinstallation…">Réinstaller la démonstration à la date du jour</Submit></ActionForm>
      </section>
    </Page>
  );
}
