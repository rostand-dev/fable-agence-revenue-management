/**
 * Gabarit commun des e-mails NuitSignal. Tableaux + styles en ligne (Gmail, Outlook, Apple Mail), conçu mobile d'abord :
 * conteneur fluide (max 560 px), texte 16 px, bouton ≥ 48 px pleine largeur sur mobile, lien qui passe à la ligne.
 * Couleurs : design system NuitSignal (fond nocturne, bleu → violet).
 */
export const C = {
  bg: "#04050a", card: "#0b0e1a", line: "#1c2133", ink: "#eef1f8", quiet: "#9aa4bf", faint: "#8b94ad",
  blue: "#60a5fa", violet: "#a78bfa", blueCore: "#2563eb", violetCore: "#7c3aed", amber: "#fcd34d",
};
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
const MONO = `ui-monospace,'SF Mono',Menlo,Consolas,monospace`;

export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export type Layout = {
  appUrl: string;
  preheader: string;
  heading: string;
  /** Paragraphes en HTML déjà échappé */
  paragraphs: string[];
  button?: { label: string; url: string };
  /** Lien de secours en clair sous le bouton */
  fallbackUrl?: string;
  /** Encadré d'avertissement (texte déjà échappé) */
  notice?: string;
  footer: string;
};

export function renderLayout(l: Layout): string {
  const logo = `${l.appUrl.replace(/\/+$/, "")}/brand/nuitsignal-email.png`;
  const p = (h: string) => `<p style="margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:1.6;color:${C.quiet};">${h}</p>`;
  const button = l.button ? `
            <tr><td style="padding:8px 0 24px;">
              <a class="btn" href="${esc(l.button.url)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;box-sizing:border-box;min-height:48px;padding:14px 28px;border-radius:12px;background-color:${C.blueCore};background-image:linear-gradient(135deg,${C.blueCore},${C.violetCore});color:#ffffff;font-family:${FONT};font-size:16px;font-weight:700;line-height:20px;text-align:center;text-decoration:none;">${esc(l.button.label)}</a>
            </td></tr>` : "";
  const fallback = l.fallbackUrl ? `
            <tr><td style="padding:0 0 24px;">
              <p style="margin:0 0 8px;font-family:${FONT};font-size:14px;line-height:1.5;color:${C.faint};">Le bouton ne fonctionne pas ? Copiez ce lien dans votre navigateur :</p>
              <p style="margin:0;padding:12px 14px;border:1px solid ${C.line};border-radius:8px;background-color:#080b15;font-family:${MONO};font-size:13px;line-height:1.5;color:${C.blue};word-break:break-all;overflow-wrap:anywhere;"><a href="${esc(l.fallbackUrl)}" style="color:${C.blue};text-decoration:none;word-break:break-all;">${esc(l.fallbackUrl)}</a></p>
            </td></tr>` : "";
  const notice = l.notice ? `
            <tr><td style="padding:0 0 8px;">
              <p style="margin:0;padding:12px 14px;border:1px solid #4a3f1d;border-radius:8px;background-color:#171408;font-family:${FONT};font-size:14px;line-height:1.5;color:${C.amber};">${esc(l.notice)}</p>
            </td></tr>` : "";
  return `<!DOCTYPE html>
<html lang="fr" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<title>${esc(l.heading)}</title>
<style>
  :root { color-scheme: dark light; supported-color-schemes: dark light; }
  body { margin:0; padding:0; width:100% !important; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  table { border-collapse:collapse; }
  img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
  a { word-break:break-word; }
  @media only screen and (max-width:480px) {
    .px { padding-left:16px !important; padding-right:16px !important; }
    .card-px { padding-left:20px !important; padding-right:20px !important; }
    .h1 { font-size:24px !important; line-height:1.25 !important; }
    .btn { display:block !important; width:100% !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${C.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${C.bg};">${esc(l.preheader)}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.bg}" style="background-color:${C.bg};background-image:linear-gradient(180deg,${C.bg},#0b0e1a);">
  <tr><td align="center" class="px" style="padding:32px 32px 40px;">
    <!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;">
      <tr><td align="left" style="padding:0 0 24px;">
        <img src="${esc(logo)}" width="186" height="36" alt="NuitSignal" style="display:block;width:186px;height:auto;max-width:100%;font-family:${FONT};font-size:20px;font-weight:700;color:${C.ink};">
      </td></tr>
      <tr><td>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border-spacing:0;border:1px solid ${C.line};border-radius:16px;background-color:${C.card};overflow:hidden;">
          <tr><td height="4" style="height:4px;line-height:4px;font-size:0;background-color:${C.blueCore};background-image:linear-gradient(90deg,${C.blue},${C.violet});">&nbsp;</td></tr>
          <tr><td class="card-px" style="padding:32px 32px 28px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="padding:0 0 16px;">
                <h1 class="h1" style="margin:0;font-family:${FONT};font-size:28px;line-height:1.25;font-weight:700;letter-spacing:-0.01em;color:${C.ink};">${esc(l.heading)}</h1>
              </td></tr>
              <tr><td>${l.paragraphs.map(p).join("")}</td></tr>${button}${fallback}${notice}
            </table>
          </td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:20px 8px 0;">
        <p style="margin:0;font-family:${FONT};font-size:13px;line-height:1.6;color:${C.faint};">${esc(l.footer)}</p>
      </td></tr>
    </table>
    <!--[if mso]></td></tr></table><![endif]-->
  </td></tr>
</table>
</body>
</html>`;
}
