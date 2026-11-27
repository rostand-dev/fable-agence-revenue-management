"use client";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

/**
 * Section repliée d'un dossier. `defaultOpen` ne vaut qu'à la première apparition : après un geste (déclarer, relire),
 * la section reste comme la personne l'a laissée, avec son message de retour visible.
 */
export function DossierFold({ id, label, defaultOpen = false, children }: { id: string; label: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open] = useState(defaultOpen);
  return (
    <details className="pk-fold" id={`pli-${id}`} data-testid={`pli-${id}`} open={open}>
      <summary><span>{label}</span><span className="pk-fold-chevron" aria-hidden="true"><Icon name="caret" /></span></summary>
      <div className="pk-fold-body">{children}</div>
    </details>
  );
}

/** Un lien vers une ancre rangée dans une section repliée (`#preuve-E1`) l'ouvre avant d'y mener, quel que soit le navigateur. */
export function RevealOnHash() {
  useEffect(() => {
    const reveal = (hash: string) => {
      let target: HTMLElement | null = null;
      try { target = document.getElementById(decodeURIComponent(hash.slice(1))); } catch { return; }
      if (!target) return;
      let opened = false;
      for (let el = target.parentElement; el; el = el.parentElement) {
        if (el instanceof HTMLDetailsElement && !el.open) { el.open = true; opened = true; }
      }
      if (opened) target.scrollIntoView();
    };
    const onHash = () => reveal(window.location.hash);
    // la même ancre touchée une seconde fois (section refermée entre-temps) ne change pas l'adresse
    const onClick = (e: MouseEvent) => {
      const hash = (e.target as Element).closest?.('a[href^="#"]')?.getAttribute("href");
      if (hash) setTimeout(() => reveal(hash));
    };
    onHash();
    window.addEventListener("hashchange", onHash);
    document.addEventListener("click", onClick);
    return () => { window.removeEventListener("hashchange", onHash); document.removeEventListener("click", onClick); };
  }, []);
  return null;
}

/**
 * Après un geste (approuver, rejeter, différer, rouvrir), le résultat s'affiche en haut du dossier : on y ramène la personne
 * et on y place le focus. Sans effet à l'arrivée sur la page, ni quand le serveur refuse (l'état ne change pas).
 */
export function ReturnToOutcome({ status }: { status: string }) {
  const seen = useRef(status);
  useEffect(() => {
    if (seen.current === status) return;
    seen.current = status;
    window.scrollTo({ top: 0, behavior: "instant" });
    (document.getElementById("pk-outcome") ?? document.getElementById("pk-title"))?.focus({ preventScroll: true });
  }, [status]);
  return null;
}
