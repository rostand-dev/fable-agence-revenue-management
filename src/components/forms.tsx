"use client";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Icon } from "./Icon";

export type FormState = { error?: string; ok?: string } | null;
type ServerAction = (prev: FormState, fd: FormData) => Promise<FormState>;

export function Submit({ children, className = "btn btn-primary", icon, pendingLabel }: { children: React.ReactNode; className?: string; icon?: string; pendingLabel?: string }) {
  const { pending } = useFormStatus();
  return <button type="submit" className={className} disabled={pending} aria-disabled={pending}>{icon && <Icon name={pending ? "spin" : icon} />}{pending ? pendingLabel ?? "En cours…" : children}</button>;
}

/** Formulaire relié à une action serveur : l'erreur revient près du formulaire, jamais en alerte de navigateur. */
export function ActionForm({ action, children, hidden, style, className }: { action: ServerAction; children: React.ReactNode; hidden?: Record<string, string | number>; style?: React.CSSProperties; className?: string }) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} style={style} className={className}>
      {hidden && Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {children}
      {state?.error && <div className="banner banner-attention" role="alert" style={{ marginTop: 12 }}><Icon name="alert" /><div><p className="banner-title">Action refusée</p><p className="banner-body">{state.error}</p></div></div>}
      {state?.ok && <div className="banner banner-sain" role="status" style={{ marginTop: 12 }}><Icon name="check" /><div><p className="banner-title">{state.ok}</p></div></div>}
    </form>
  );
}
