import Link from "next/link";
import { Avatar } from "./Avatar";
import { Icon, Logo } from "./Icon";
import type { StepView } from "@/lib/onboarding";

/** Ossature du parcours de création : sans menu latéral, pour ne pas en sortir par erreur. */
const fTime = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
const fDay = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", timeZone: "Europe/Paris" });
export function savedLabel(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "Pas encore enregistré";
  const d = new Date(iso), sameDay = fDay.format(d) === fDay.format(now);
  return `Enregistré automatiquement ${sameDay ? "" : "le " + fDay.format(d) + " "}à ${fTime.format(d)}`;
}

/** En-tête : marque, logement en cours, état d'enregistrement et sortie. Le bouton soumet le formulaire `funnel-form` de l'étape. */
export function FunnelHeader({ title, saved, quit }: { title: string; saved: string | null; quit: "form" | "link" }) {
  return (
    <header className="fn-top">
      <Link className="fn-brand" href="/logements" aria-label="NuitSignal — retour aux logements"><Logo width={132} /></Link>
      <span className="fn-title">{title}</span>
      <div className="fn-top-right">
        {saved && <span className="fn-saved" role="status"><span className="fn-saved-dot" aria-hidden="true" />{saved}</span>}
        {quit === "form"
          ? <button type="submit" form="funnel-form" name="intent" value="quit" formNoValidate className="btn btn-ghost btn-sm"><Icon name="clock" />Enregistrer et quitter</button>
          : <Link href="/logements" className="btn btn-ghost btn-sm"><Icon name="back" />Quitter</Link>}
      </div>
    </header>
  );
}

const STATE_TEXT = { done: "Terminée", skipped: "À faire plus tard", current: "En cours", todo: "À venir" } as const;

/** Frise des six étapes ; sur mobile, une ligne « Étape X sur 6 » et une barre de progression, la liste se déplie. */
export function FunnelStepper({ steps, href }: { steps: StepView[]; href: (k: string) => string }) {
  const cur = steps.find((s) => s.status === "current")!;
  const item = (s: StepView) => {
    const inner = <><span className="fn-num" aria-hidden="true">{s.status === "done" ? <Icon name="check" /> : s.index}</span><b>{s.label}</b><span className="fn-state">{STATE_TEXT[s.status]}</span></>;
    const cls = `fn-st is-${s.status}`;
    return <li key={s.key}>{s.reachable && s.status !== "current" ? <Link className={cls} href={href(s.key)} aria-label={`Étape ${s.index} : ${s.label} (${STATE_TEXT[s.status]})`}>{inner}</Link> : <span className={cls} aria-current={s.status === "current" ? "step" : undefined}>{inner}</span>}</li>;
  };
  return (
    <nav aria-label="Étapes de création du logement" className="fn-steps">
      <ol className="fn-stepper">{steps.map(item)}</ol>
      <div className="fn-mstep">
        <div className="fn-mstep-row"><span>Étape {cur.index} sur {steps.length} · <strong>{cur.label}</strong></span></div>
        <div className="fn-bar" role="progressbar" aria-valuemin={1} aria-valuemax={steps.length} aria-valuenow={cur.index} aria-label="Progression"><i style={{ width: `${Math.round((cur.index / steps.length) * 100)}%` }} /></div>
        <details className="fn-mlist"><summary>Toutes les étapes</summary><ol className="fn-stepper is-list">{steps.map(item)}</ol></details>
      </div>
    </nav>
  );
}

/** Une parole de la chargée d'onboarding. */
export function Say({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="fn-say">
      <Avatar agent="onboarding" size={44} />
      <div className="talk-bubble" style={{ maxWidth: "none" }}><span className="talk-who" style={{ display: "block", marginBottom: 4 }}>{name} · chargée d'onboarding</span>{children}</div>
    </div>
  );
}
