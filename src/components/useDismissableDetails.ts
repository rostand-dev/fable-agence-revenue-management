"use client";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

/** Menu replié dans un `<details>` : se ferme avec Échap (le résumé reprend le focus), un appui ailleurs ou un changement d'adresse. */
export function useDismissableDetails() {
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
  return box;
}
