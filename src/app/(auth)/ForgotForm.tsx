"use client";
import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import type { AuthState } from "@/app/actions/auth";
import { requestPasswordResetAction } from "@/app/actions/auth";
import { Icon } from "@/components/Icon";

function Go() {
  const s = useFormStatus();
  return <button type="submit" className="btn btn-primary" disabled={s.pending} style={{ width: "100%", minHeight: 48 }}>{s.pending ? "Envoi…" : "Recevoir le lien"}</button>;
}
export function ForgotForm() {
  const [state, formAction] = useActionState<AuthState, FormData>(requestPasswordResetAction, {});
  return (
    <div className="card">
      <h2>Mot de passe oublié</h2>
      <p className="muted" style={{ margin: "0 0 18px" }}>Indiquez l'adresse e-mail de votre compte. Nous vous envoyons un lien pour choisir un nouveau mot de passe.</p>
      {state.ok ? (
        <div className="stack" style={{ ["--gap" as any]: "16px" }}>
          <div className="banner banner-sain" role="status"><Icon name="check" /><div><p className="banner-title">Vérifiez votre boîte e-mail</p><p className="muted" style={{ margin: 0 }}>{state.ok}</p><p className="muted" style={{ margin: "8px 0 0" }}>Rien reçu ? Regardez dans vos courriers indésirables, puis réessayez dans quelques minutes.</p></div></div>
          <Link className="btn" href="/connexion" style={{ width: "100%", minHeight: 48 }}>Retour à la connexion</Link>
        </div>
      ) : (
        <form action={formAction} className="stack" style={{ ["--gap" as any]: "16px" }} noValidate>
          <div className="field"><label htmlFor="email">Adresse e-mail</label><input id="email" name="email" type="email" autoComplete="email" inputMode="email" maxLength={254} required defaultValue={state.values?.email} /></div>
          {state.error && <div className="banner banner-attention" role="alert"><Icon name="alert" /><div><p className="banner-title">{state.error}</p></div></div>}
          <Go />
        </form>
      )}
      {!state.ok && <p className="muted" style={{ margin: "16px 0 0" }}><Link href="/connexion">Retour à la connexion</Link></p>}
    </div>
  );
}
