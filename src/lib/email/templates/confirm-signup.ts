import { esc, renderLayout } from "./layout";
import type { Rendered } from "./reset-password";

export function confirmSignupEmail(o: { link: string; minutes: number; appUrl: string; name?: string }): Rendered {
  const hello = o.name ? `Bonjour ${o.name},` : "Bonjour,";
  const dur = o.minutes % 60 === 0 ? `${o.minutes / 60} heure${o.minutes >= 120 ? "s" : ""}` : `${o.minutes} minutes`;
  const subject = "Confirmez votre adresse pour activer votre espace NuitSignal";
  const html = renderLayout({
    appUrl: o.appUrl,
    preheader: `Un clic pour activer votre espace. Lien valable ${dur}.`,
    heading: "Activez votre espace NuitSignal",
    paragraphs: [
      esc(hello),
      "Merci de votre inscription. Confirmez votre adresse e-mail pour créer votre espace et découvrir l'agence avec deux logements de démonstration.",
      `Ce lien est valable <strong style="color:#eef1f8;">${dur}</strong> et ne peut être utilisé qu'une seule fois.`,
    ],
    button: { label: "Activer mon espace", url: o.link },
    fallbackUrl: o.link,
    notice: "Vous n'avez pas demandé cette inscription ? Ignorez simplement cet e-mail : aucun compte ne sera créé.",
    footer: "NuitSignal — votre agence de revenue management. Pour votre sécurité, ne transmettez jamais ce lien.",
  });
  const text = [
    hello, "",
    "Merci de votre inscription. Ouvrez ce lien pour confirmer votre adresse et créer votre espace NuitSignal :", "", o.link, "",
    `Ce lien est valable ${dur} et ne peut être utilisé qu'une seule fois.`, "",
    "Vous n'avez pas demandé cette inscription ? Ignorez cet e-mail : aucun compte ne sera créé.",
  ].join("\n");
  return { subject, html, text };
}
