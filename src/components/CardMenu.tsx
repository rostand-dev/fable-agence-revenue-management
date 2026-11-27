"use client";
import { useDismissableDetails } from "./useDismissableDetails";

/** Menu « … » d'une carte du mode poche : un seul ouvert à la fois, refermé par Échap, un appui ailleurs ou un changement d'adresse. */
export function CardMenu({ label, children }: { label: string; children: React.ReactNode }) {
  const box = useDismissableDetails();
  return (
    <details className="pk-menu" name="pk-menu" ref={box}>
      <summary className="btn btn-ghost" aria-label={label}><span aria-hidden="true">…</span></summary>
      <div className="pk-menu-list">{children}</div>
    </details>
  );
}
