import Link from "next/link";
import { Icon, Logo } from "./Icon";
import { TabletNav } from "./Shell";
import { logoutAction } from "@/app/actions/auth";
import { getUser } from "@/lib/auth";

export type Crumb = { label: string; href?: string };

/** Ossature d'un écran : barre de titre, navigation tablette, fil d'Ariane, contenu limité à 1180 px. */
export async function Page({ title, sub, crumbs, right, children, after }: { title: string; sub?: string; crumbs: Crumb[]; right?: React.ReactNode; children: React.ReactNode; after?: React.ReactNode }) {
  const user = await getUser();
  const all: Crumb[] = [{ label: "Cockpit", href: "/" }, ...crumbs];
  return (
    <>
      <header className="topbar">
        <Link className="brand brand-compact" href="/" aria-label="NuitSignal — accueil"><Logo width={150} /></Link>
        <div>
          <p className="topbar-title">{title}</p>
          {sub && <p className="topbar-sub">{sub}</p>}
        </div>
        <div className="user-menu">
          {right}
          {user && <span className="who" title={user.email}>{user.name}</span>}
          <form action={logoutAction} className="inline">
            <button type="submit" className="btn btn-ghost btn-sm" aria-label="Se déconnecter"><Icon name="logout" /></button>
          </form>
        </div>
      </header>
      <TabletNav />
      <nav className="crumbs" aria-label="Fil d'Ariane">
        <ol>
          {all.map((c, i) => {
            const last = i === all.length - 1, root = i === 0;
            const inner = <>{root && <Icon name="home" />}{c.label}</>;
            return <li key={i}>{last ? <span className={root ? "crumb-root" : ""} aria-current="page">{inner}</span> : c.href ? <Link className={root ? "crumb-root" : ""} href={c.href}>{inner}</Link> : <span className="crumb-static">{inner}</span>}</li>;
          })}
        </ol>
      </nav>
      <div className="content">{children}</div>
      {after}
    </>
  );
}
