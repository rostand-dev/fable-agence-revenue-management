import { FunnelHeader, FunnelStepper } from "@/components/Funnel";
import { LogementStep } from "@/components/FunnelSteps";
import { requireUser } from "@/lib/auth";
import { funnelView } from "@/lib/onboarding";

export const metadata = { title: "Ajouter un logement" };
/** Étape 1 avant que le dossier n'existe : il est créé dès que l'on continue (ou que l'on enregistre pour plus tard). */
export default async function Nouveau() {
  await requireUser();
  const steps = funnelView({ identityOk: false, superhoteLinked: false, pricelabsLinked: false, economicsMissing: 1, onboarding: null }, "logement");
  return (
    <>
      <FunnelHeader title="Nouveau logement" saved="Pas encore enregistré" quit="form" />
      <main className="fn-wrap" id="contenu">
        <FunnelStepper steps={steps} href={() => "#"} />
        <LogementStep />
      </main>
    </>
  );
}
