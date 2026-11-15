"use client";
import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { confirmSignupAction, type ConfirmState } from "@/app/actions/auth";
import { Icon } from "@/components/Icon";

function Go() {
  const s = useFormStatus();
  return <button type="submit" className="btn btn-primary" disabled={s.pending} style={{ width: "100%", minHeight: 48 }}>{s.pending ? "Installation de la démonstration…" : "Activer mon espace"}</button>;
}
export function ConfirmForm({ token }: { token: string }) {
  const [state, formAction] = useActionState<ConfirmState, FormData>(confirmSignupAction, {});
  if (state.invalidLink) return <InvalidSignupLink message={state.error} />;
  return (
    <div className="card">
      <h2>Activer votre espace</h2>
      <p className="muted" style={{ margin: "0 0 18px" }}>Votre adresse e-mail est confirmée en cliquant ci-dessous. Votre espace est créé avec deux logements de démonstration.</p>
      <form action={formAction} className="stack" style={{ ["--gap" as any]: "16px" }}>
        <input type="hidden" name="token" value={token} />
        {state.error && <div className="banner banner-attention" role="alert"><Icon name="alert" /><div><p className="banner-title">{state.error}</p></div></div>}
        <Go />
      </form>
    </div>
  );
}
export function InvalidSignupLink({ message }: { message?: string }) {
  return (
    <div className="card">
      <h2>Lien non valable</h2>
      <div className="banner banner-attention" role="alert" style={{ margin: "12px 0 16px" }}><Icon name="alert" /><div><p className="banner-title">{message ?? "Ce lien n'est plus valable : il a expiré, a déjà été utilisé ou est incorrect. Recommencez votre inscription."}</p></div></div>
      <Link className="btn btn-primary" href="/inscription" style={{ width: "100%", minHeight: 48 }}>Recommencer l'inscription</Link>
      <p className="muted" style={{ margin: "16px 0 0" }}><Link href="/connexion">Retour à la connexion</Link></p>
    </div>
  );
}
