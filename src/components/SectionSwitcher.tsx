"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

export type SwitcherSection = { key: string; label: string; href: string; links: { label: string; href: string }[] };

/** Mobile et tablette : « Section : … » ouvre les six sections du logement (en grand écran, la colonne les montre déjà). */
export function SectionSwitcher({ property, sections, active, tab }: { property: string; sections: SwitcherSection[]; active: string; tab: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [opening, setOpening] = useState(0);
  const path = usePathname(), query = useSearchParams().toString();
  const here = `${path}${query ? "?" + query : ""}`;
  const current = sections.find((s) => s.key === active) ?? sections[0];
  useEffect(() => { dialog.current?.close(); }, [here]);
  useEffect(() => { if (opening && !dialog.current?.open) dialog.current?.showModal(); }, [opening]);
  // restée ouverte en passant en grand écran, la feuille invisible bloquerait la page
  useEffect(() => {
    const large = window.matchMedia("(min-width: 1024px)");
    const onChange = () => { if (large.matches) dialog.current?.close(); };
    large.addEventListener("change", onChange);
    return () => large.removeEventListener("change", onChange);
  }, []);
  const link = (href: string, label: string, isCurrent: boolean) => (
    <Link key={href} className="nav-sheet-link" href={href} aria-current={isCurrent ? "page" : undefined}>
      <span>{label}</span>{isCurrent && <span className="nav-sheet-here">écran courant</span>}
    </Link>
  );
  return (
    <div className="section-switcher">
      <button type="button" className="btn btn-ghost section-switcher-btn" aria-haspopup="dialog" onClick={() => setOpening((n) => n + 1)}>
        <span>Section : <strong>{current.label}</strong></span><span aria-hidden="true"><Icon name="caret" /></span>
      </button>
      <dialog className="nav-sheet" ref={dialog} aria-labelledby="section-sheet-title"
        onClick={(e) => { if (e.target === dialog.current || (e.target as HTMLElement).closest("a")) dialog.current?.close(); }}>
        <div className="nav-sheet-head">
          <h2 id="section-sheet-title">{property} · sections</h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => dialog.current?.close()}>Fermer</button>
        </div>
        <div className="nav-sheet-body">
          {sections.map((s) => s.links.length === 0
            ? <div className="nav-sheet-group nav-sheet-single" key={s.key}>{link(s.href, s.label, s.key === active)}</div>
            : (
              // la clé change à chaque ouverture : seule la section courante est dépliée
              <details className="nav-sheet-group" key={`${s.key}:${opening}`} open={s.key === active}>
                <summary><span>{s.label}</span><span className="nav-sheet-chevron" aria-hidden="true"><Icon name="caret" /></span></summary>
                {link(s.href, `Tout voir : ${s.label}`, s.href.endsWith(`?tab=${tab}`))}
                {s.links.map((l) => link(l.href, l.label, l.href === here))}
              </details>
            ))}
        </div>
      </dialog>
    </div>
  );
}
