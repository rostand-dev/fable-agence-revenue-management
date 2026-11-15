import { esc, renderLayout } from "./layout";
import type { Rendered } from "./reset-password";

export function passwordChangedEmail(o: { appUrl: string; when: string; name?: string }): Rendered {
  const hello = o.name ? `Bonjour ${o.name},` : "Bonjour,";
  const base = o.appUrl.replace(/\/+$/, "");
  const forgot = `${base}/mot-de-passe-oublie`;
  const subject = "Votre mot de passe NuitSignal a été modifié";
  const html = renderLayout({
    appUrl: o.appUrl,
    preheader: "Votre mot de passe vient d'être modifié. Vous avez été déconnecté(e) de vos appareils.",
    heading: "Mot de passe modifié",
    paragraphs: [
      esc(hello),
      `Le mot de passe de votre espace NuitSignal a été modifié le <strong style="color:#eef1f8;">${esc(o.when)}</strong>. Par sécurité, vous avez été déconnecté(e) de tous vos appareils.`,
    ],
    button: { label: "Me connecter", url: `${base}/connexion` },
    notice: "Ce n'est pas vous ? Réinitialisez immédiatement votre mot de passe depuis la page « Mot de passe oublié » et vérifiez vos intégrations.",
    footer: "NuitSignal — votre agence de revenue management. Message automatique de sécurité.",
  });
  const text = [
    hello, "",
    `Le mot de passe de votre espace NuitSignal a été modifié le ${o.when}. Par sécurité, vous avez été déconnecté(e) de tous vos appareils.`, "",
    `Me connecter : ${base}/connexion`, "",
    `Ce n'est pas vous ? Réinitialisez immédiatement votre mot de passe : ${forgot}`,
  ].join("\n");
  return { subject, html, text };
}
