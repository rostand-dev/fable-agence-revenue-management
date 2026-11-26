import Link from "next/link";
import { viewHref } from "@/lib/nav";
import type { ViewContext } from "@/lib/view-mode";
import { ForceLink } from "./ForceLink";
import { Icon } from "./Icon";

/** Mode poche : encart affiché à la place d'un écran réservé à l'ordinateur. `heading` : « h2 » quand l'écran garde un contenu essentiel au-dessus. */
export function DeskOnly({ view, heading: Heading = "h1" }: { view: ViewContext & { blocked: NonNullable<ViewContext["blocked"]> }; heading?: "h1" | "h2" }) {
  return (
    <div className="pk-desk-only" data-testid="ecran-ordinateur">
      <div className="pk-card">
        <span className="pk-card-icon"><Icon name="screen" size={36} /></span>
        <Heading className="pk-card-title">Cet écran est conçu pour l'ordinateur</Heading>
        <p>{view.blocked.why} Rien ne presse : vos décisions restent possibles depuis le téléphone.</p>
        <Link href="/" className="btn btn-primary">Revenir aux opportunités</Link>
        <ForceLink className="btn btn-ghost" href={`/vue?afficher=${encodeURIComponent(view.pathname)}&retour=${encodeURIComponent(view.current)}`}>Afficher quand même</ForceLink>
      </div>
      <p className="pk-foot-note">Le choix « Afficher quand même » est retenu pour cet écran jusqu'à la fin de la session.</p>
    </div>
  );
}

/** Mode poche : à la place d'un formulaire de modification, sur un écran qui reste consultable. */
export function DeskNote({ current }: { current: string }) {
  return (
    <p className="pk-desk-note" data-testid="modification-ordinateur">
      <Icon name="screen" /> Modification sur ordinateur. <a href={viewHref("complet", current)}>Passer en version complète</a>
    </p>
  );
}
