import { esc, renderLayout } from "./layout";
import type { Rendered } from "./reset-password";

/** Envoyé quand quelqu'un s'inscrit avec une adresse déjà utilisée : le site, lui, répond de la même façon que pour une nouvelle adresse. */
export function accountExistsEmail(o: { appUrl: string; name?: string }): Rendered {
  const hello = o.name ? `Bonjour ${o.name},` : "Bonjour,";
  const base = o.appUrl.replace(/\/+$/, "");
  const subject = "Vous avez déjà un espace NuitSignal";
  const html = renderLayout({
    appUrl: o.appUrl,
    preheader: "Cette adresse est déjà associée à un espace : connectez-vous.",
    heading: "Vous avez déjà un espace",
    paragraphs: [
      esc(hello),
      "Une inscription vient d'être demandée avec cette adresse, mais elle est déjà associée à un espace NuitSignal. Aucun nouveau compte n'a été créé.",
      `Mot de passe oublié ? <a href="${esc(base)}/mot-de-passe-oublie" style="color:#60a5fa;">Réinitialisez-le ici</a>.`,
    ],
    button: { label: "Me connecter", url: `${base}/connexion` },
    notice: "Ce n'était pas vous ? Vous pouvez ignorer cet e-mail : votre compte n'a pas été modifié.",
    footer: "NuitSignal — votre agence de revenue management. Message automatique de sécurité.",
  });
  const text = [
    hello, "",
    "Une inscription vient d'être demandée avec cette adresse, mais elle est déjà associée à un espace NuitSignal. Aucun nouveau compte n'a été créé.", "",
    `Me connecter : ${base}/connexion`,
    `Mot de passe oublié : ${base}/mot-de-passe-oublie`, "",
    "Ce n'était pas vous ? Ignorez cet e-mail : votre compte n'a pas été modifié.",
  ].join("\n");
  return { subject, html, text };
}
