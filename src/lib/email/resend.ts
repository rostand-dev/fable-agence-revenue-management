/** Envoi d'e-mails via l'API REST de Resend (fetch, aucune dépendance). Clé et expéditeur en variables d'environnement. */
export type Mail = { to: string; subject: string; html: string; text: string; idempotencyKey?: string };

export function emailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY && !!process.env.EMAIL_FROM;
}

/** Retourne true si Resend a accepté le message. Ne lève jamais d'exception et ne journalise jamais le contenu en production. */
export async function sendEmail(m: Mail): Promise<boolean> {
  if (!emailConfigured()) {
    if (process.env.NODE_ENV !== "production") console.log(`[e-mail non envoyé : RESEND_API_KEY/EMAIL_FROM absents] à ${m.to} — ${m.subject}\n${m.text}`);
    else console.error("[e-mail] RESEND_API_KEY ou EMAIL_FROM manquant : message non envoyé");
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        ...(m.idempotencyKey ? { "Idempotency-Key": m.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM,
        to: [m.to],
        subject: m.subject,
        html: m.html,
        text: m.text,
        ...(process.env.EMAIL_REPLY_TO ? { reply_to: process.env.EMAIL_REPLY_TO } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) { console.error(`[e-mail] Resend a refusé l'envoi (HTTP ${res.status})`); return false; }
    return true;
  } catch (e) {
    console.error("[e-mail] envoi en échec", e instanceof Error ? e.message : "erreur inconnue");
    return false;
  }
}
