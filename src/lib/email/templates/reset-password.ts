import { esc, renderLayout } from "./layout";

export type Rendered = { subject: string; html: string; text: string };

export function resetPasswordEmail(o: { link: string; minutes: number; appUrl: string; name?: string }): Rendered {
  const hello = o.name ? `Bonjour ${o.name},` : "Bonjour,";
  const subject = "Réinitialisez votre mot de passe NuitSignal";
  const dur = `${o.minutes} minutes`;
  const html = renderLayout({
    appUrl: o.appUrl,
    preheader: `Ce lien est valable ${dur} et ne peut être utilisé qu'une fois.`,
    heading: "Choisissez un nouveau mot de passe",
    paragraphs: [
      esc(hello),
      "Vous avez demandé à réinitialiser le mot de passe de votre espace NuitSignal. Cliquez sur le bouton pour en choisir un nouveau.",
      `Ce lien est valable <strong style="color:#eef1f8;">${dur}</strong> et ne peut être utilisé qu'une seule fois.`,
    ],
    button: { label: "Nouveau mot de passe", url: o.link },
    fallbackUrl: o.link,
    notice: "Vous n'êtes pas à l'origine de cette demande ? Ignorez simplement cet e-mail : votre mot de passe actuel reste inchangé.",
    footer: "NuitSignal — votre agence de revenue management. Pour votre sécurité, ne transmettez jamais ce lien. Nous ne vous demanderons jamais votre mot de passe par e-mail.",
  });
  const text = [
    hello, "",
    "Vous avez demandé à réinitialiser le mot de passe de votre espace NuitSignal.",
    "Ouvrez ce lien pour en choisir un nouveau :", "", o.link, "",
    `Ce lien est valable ${dur} et ne peut être utilisé qu'une seule fois.`, "",
    "Vous n'êtes pas à l'origine de cette demande ? Ignorez cet e-mail : votre mot de passe actuel reste inchangé.", "",
    "NuitSignal — Ne transmettez jamais ce lien. Nous ne vous demanderons jamais votre mot de passe par e-mail.",
  ].join("\n");
  return { subject, html, text };
}
