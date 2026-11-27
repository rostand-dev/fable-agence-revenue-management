"use client";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { Icon } from "./Icon";

/** Mode poche : bouton « Filtrer » et feuille basse qui porte les filtres existants. Toute navigation la referme. */
export function FilterSheet({ active, children }: { active: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const path = usePathname(), query = useSearchParams().toString();
  useEffect(() => { ref.current?.close(); }, [path, query]);
  const onClick = (e: React.MouseEvent) => {
    // un lien (puce de statut) ferme tout de suite, même s'il mène à l'adresse déjà affichée ; un toucher sur le fond aussi
    if (e.target === ref.current || (e.target as HTMLElement).closest("a")) ref.current?.close();
  };
  return (
    <>
      <button type="button" className="chip pk-filter-open" aria-haspopup="dialog" onClick={() => ref.current?.showModal()}>
        <Icon name="sliders" />Filtrer{active > 0 ? ` · ${active}` : ""}
      </button>
      <dialog ref={ref} className="pk-filter-sheet" aria-labelledby="pk-filter-title" onClick={onClick}>
        <div className="pk-filter-body">
          <div className="pk-filter-head">
            <h2 id="pk-filter-title">Filtrer la liste</h2>
            <button type="button" className="btn btn-ghost" onClick={() => ref.current?.close()}>Fermer</button>
          </div>
          {children}
        </div>
      </dialog>
    </>
  );
}
