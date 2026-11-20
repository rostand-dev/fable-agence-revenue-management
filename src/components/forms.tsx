"use client";
import { useActionState, useEffect, useId, useRef } from "react";
import { useFormStatus } from "react-dom";
import { Icon } from "./Icon";

/** `reauth` : l'action demande le mot de passe (session rétablie par « Rester connecté »). Le formulaire affiche alors le champ `confirmPassword`. */
export type FormState = { error?: string; ok?: string; reauth?: boolean } | null;
type ServerAction = (prev: FormState, fd: FormData) => Promise<FormState>;

export function Submit({ children, className = "btn btn-primary", icon, pendingLabel, name, value, formNoValidate }: { children: React.ReactNode; className?: string; icon?: string; pendingLabel?: string; name?: string; value?: string; formNoValidate?: boolean }) {
  const { pending } = useFormStatus();
  return <button type="submit" name={name} value={value} formNoValidate={formNoValidate} className={className} disabled={pending} aria-disabled={pending}>{icon && <Icon name={pending ? "spin" : icon} />}{pending ? pendingLabel ?? "En cours…" : children}</button>;
}

/** Formulaire relié à une action serveur : l'erreur revient près du formulaire, jamais en alerte de navigateur. */
export function ActionForm({ action, children, hidden, style, className, id }: { action: ServerAction; children: React.ReactNode; hidden?: Record<string, string | number>; style?: React.CSSProperties; className?: string; id?: string }) {
  const [state, formAction, isPending] = useActionState(action, null);
  const reauthId = useId();
  const ref = useRef<HTMLFormElement>(null), sent = useRef<FormData | null>(null);
  // React 19 vide les champs non contrôlés une fois l'action terminée, même en cas d'erreur : on remet ce que la personne avait saisi.
  const keep = (fd: FormData) => { sent.current = fd; return formAction(fd); };
  useEffect(() => {
    const fd = sent.current, form = ref.current;
    if (!state || !fd || !form) return;
    const seen: Record<string, number> = {};
    for (const el of Array.from(form.elements)) {
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) || !el.name) continue;
      const i = (seen[el.name] = (seen[el.name] ?? -1) + 1);
      const v = fd.getAll(el.name)[i];
      if (typeof v !== "string") continue;
      if (el instanceof HTMLInputElement && ["checkbox", "radio", "hidden", "file", "submit", "button"].includes(el.type)) continue;
      if (el.value !== v) el.value = v;
    }
  }, [state]);
  return (
    <form ref={ref} action={keep} style={style} className={className} id={id} data-pending={isPending ? "" : undefined} aria-busy={isPending || undefined}>
      {hidden && Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {children}
      {state?.reauth && (
        <div className="field reauth-field" style={{ marginTop: 12 }}>
          <label htmlFor={reauthId}>Confirmez votre mot de passe</label>
          <input id={reauthId} name="confirmPassword" type="password" autoComplete="current-password" required autoFocus />
          <span className="help">Votre session a été rétablie automatiquement. Par sécurité, le mot de passe est redemandé une fois pour modifier une clé API.</span>
        </div>
      )}
      {state?.error && <div className="banner banner-attention" role="alert" style={{ marginTop: 12 }}><Icon name="alert" /><div><p className="banner-title">Action refusée</p><p className="banner-body">{state.error}</p></div></div>}
      {state?.ok && <div className="banner banner-sain" role="status" style={{ marginTop: 12 }}><Icon name="check" /><div><p className="banner-title">{state.ok}</p></div></div>}
    </form>
  );
}
