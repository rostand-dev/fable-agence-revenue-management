import { viewHref } from "@/lib/nav";
import type { ViewContext } from "@/lib/view-mode";

/** Bas de page, sur un téléphone en version complète : le retour à la version allégée, sur la même adresse. */
export function PocketSwitch({ view }: { view: ViewContext }) {
  if (view.mode !== "complet" || !view.phone) return null;
  return <p className="pk-foot"><a href={viewHref("poche", view.current)}>Version allégée</a></p>;
}
