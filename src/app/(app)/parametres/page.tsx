import { LegacyAnchor } from "@/components/LegacyAnchor";
import { Page } from "@/components/Page";
import { HubCards, type HubCard } from "@/components/PropertyHub";

export const metadata = { title: "Paramètres" };

/** `foot` : où se trouvait le réglage avant le regroupement, pour que personne ne le cherche. */
const CARDS: HubCard[] = [
  { key: "compte", href: "/parametres/compte", title: "Compte & sécurité", description: "Compte, vos droits, fonctions activées, sécurité, prénoms et modèles de l'équipe IA.", foot: "Vient de : Réglages › Compte, Vos droits, Fonctions activées, Sécurité, Prénoms de l'équipe, Modèles par agent" },
  { key: "proprietaires", href: "/proprietaires", title: "Propriétaires", description: "Les personnes et sociétés propriétaires des logements.", foot: "Vient de : Propriétaires (inchangé)" },
  { key: "integrations", href: "/integrations", title: "Intégrations", description: "Capacités de chaque connexion, coupe-circuit, clés des modèles et erreurs d'ingestion.", foot: "Vient de : Intégrations et ses erreurs d'ingestion" },
  { key: "modeles", href: "/modeles", title: "IA & modèles", description: "Modèles de langage, prix, plafond de dépense et coût du mois.", foot: "Vient de : Modèles" },
  { key: "priorisation", href: "/parametres/priorisation", title: "Priorisation des dossiers", description: "Poids par playbook, pénalité selon le risque, coût d'exécution.", foot: "Vient de : Réglages › Priorisation des dossiers" },
  { key: "demo", href: "/parametres/demo", title: "Démonstration", description: "Les logements de démonstration de votre espace.", foot: "Vient de : Réglages › Démonstration" },
];
/** Anciennes ancres de l'écran Réglages (`/reglages#…` redirige ici) vers la page qui porte la rubrique. */
const ANCHORS: Record<string, string> = {
  droits: "/parametres/compte", fonctions: "/parametres/compte", securite: "/parametres/compte", "equipe-ia": "/parametres/compte", "modeles-agents": "/parametres/compte",
  priorisation: "/parametres/priorisation",
};

export default function Parametres() {
  return (
    <Page title="Paramètres" sub="Six sujets, une page chacun" crumbs={[{ label: "Paramètres" }]}>
      <LegacyAnchor targets={ANCHORS} />
      <div className="page-head"><h1>Paramètres</h1><p>Six sujets, une page chacun. La ligne « Vient de » indique où se trouvait chaque réglage : rien n'est supprimé, tout est regroupé.</p></div>
      <HubCards label="Rubriques des paramètres" cards={CARDS} />
    </Page>
  );
}
