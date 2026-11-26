import { FunnelHeader, FunnelStepper } from "@/components/Funnel";
import { LogementStep } from "@/components/FunnelSteps";
import { requireUser } from "@/lib/auth";
import { funnelView } from "@/lib/onboarding";
import { listOwners } from "@/lib/services/portfolio";
import { Reserved } from "@/components/Reserved";
import { can } from "@/lib/rbac";
import { DeskOnlyFunnel } from "@/components/DeskOnlyFunnel";
import { getViewContext } from "@/lib/view-mode";

export const metadata = { title: "Ajouter un logement" };
/** Étape 1 avant que le dossier n'existe : il est créé dès que l'on continue (ou que l'on enregistre pour plus tard). */
export default async function Nouveau() {
  const user = await requireUser();
  const view = await getViewContext();
  if (view.blocked) return <DeskOnlyFunnel title="Nouveau logement" view={{ ...view, blocked: view.blocked }} />;
  if (!can(user.role, "property.manage")) return <><FunnelHeader title="Nouveau logement" saved={null} quit="link" /><main className="fn-wrap" id="contenu"><Reserved role={user.role} need="property.manage" back={{ href: "/logements", label: "Retour aux logements" }} /></main></>;
  const owners = await listOwners(user.tenantId);
  const steps = funnelView({ identityOk: false, superhoteLinked: false, pricelabsLinked: false, economicsMissing: 1, onboarding: null }, "logement");
  return (
    <>
      <FunnelHeader title="Nouveau logement" saved="Pas encore enregistré" quit="form" />
      <main className="fn-wrap" id="contenu">
        <FunnelStepper steps={steps} href={() => "#"} />
        <LogementStep owners={owners} />
      </main>
    </>
  );
}
