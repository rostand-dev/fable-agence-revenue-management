"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { Icon } from "./Icon";

/** « Gérer le logement » : les actions sur le dossier, repliées. Se ferme avec Échap, un clic ailleurs ou un changement d'écran. */
export function ManageMenu({ propertyId, canEdit, canDelete }: { propertyId: string; canEdit: boolean; canDelete: boolean }) {
  const box = useRef<HTMLDetailsElement>(null);
  const path = usePathname(), query = useSearchParams().toString();
  useEffect(() => { if (box.current) box.current.open = false; }, [path, query]);
  useEffect(() => {
    const outside = (e: PointerEvent) => { if (box.current?.open && !box.current.contains(e.target as Node)) box.current.open = false; };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !box.current?.open) return;
      box.current.open = false;
      box.current.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, []);
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
