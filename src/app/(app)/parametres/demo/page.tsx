import { resetDemoAction } from "@/app/actions/decisions";
import { ActionForm, Submit } from "@/components/forms";
import { Page } from "@/components/Page";
import { Recap } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { fmtDate } from "@/lib/dates";
import { can, denyMessage } from "@/lib/rbac";

export const metadata = { title: "Démonstration" };
export default async function Demonstration() {
  const user = await requireUser();
  return (
    <Page title="Démonstration" sub="Les logements de démonstration" crumbs={[{ label: "Paramètres", href: "/parametres" }, { label: "Démonstration" }]}>
      <section className="section" style={{ marginTop: 0 }}>
        <div className="page-head"><h1>Démonstration</h1></div>
        <p className="section-note">Les deux logements de démonstration sont ancrés à une date. Les réinstaller efface leurs dossiers et repart d'aujourd'hui ; vos propres logements ne sont pas touchés.</p>
        <Recap rows={[["Ancrage actuel", user.settings.demoAnchor ? fmtDate(user.settings.demoAnchor) : "aucun", true]]} />
        {can(user.role, "decision.decide") && <ActionForm action={resetDemoAction} style={{ marginTop: 14 }}><Submit className="btn btn-danger" icon="undo" pendingLabel="Réinstallation…">Réinstaller la démonstration à la date du jour</Submit></ActionForm>}
        {!can(user.role, "decision.decide") && <p className="muted">La réinstallation est réservée aux rôles qui décident. {denyMessage(user.role, "decision.decide")}</p>}
      </section>
    </Page>
  );
}
