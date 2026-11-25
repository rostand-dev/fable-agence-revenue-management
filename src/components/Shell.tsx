"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { createContext, Suspense, useContext, useEffect, useRef, useState } from "react";
import { Icon, Logo } from "./Icon";
import { logoutAction } from "@/app/actions/auth";
import { ancestorIds, buildNav, currentNodeId, FOLDED_NODES, propertyIdOf, type NavBadge, type NavGroup, type NavNode, type NavProperty } from "@/lib/nav";

type Counts = { open: number; alerts: number };
const NavCtx = createContext<Counts & { openSheet: (group: string, from: HTMLElement) => void }>({ open: 0, alerts: 0, openSheet: () => {} });
const STORAGE_KEY = "nuitsignal.menu.ouvert";
const alertsLabel = (n: number) => `${n} alerte${n > 1 ? "s" : ""} à traiter`;

function Count({ badge, counts, className = "rail-count" }: { badge?: NavBadge; counts: Counts; className?: string }) {
  if (badge === "open" && counts.open > 0) return <span className={className}>{counts.open}</span>;
  if (badge === "alerts" && counts.alerts > 0) return <span className={`${className} ${className}-alert`} role="img" aria-label={alertsLabel(counts.alerts)}>{counts.alerts}</span>;
  return null;
}

/** Colonne latérale : arborescence dépliable. La branche de l'écran courant s'ouvre seule ; les ouvertures manuelles sont gardées dans le navigateur. */
function RailTree({ properties, tab, counts }: { properties: NavProperty[]; tab: string | null; counts: Counts }) {
  const path = usePathname();
  const groups = buildNav(properties, propertyIdOf(path));
  const current = currentNodeId(path, tab);
  const trail = ancestorIds(groups, current);
  // sur une fiche, la branche du logement affiché montre ses sections
  const auto = new Set(current ? [...trail, current] : trail);
  const [manual, setManual] = useState<string[]>([]);
  const [closed, setClosed] = useState<string[]>([]);
  useEffect(() => {
    try { const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"); if (Array.isArray(v)) setManual(v.filter((x) => typeof x === "string")); } catch { /* stockage indisponible : le menu reste utilisable */ }
  }, []);
  // un changement d'écran rouvre sa branche, même si elle avait été repliée
  useEffect(() => { setClosed([]); }, [path, tab]);
  const isOpen = (id: string) => !closed.includes(id) && (auto.has(id) || manual.includes(id));
  const toggle = (id: string) => {
    const open = isOpen(id);
    const next = open ? manual.filter((x) => x !== id) : [...manual.filter((x) => x !== id), id];
    setManual(next);
    setClosed((c) => (open ? [...c, id] : c.filter((x) => x !== id)));
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* idem */ }
  };
  const render = (n: NavNode, level: number) => {
    const open = !!n.children && isOpen(n.id);
    const panel = `nav-${n.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const cls = `rail-link rail-level-${level}${n.action ? " rail-action" : ""}${trail.includes(n.id) ? " is-trail" : ""}`;
    const inner = <>{n.icon && <span data-icon><Icon name={n.icon} /></span>}<span className="rail-text">{n.label}</span><Count badge={n.badge} counts={counts} /></>;
    return (
      <li key={n.id}>
        <div className="rail-row">
          {n.href
            ? <Link className={cls} href={n.href} title={level > 1 ? n.label : undefined} aria-current={current === n.id ? "page" : undefined}>{inner}</Link>
            : <button type="button" className={cls} aria-expanded={open} aria-controls={panel} onClick={() => toggle(n.id)}>{inner}<span className="rail-chevron" aria-hidden="true"><Icon name="caret" /></span></button>}
          {n.href && n.children && (
            <button type="button" className="rail-toggle" aria-expanded={open} aria-controls={panel} aria-label={`Sous-menu ${n.label}`} onClick={() => toggle(n.id)}>
              <span className="rail-chevron" aria-hidden="true"><Icon name="caret" /></span>
            </button>
          )}
        </div>
        {n.children && <ul id={panel} className="rail-sub" hidden={!open}>{n.children.map((c) => render(c, level + 1))}</ul>}
      </li>
    );
  };
  return (
    <>
      {groups.map((g) => (
        <div className="rail-group" key={g.label}>
          <p className="rail-label">{g.label}</p>
          <ul className="rail-nav">{g.items.map((n) => render(n, 1))}</ul>
        </div>
      ))}
    </>
  );
}
function RailWithTab(props: { properties: NavProperty[]; counts: Counts }) {
  return <RailTree {...props} tab={useSearchParams().get("tab")} />;
}

const foldedNodes = (groups: NavGroup[]) => groups.flatMap((g) => g.items).filter((n) => FOLDED_NODES.includes(n.id));

/** Une seule source de navigation (lib/nav), trois présentations : colonne, rangée (tablette), barre basse + feuille (mobile). */
export function Shell({ open, alerts = 0, properties = [], demo = false, exitHref = "/demo", children }: { open: number; alerts?: number; properties?: NavProperty[]; demo?: boolean; exitHref?: string; children: React.ReactNode }) {
  const path = usePathname();
  const sheet = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  // null : feuille fermée ; "" : tous les groupes (mobile) ; identifiant : un seul groupe (tablette)
  const [sheetGroup, setSheetGroup] = useState<string | null>(null);

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
  useEffect(() => { if (sheetGroup !== null && !sheet.current?.open) sheet.current?.showModal(); }, [sheetGroup]);
  // la feuille n'existe pas en grand écran : restée ouverte (rotation, redimensionnement), elle bloquerait la page sans être visible
  useEffect(() => {
    const large = window.matchMedia("(min-width: 1024px)");
    const onChange = () => { if (large.matches) sheet.current?.close(); };
    large.addEventListener("change", onChange);
    return () => large.removeEventListener("change", onChange);
  }, []);

  const counts = { open, alerts };
  const groups = buildNav(properties, propertyIdOf(path));
  const current = currentNodeId(path, null);
  const trail = ancestorIds(groups, current);
  // la rubrique elle-même compte aussi : l'accueil des Paramètres est une page, pas un ancêtre
  const inFolded = [current, ...trail].some((id) => !!id && FOLDED_NODES.includes(id));
  const openSheet = (group: string, from: HTMLElement) => { opener.current = from; setSheetGroup(group); };
  const close = () => sheet.current?.close();
  const bottom = [
    { href: "/portefeuille", icon: "chart", label: "Accueil", id: "tableau-de-bord" },
    { href: "/", icon: "inbox", label: "Opportunités", id: "opportunites", badge: "open" as const },
    { href: "/logements", icon: "home", label: "Logements", id: "logements" },
    { href: "/alertes", icon: "alert", label: "Alertes", id: "alertes", badge: "alerts" as const },
  ];
  const shown = foldedNodes(groups).filter((n) => !sheetGroup || n.id === sheetGroup);

  return (
    <NavCtx.Provider value={{ ...counts, openSheet }}>
      <div className="app">
        <nav className="rail" aria-label="Navigation du cockpit">
          <Link className="brand" href="/" aria-label="NuitSignal — accueil"><Logo /></Link>
          <Suspense fallback={<RailTree properties={properties} tab={null} counts={counts} />}>
            <RailWithTab properties={properties} counts={counts} />
          </Suspense>
        </nav>
        <div className="main">{children}</div>
      </div>
      <nav className="bottombar" aria-label="Navigation principale">
        {bottom.map((it) => (
          <Link key={it.id} className="bottombar-link" href={it.href} aria-current={current === it.id ? "page" : trail.includes(it.id) ? "true" : undefined}>
            <span data-icon><Icon name={it.icon} /></span><span className="bottombar-label">{it.label}</span>
            <Count badge={it.badge} counts={counts} className="bottombar-count" />
          </Link>
        ))}
        <button type="button" className="bottombar-link" aria-haspopup="dialog" aria-current={inFolded ? "true" : undefined} onClick={(e) => openSheet("", e.currentTarget)}>
          <span data-icon><Icon name="sliders" /></span><span className="bottombar-label">Plus</span>
        </button>
      </nav>
      <dialog className="nav-sheet" ref={sheet} aria-labelledby="nav-sheet-title"
        onClick={(e) => { if (e.target === sheet.current || (e.target as HTMLElement).closest("a")) close(); }}
        onClose={() => { setSheetGroup(null); opener.current?.focus(); }}>
        <div className="nav-sheet-head">
          <h2 id="nav-sheet-title">{(sheetGroup && shown[0]?.label) || "Tous les écrans"}</h2>
          <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: "auto" }} onClick={close}>Fermer</button>
        </div>
        <div className="nav-sheet-body">
          {shown.map((n) => (
            // la clé change à chaque ouverture : le groupe courant (ou demandé) est déplié, les autres repliés
            <details className="nav-sheet-group" key={`${n.id}:${sheetGroup ?? "fermee"}:${path}`} open={n.id === sheetGroup || n.id === current || trail.includes(n.id)}>
              <summary><span data-icon><Icon name={n.icon ?? "dot"} /></span><span>{n.label}</span><span className="nav-sheet-chevron" aria-hidden="true"><Icon name="caret" /></span></summary>
              {n.href && <Link className="nav-sheet-link" href={n.href} aria-current={current === n.id ? "page" : undefined}><span>Tous les {n.label.toLowerCase()}</span>{current === n.id && <span className="nav-sheet-here">écran courant</span>}</Link>}
              {n.children?.map((c) => {
                const cur = current === c.id;
                return (
                  <Link key={c.id} className="nav-sheet-link" href={c.href!} aria-current={cur ? "page" : undefined}>
                    <span>{c.label}</span>{cur && <span className="nav-sheet-here">écran courant</span>}
                  </Link>
                );
              })}
            </details>
          ))}
          {!sheetGroup && (demo ? (
            <div className="nav-sheet-logout">
              <a className="nav-sheet-link nav-sheet-logout-btn" href={exitHref}>
                <span data-icon><Icon name="logout" /></span><span>Quitter la démo</span>
              </a>
            </div>
          ) : (
            <form action={logoutAction} className="nav-sheet-logout">
              <button type="submit" className="nav-sheet-link nav-sheet-logout-btn">
                <span data-icon><Icon name="logout" /></span><span>Se déconnecter</span>
              </button>
            </form>
          ))}
        </div>
      </dialog>
    </NavCtx.Provider>
  );
}

/** Rangée de navigation tablette (premier niveau seulement), placée entre la barre de titre et le fil d'Ariane. */
export function TabletNav() {
  const path = usePathname();
  const { open, alerts, openSheet } = useContext(NavCtx);
  const groups = buildNav([], null);
  const current = currentNodeId(path, null);
  // sur une fiche logement, c'est « Logements » qui reste allumé
  const active = propertyIdOf(path) || path === "/logements/nouveau" ? "logements" : ancestorIds(groups, current)[0] ?? current;
  return (
    <nav className="navbar" aria-label="Navigation du cockpit">
      {groups.map((g, i) => (
        <span key={g.label} style={{ display: "contents" }}>
          {i > 0 && <span className="navbar-sep" aria-hidden="true" />}
          {g.items.map((n) => {
            const inner = <><span data-icon><Icon name={n.icon ?? "dot"} /></span><span>{n.label}</span><Count badge={n.badge} counts={{ open, alerts }} /></>;
            return n.href
              ? <Link key={n.id} className="navbar-link" href={n.href} aria-current={active === n.id ? (current === n.id ? "page" : "true") : undefined}>{inner}</Link>
              : <button key={n.id} type="button" className="navbar-link" aria-haspopup="dialog" aria-current={active === n.id ? "true" : undefined} onClick={(e) => openSheet(n.id, e.currentTarget)}>{inner}<span className="navbar-chevron" aria-hidden="true"><Icon name="caret" /></span></button>;
          })}
        </span>
      ))}
    </nav>
  );
}
