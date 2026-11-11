"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useRef } from "react";
import { Icon, Logo } from "./Icon";

type Item = { href: string; icon: string; label: string; primary?: boolean; count?: boolean };
const GROUPS: { label: string; items: Item[] }[] = [
  { label: "Poste de travail", items: [
    { href: "/", icon: "inbox", label: "Opportunités", primary: true, count: true },
    { href: "/logements", icon: "home", label: "Logements", primary: true },
    { href: "/historique", icon: "history", label: "Historique", primary: true },
  ] },
  { label: "Agence IA", items: [
    { href: "/equipe", icon: "team", label: "Équipe", primary: true },
    { href: "/methode", icon: "book", label: "Méthode de travail" },
  ] },
  { label: "Analyse", items: [{ href: "/bilan", icon: "chart", label: "Bilan mensuel" }] },
  { label: "Configuration", items: [
    { href: "/integrations", icon: "plug", label: "Intégrations" },
    { href: "/reglages", icon: "sliders", label: "Réglages" },
  ] },
];
const FLAT = GROUPS.flatMap((g) => g.items.map((item) => ({ item, group: g.label })));
const isCurrent = (path: string, href: string) => (href === "/" ? path === "/" || path.startsWith("/dossier") : path === href || path.startsWith(href + "/"));

const NavCtx = createContext<{ open: number }>({ open: 0 });

/** Une seule source de navigation, trois présentations : colonne, rangée (tablette), barre basse + feuille (mobile). */
export function Shell({ open, children }: { open: number; children: React.ReactNode }) {
  const path = usePathname();
  const sheet = useRef<HTMLDialogElement>(null);
  const more = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // les bandes collantes se superposent : leurs hauteurs réelles sont mesurées et publiées
    const sync = () => {
      const root = document.documentElement;
      const h = (sel: string) => { const el = document.querySelector<HTMLElement>(sel); return el && getComputedStyle(el).display !== "none" ? el.offsetHeight : 0; };
      root.style.setProperty("--topbar-h", h(".topbar") + "px");
      root.style.setProperty("--nav-h", h(".navbar") + "px");
      root.style.setProperty("--crumbs-h", h(".crumbs") + "px");
      root.style.setProperty("--bottombar-h", h(".bottombar") + "px");
    };
    sync();
    window.addEventListener("resize", sync);
    const ro = new ResizeObserver(sync);
    document.querySelectorAll(".topbar, .crumbs").forEach((el) => ro.observe(el));
    return () => { window.removeEventListener("resize", sync); ro.disconnect(); };
  }, [path]);
  useEffect(() => { sheet.current?.close(); }, [path]);

  const overflowCurrent = FLAT.some((e) => !e.item.primary && isCurrent(path, e.item.href));
  return (
    <NavCtx.Provider value={{ open }}>
      <div className="app">
        <nav className="rail" aria-label="Navigation du cockpit">
          <Link className="brand" href="/" aria-label="NuitSignal — accueil"><Logo /></Link>
          {GROUPS.map((g) => (
            <div className="rail-group" key={g.label}>
              <p className="rail-label">{g.label}</p>
              <div className="rail-nav">
                {g.items.map((it) => (
                  <Link key={it.href} className="rail-link" href={it.href} aria-current={isCurrent(path, it.href) ? "page" : undefined}>
                    <span data-icon><Icon name={it.icon} /></span>{it.label}
                    {it.count && open > 0 && <span className="rail-count">{open}</span>}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="main">{children}</div>
      </div>
      <nav className="bottombar" aria-label="Navigation principale">
        {FLAT.filter((e) => e.item.primary).map(({ item }) => (
          <Link key={item.href} className="bottombar-link" href={item.href} aria-current={isCurrent(path, item.href) ? "page" : undefined}>
            <span data-icon><Icon name={item.icon} /></span><span className="bottombar-label">{item.label}</span>
            {item.count && open > 0 && <span className="bottombar-count">{open}</span>}
          </Link>
        ))}
        <button type="button" className="bottombar-link" ref={more} aria-haspopup="dialog" aria-current={overflowCurrent ? "page" : undefined} onClick={() => sheet.current?.showModal()}>
          <span data-icon><Icon name="sliders" /></span><span className="bottombar-label">Plus</span>
        </button>
      </nav>
      <dialog className="nav-sheet" ref={sheet} aria-labelledby="nav-sheet-title" onClick={(e) => { if (e.target === sheet.current) sheet.current?.close(); }} onClose={() => more.current?.focus()}>
        <div className="nav-sheet-head">
          <h2 id="nav-sheet-title">Tous les écrans</h2>
          <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: "auto" }} onClick={() => sheet.current?.close()}>Fermer</button>
        </div>
        <div className="nav-sheet-body">
          {GROUPS.map((g) => (
            <section className="nav-sheet-group" key={g.label}>
              <h3>{g.label}</h3>
              {g.items.map((it) => {
                const cur = isCurrent(path, it.href);
                return (
                  <Link key={it.href} className="nav-sheet-link" href={it.href} aria-current={cur ? "page" : undefined}>
                    <span data-icon><Icon name={it.icon} /></span><span>{it.label}</span>{cur && <span className="nav-sheet-here">écran courant</span>}
                  </Link>
                );
              })}
            </section>
          ))}
        </div>
      </dialog>
    </NavCtx.Provider>
  );
}

/** Rangée de navigation tablette, placée entre la barre de titre et le fil d'Ariane. */
export function TabletNav() {
  const path = usePathname();
  const { open } = useContext(NavCtx);
  let last: string | null = null;
  return (
    <nav className="navbar" aria-label="Navigation du cockpit">
      {FLAT.map(({ item, group }) => {
        const sep = last !== null && last !== group; last = group;
        return (
          <span key={item.href} style={{ display: "contents" }}>
            {sep && <span className="navbar-sep" aria-hidden="true" />}
            <Link className="navbar-link" href={item.href} aria-current={isCurrent(path, item.href) ? "page" : undefined}>
              <span data-icon><Icon name={item.icon} /></span><span>{item.label}</span>
              {item.count && open > 0 && <span className="rail-count">{open}</span>}
            </Link>
          </span>
        );
      })}
    </nav>
  );
}
