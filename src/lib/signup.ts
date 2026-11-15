/** Confirmation de l'adresse e-mail à l'inscription : activée par défaut, désactivable pour un environnement de preview (SIGNUP_EMAIL_CONFIRMATION=false). */
export function signupConfirmationEnabled(raw: string | undefined = process.env.SIGNUP_EMAIL_CONFIRMATION): boolean {
  return !/^\s*(false|0|off|no|non)\s*$/i.test(raw ?? "");
}
/** Durée de validité du lien de confirmation d'inscription. */
export const SIGNUP_CONFIRM_MINUTES = 60;
