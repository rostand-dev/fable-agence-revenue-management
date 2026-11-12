import { Page } from "@/components/Page";
import { PropertyForm } from "@/components/PropertyForm";
import { Byline } from "@/components/ui";
import { requireUser } from "@/lib/auth";

export const metadata = { title: "Ajouter un logement" };
export default async function Nouveau() {
  const user = await requireUser();
  return (
    <Page title="Ajouter un logement" sub="Onboarding" crumbs={[{ label: "Logements", href: "/logements" }, { label: "Ajouter" }]}>
      <div className="page-head">
        <h1>Onboarding d'un logement</h1>
        <p>Ces informations permettent de calculer vos planchers économiques par canal et par durée de séjour. Un champ laissé vide reste « inconnu » : il n'est jamais remplacé par zéro. Vous pouvez enregistrer à tout moment et reprendre plus tard.</p>
        <p style={{ marginTop: 10 }}><Byline agent="onboarding" names={user.settings.agentNames} what="constitue le dossier avec vous" /></p>
      </div>
      <PropertyForm />
    </Page>
  );
}
