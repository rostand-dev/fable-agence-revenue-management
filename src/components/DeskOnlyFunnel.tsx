import Link from "next/link";
import { viewHref } from "@/lib/nav";
import type { ViewContext } from "@/lib/view-mode";
import { DeskOnly } from "./DeskOnly";
import { Icon, Logo } from "./Icon";

/** Mode poche : le parcours de création (sans l'ossature `Page`) remplacé par l'encart. Aucun formulaire n'est rendu, rien n'est à enregistrer. */
export function DeskOnlyFunnel({ title, view }: { title: string; view: ViewContext & { blocked: NonNullable<ViewContext["blocked"]> } }) {
  return (
    <>
      <header className="fn-top">
        <Link className="fn-brand" href="/logements" aria-label="NuitSignal — retour aux logements"><Logo width={132} /></Link>
        <span className="fn-title">{title}</span>
        <div className="fn-top-right"><Link href={view.blocked.back} className="btn btn-ghost btn-sm"><Icon name="back" />Quitter</Link></div>
      </header>
      <main className="fn-wrap" id="contenu">
        <DeskOnly view={view} />
        {/* le parcours n'a ni barre basse ni menu : la bascule de version est proposée à toutes les largeurs */}
        <p className="pk-foot"><a href={viewHref("complet", view.current)}>Version complète</a></p>
      </main>
    </>
  );
}
