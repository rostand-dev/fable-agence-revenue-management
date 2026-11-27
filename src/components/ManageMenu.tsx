"use client";
import Link from "next/link";
import { Icon } from "./Icon";
import { useDismissableDetails } from "./useDismissableDetails";

/** « Gérer le logement » : les actions sur le dossier, repliées. Se ferme avec Échap, un clic ailleurs ou un changement d'écran. */
export function ManageMenu({ propertyId, canEdit, canDelete }: { propertyId: string; canEdit: boolean; canDelete: boolean }) {
  const box = useDismissableDetails();
  if (!canEdit && !canDelete) return null;
  return (
    <details className="manage-menu" ref={box}>
      <summary className="btn btn-ghost btn-sm"><Icon name="sliders" />Gérer le logement<span className="manage-chevron" aria-hidden="true"><Icon name="caret" /></span></summary>
      <ul>
        {canEdit && <li><Link href={`/logements/${propertyId}/modifier`}><Icon name="sliders" />Modifier le dossier</Link></li>}
        {canDelete && <li><Link href={`/logements/${propertyId}/supprimer`}><Icon name="cross" />Supprimer</Link></li>}
      </ul>
    </details>
  );
}
