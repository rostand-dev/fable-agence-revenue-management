"use client";
import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import type { AuthState } from "@/app/actions/auth";
import { Icon } from "@/components/Icon";

function Go({ label, pending }: { label: string; pending: string }) {
  const s = useFormStatus();
  return <button type="submit" className="btn btn-primary" disabled={s.pending} style={{ width: "100%", minHeight: 48 }}>{s.pending ? pending : label}</button>;
}
export function AuthForm({ mode, action }: { mode: "login" | "signup"; action: (s: AuthState, fd: FormData) => Promise<AuthState> }) {
  const [state, formAction] = useActionState(action, {});
  const signup = mode === "signup";
  return (
    <div className="card">
      <h2>{signup ? "Créer votre espace" : "Se connecter"}</h2>
      <p className="muted" style={{ margin: "0 0 18px" }}>{signup ? "Deux logements de démonstration sont installés pour découvrir l'agence. Vous ajouterez les vôtres ensuite." : "Retrouvez vos opportunités et vos décisions."}</p>
      <form action={formAction} className="stack" style={{ ["--gap" as any]: "16px" }} noValidate>
        {signup && (
          <div className="field"><label htmlFor="name">Votre nom</label><input id="name" name="name" type="text" autoComplete="name" required defaultValue={state.values?.name} /></div>
        )}
        <div className="field"><label htmlFor="email">Adresse e-mail</label><input id="email" name="email" type="email" autoComplete="email" required defaultValue={state.values?.email} /></div>
        <div className="field">
          <label htmlFor="password">Mot de passe</label>
          <input id="password" name="password" type="password" autoComplete={signup ? "new-password" : "current-password"} required minLength={signup ? 10 : undefined} aria-describedby={signup ? "pw-help" : undefined} />
          {signup && <span className="help" id="pw-help">Au moins 10 caractères.</span>}
        </div>
        {state.error && <div className="banner banner-attention" role="alert"><Icon name="alert" /><div><p className="banner-title">{state.error}</p></div></div>}
        <Go label={signup ? "Créer mon espace" : "Se connecter"} pending={signup ? "Installation de la démonstration…" : "Connexion…"} />
      </form>
      <p className="muted" style={{ margin: "16px 0 0" }}>
        {signup ? <>Déjà un compte ? <Link href="/connexion">Se connecter</Link></> : <>Pas encore de compte ? <Link href="/inscription">Créer mon espace</Link></>}
      </p>
    </div>
  );
}
