"use client";
import Link from "next/link";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { GLOSSARY_BY_ID } from "@/lib/glossary";
import { Icon } from "./Icon";

const MOBILE = 768;

/**
 * Terme du métier cliquable : ouvre une explication courte avec un exemple,
 * sans quitter l'écran. Sur mobile l'explication devient une feuille en bas d'écran.
 */
export function Term({ id, children }: { id: string; children?: React.ReactNode }) {
  const entry = GLOSSARY_BY_ID[id];
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const uid = useId();

  useLayoutEffect(() => {
    if (!open || !pop.current || !btn.current) return;
    const el = pop.current;
    if (window.innerWidth < MOBILE) { el.style.left = el.style.top = ""; return; }
    const r = btn.current.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight, m = 12;
    const left = Math.max(m, Math.min(r.left, window.innerWidth - w - m));
    const below = r.bottom + 8, above = r.top - 8 - h;
    el.style.left = left + "px";
    el.style.top = (below + h > window.innerHeight - m && above > m ? above : below) + "px";
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { close(); btn.current?.focus(); } };
    const onScroll = () => { if (window.innerWidth >= MOBILE) close(); };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  if (!entry) return <>{children}</>;
  return (
    <>
      <button ref={btn} type="button" className="term" aria-expanded={open} aria-controls={uid} onClick={() => setOpen((o) => !o)}>
        <span className="term-text">{children ?? entry.term}</span>
        <span className="term-mark" aria-hidden="true"><Icon name="help" size={13} /></span>
        <span className="visually-hidden"> : voir la définition</span>
      </button>
      {open && (
        <>
          <div className="term-backdrop" aria-hidden="true" />
          <div ref={pop} id={uid} className="term-pop" role="dialog" aria-label={`Définition : ${entry.term}`}>
            <div className="term-pop-head">
              <strong>{entry.term}</strong>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setOpen(false); btn.current?.focus(); }} aria-label="Fermer la définition"><Icon name="cross" /></button>
            </div>
            <p className="term-plain">{entry.plain}</p>
            {entry.example && <p className="term-example"><span>Exemple</span>{entry.example}</p>}
            <Link className="term-more" href={`/glossaire#${entry.id}`} onClick={() => setOpen(false)}>Voir dans le glossaire <Icon name="arrow" size={14} /></Link>
          </div>
        </>
      )}
    </>
  );
}
