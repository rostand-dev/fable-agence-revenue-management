import { GlossaryExplorer } from "@/components/GlossaryExplorer";
import { Page } from "@/components/Page";
import { requireUser } from "@/lib/auth";
import { GLOSSARY } from "@/lib/glossary";

export const metadata = { title: "Glossaire" };

export default async function Glossaire() {
  await requireUser();
  return (
    <Page title="Glossaire" sub="Les mots du revenue management, en clair" crumbs={[{ label: "Agence IA" }, { label: "Glossaire" }]}>
      <div className="page-head">
        <h1>Le vocabulaire de l'agence, sans jargon</h1>
        <p>{GLOSSARY.length} termes expliqués avec des mots simples et un exemple chiffré. Les mots soulignés en pointillés dans l'application ouvrent la même explication d'un toucher. Les chiffres des exemples sont inventés pour se calculer de tête : ils ne décrivent pas vos logements.</p>
      </div>
      <GlossaryExplorer />
    </Page>
  );
}
