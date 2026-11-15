"use client";
import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { resetPasswordAction, type ResetState } from "@/app/actions/auth";
import { Icon } from "@/components/Icon";

function Go() {
  const s = useFormStatus();
  return <button type="submit" className="btn btn-primary" disabled={s.pending} style={{ width: "100%", minHeight: 48 }}>{s.pending ? "Enregistrement…" : "Enregistrer le mot de passe"}</button>;
}
export function ResetForm({ token }: { token: string }) {
  const [state, formAction] = useActionState<ResetState, FormData>(resetPasswordAction, {});
  if (state.invalidLink) return <InvalidLink message={state.error} />;
  return (
    <div className="card">
      <h2>Nouveau mot de passe</h2>
      <p className="muted" style={{ margin: "0 0 18px" }}>Choisissez un mot de passe d'au moins 10 caractères. Vous serez déconnecté(e) de tous vos appareils.</p>
      <form action={formAction} className="stack" style={{ ["--gap" as any]: "16px" }} noValidate>
        <input type="hidden" name="token" value={token} />
        <div className="field"><label htmlFor="password">Nouveau mot de passe</label><input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} maxLength={128} aria-describedby="pw-help" /><span className="help" id="pw-help">Entre 10 et 128 caractères.</span></div>
        <div className="field"><label htmlFor="confirm">Confirmez le mot de passe</label><input id="confirm" name="confirm" type="password" autoComplete="new-password" required minLength={10} maxLength={128} /></div>
        {state.error && <div className="banner banner-attention" role="alert"><Icon name="alert" /><div><p className="banner-title">{state.error}</p></div></div>}
        <Go />
      </form>
    </div>
  );
}
export function InvalidLink({ message }: { message?: string }) {
  return (
    <div className="card">
      <h2>Lien non valable</h2>
      <div className="banner banner-attention" role="alert" style={{ margin: "12px 0 16px" }}><Icon name="alert" /><div><p className="banner-title">{message ?? "Ce lien n'est plus valable : il a expiré, a déjà été utilisé ou est incorrect. Demandez-en un nouveau."}</p></div></div>
      <Link className="btn btn-primary" href="/mot-de-passe-oublie" style={{ width: "100%", minHeight: 48 }}>Demander un nouveau lien</Link>
      <p className="muted" style={{ margin: "16px 0 0" }}><Link href="/connexion">Retour à la connexion</Link></p>
    </div>
  );
}
