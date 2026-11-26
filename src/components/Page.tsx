import Link from "next/link";
import { Icon, Logo } from "./Icon";
import { TabletNav } from "./Shell";
import { logoutAction } from "@/app/actions/auth";
import { getUser } from "@/lib/auth";
import { demoReadonly, demoSignupUrl } from "@/lib/demo-mode";
import { DemoGuard } from "./DemoGuard";
import { State } from "./ui";
import { DeskOnly } from "./DeskOnly";
import { viewHref } from "@/lib/nav";
import { getViewContext } from "@/lib/view-mode";

export type Crumb = { label: string; href?: string };

/**
 * Ossature d'un écran : barre de titre, navigation tablette, fil d'Ariane, contenu limité à 1180 px.
 * En mode poche, un écran réservé à l'ordinateur (lib/nav) est remplacé par l'encart : ni `children` ni `after` ne sont rendus.
 * `essential` : contenu qui reste alors affiché au-dessus de l'encart (coupe-circuit).
 */
export async function Page({ title, sub, crumbs, right, children, after, essential }: { title: string; sub?: string; crumbs: Crumb[]; right?: React.ReactNode; children: React.ReactNode; after?: React.ReactNode; essential?: React.ReactNode }) {
  const [user, view] = await Promise.all([getUser(), getViewContext()]);
  const all: Crumb[] = [{ label: "Cockpit", href: "/" }, ...crumbs];
  const demo = demoReadonly(), signup = demoSignupUrl();
  const demoStrip = demo && (
    <div className="mode-strip" style={{ marginBottom: 20 }}>
      <State role="tech">Démo en lecture seule</State>
      <span>Vous explorez des <strong>données synthétiques</strong> : rien ne peut être modifié.</span>
      {signup && <a className="btn btn-primary btn-sm" href={signup}>Créer mon compte</a>}
    </div>
  );
  const blocked = view.blocked;
  if (blocked) return (
    <>
      <header className="topbar pk-topbar">
        <Link href={blocked.back} className="btn btn-ghost pk-back" aria-label="Retour"><Icon name="back" /></Link>
        <div>
          <p className="topbar-sub">{blocked.section ?? sub}</p>
          <p className="topbar-title">{title}</p>
        </div>
      </header>
      <TabletNav />
      <div className="content">
        {demoStrip}
        {essential}
        <DeskOnly view={{ ...view, blocked }} heading={essential ? "h2" : "h1"} />
        <p className="pk-foot pk-foot-large"><a href={viewHref("complet", view.current)}>Version complète</a></p>
      </div>
      {demo && <DemoGuard signupUrl={signup} />}
    </>
  );
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
          <Link href="/glossaire" className="btn btn-ghost btn-sm glossary-link" aria-label="Glossaire : comprendre les termes" title="Glossaire"><Icon name="glossary" /><span className="glossary-link-label">Glossaire</span></Link>
          {user && <span className="who" title={user.email}>{user.name}</span>}
          {demo ? (
            <a className="btn btn-ghost btn-sm logout-form" href={signup ?? "/demo"} aria-label="Quitter la démo" title="Quitter la démo"><Icon name="logout" /></a>
          ) : (
            <form action={logoutAction} className="inline logout-form">
              <button type="submit" className="btn btn-ghost btn-sm" aria-label="Se déconnecter"><Icon name="logout" /></button>
            </form>
          )}
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
      <div className="content">
        {demoStrip}
        {children}
        {/* bascule : sur un téléphone en version complète ; en mode poche, seulement sur un écran large, où la feuille « Plus » n'existe pas */}
        {view.mode === "complet" && view.phone && <p className="pk-foot"><a href={viewHref("poche", view.current)}>Version allégée</a></p>}
        {view.mode === "poche" && <p className="pk-foot pk-foot-large"><a href={viewHref("complet", view.current)}>Version complète</a></p>}
      </div>
      {demo && <DemoGuard signupUrl={signup} />}
      {after}
    </>
  );
}
